import process from 'node:process';
import express from 'express';
import cors from 'cors';
import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── KRX 종목 목록 캐시 ───
let krxCache = { loadedAt: 0, items: [] };

function decodeEucKr(buffer) {
  try { return new TextDecoder('euc-kr').decode(buffer); }
  catch { return new TextDecoder('utf-8').decode(buffer); }
}

async function loadKrxList() {
  const now = Date.now();
  if (now - krxCache.loadedAt < 1000 * 60 * 60 * 6 && krxCache.items.length) {
    return krxCache.items;
  }
  try {
    const res = await fetch(
      'https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' } }
    );
    if (!res.ok) throw new Error(`KRX responded ${res.status}`);
    const html = decodeEucKr(new Uint8Array(await res.arrayBuffer()));
    const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
    const items = [];
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m =>
        m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
      );
      if (cells.length < 3) continue;
      const name = cells[0];
      const marketType = String(cells[1] || '').trim();
      const rawCode = String(cells[2] || '').trim();
      const digits = rawCode.replace(/\D/g, '');
      if (!name || digits.length !== 6) continue;
      items.push({ name, code: digits, marketType });
    }
    krxCache = { loadedAt: now, items };
    return items;
  } catch (e) {
    console.error('KRX load failed:', e.message);
    return krxCache.items;
  }
}

// ─── 지수 심볼 정의 ─────────────────────────────────────
const INDEX_MAP = {
  // 한국 지수
  'KOSPI': { symbol: '^KS11',  name: 'KOSPI 종합',    exchange: 'KRX' },
  'KOSDAQ':{ symbol: '^KQ11',  name: 'KOSDAQ 종합',   exchange: 'KRX' },
  // 미국 지수
  'S&P500': { symbol: '^GSPC', name: 'S&P 500',       exchange: 'NYSE' },
  'SP500':  { symbol: '^GSPC', name: 'S&P 500',       exchange: 'NYSE' },
  'NASDAQ': { symbol: '^IXIC', name: 'NASDAQ 종합',   exchange: 'NASDAQ' },
  'DOW':    { symbol: '^DJI',  name: 'Dow Jones',      exchange: 'NYSE' },
  'DOWJONES':{ symbol:'^DJI',  name: 'Dow Jones',      exchange: 'NYSE' },
  'VIX':    { symbol: '^VIX',  name: 'VIX 공포지수',  exchange: 'CBOE' },
  'NIKKEI': { symbol: '^N225', name: 'Nikkei 225',    exchange: 'JPX' },
  'HANGSENG':{ symbol:'^HSI',  name: 'Hang Seng',     exchange: 'HKEX' },
};

// ─── 검색 ───────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 1) return res.json([]);
    const query = q.trim().toLowerCase();
    const upperQ = q.trim().toUpperCase().replace(/\s/g, '');

    // 지수 검색
    const indexMatches = Object.entries(INDEX_MAP)
      .filter(([key]) => key.includes(upperQ) || upperQ.includes(key.slice(0, 3)))
      .map(([, v]) => ({ symbol: v.symbol, name: v.name, exchange: v.exchange, type: 'INDEX' }));

    // 한국 종목 검색 (KRX)
    const krxList = await loadKrxList();
    const krxMatches = krxList
      .filter(x => x.name.toLowerCase().includes(query) || x.code.includes(query))
      .slice(0, 15)
      .map(x => ({
        symbol: x.code + '.KS',
        name: x.name,
        exchange: x.marketType === '코스닥' ? 'KOSDAQ' : 'KOSPI',
        type: 'KR',
      }));

    // 미국 종목/지수 검색 (Yahoo Finance)
    let usMatches = [];
    try {
      const result = await yahooFinance.search(q, { quotesCount: 10 });
      usMatches = (result.quotes || [])
        .filter(x => ['EQUITY','ETF','INDEX','FUTURE'].includes(x.quoteType) && !x.symbol.match(/\.(KS|KQ|T|HK|AX)$/))
        .slice(0, 10)
        .map(x => ({
          symbol: x.symbol,
          name: x.shortname || x.longname || x.symbol,
          exchange: x.exchange || 'US',
          type: x.quoteType === 'INDEX' ? 'INDEX' : 'US',
        }));
    } catch (e) {
      console.error('Yahoo search error:', e.message);
    }

    res.json([...indexMatches, ...krxMatches, ...usMatches]);
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── OHLCV ─────────────────────────────────────────────
function parseNumeric(text) {
  const s = String(text || '').replace(/,/g, '').trim();
  if (!s || /^N\/?[AD]$/i.test(s)) return null;
  const v = Number(s.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(v) ? v : null;
}

async function fetchKoreanOhlcv(code, interval, limit) {
  if (interval === 'day') {
    // 넉넉하게 요청 (최대 2500)
    const fetchCount = Math.min(limit + 300, 2500);
    const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${encodeURIComponent(code)}&timeframe=day&count=${fetchCount}&requestType=0`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' },
    });
    if (!res.ok) throw new Error(`Naver responded ${res.status}`);
    const xml = await res.text();
    const rows = [...xml.matchAll(/item data="([^"]+)"/g)]
      .map(m => m[1].split('|'))
      .map(p => ({
        date: p[0],
        open: parseNumeric(p[1]),
        high: parseNumeric(p[2]),
        low: parseNumeric(p[3]),
        close: parseNumeric(p[4]),
        volume: parseNumeric(p[5]),
      }))
      .filter(x => x.open !== null && x.close !== null);
    return rows.slice(-limit);
  }
  // 분봉: Yahoo Finance with .KS suffix
  const suffix = code.endsWith('.KS') || code.endsWith('.KQ') ? code : code + '.KS';
  return fetchUsOhlcv(suffix, interval, limit);
}

async function fetchIndexOhlcv(symbol, interval, limit) {
  return fetchUsOhlcv(symbol, interval, limit);
}

const ohlcvCache = new Map();
async function fetchUsOhlcv(symbol, interval, limit) {
  const cacheKey = `${symbol}:${interval}:${limit}`;
  const now = Date.now();
  const cached = ohlcvCache.get(cacheKey);
  // 분봉 5분, 일봉 1시간 캐시
  const ttl = ['day','week','month'].includes(interval) ? 3600000 : 300000;
  if (cached && now - cached.ts < ttl) return cached.data;

  const intervalMap = {
    '1m': '1m', '3m': '3m', '5m': '5m', '10m': '10m',
    '15m': '15m', '30m': '30m', '60m': '1h', '1h': '1h',
    'day': '1d', 'week': '1wk', 'month': '1mo',
  };
  const yInterval = intervalMap[interval] || '1d';

  // 요청 기간 = limit에 맞게 충분히 크게
  const daysPerBar = { '1m': 1/390, '3m': 3/390, '5m': 5/390, '15m': 15/390,
    '30m': 0.1, '60m': 0.2, '1h': 0.2, 'day': 1, 'week': 7, 'month': 30 };
  const daysPer = daysPerBar[interval] || 1;
  // 충분한 여유를 두어 limit보다 많이 가져옴 (주말, 공휴일 고려 ×2)
  const daysBack = Math.ceil(limit * daysPer * 2) + 60;
  const maxDays = { '1m': 7, '3m': 30, '5m': 60, '15m': 60, '30m': 90, '60m': 180, '1h': 180 };
  const actualDays = Math.min(daysBack, maxDays[interval] || daysBack);
  const period1 = new Date(Date.now() - actualDays * 24 * 3600000).toISOString().slice(0, 10);

  const result = await yahooFinance.chart(symbol, { period1, interval: yInterval });
  const quotes = (result.quotes || [])
    .map(q => {
      const d = new Date(q.date);
      const time = ['1d','1wk','1mo'].includes(yInterval)
        ? d.toISOString().slice(0, 10)
        : Math.floor(d.getTime() / 1000);
      return {
        time,
        open:   q.open   ?? null,
        high:   q.high   ?? null,
        low:    q.low    ?? null,
        close:  q.close  ?? null,
        volume: q.volume ?? null,
      };
    })
    .filter(x => x.open !== null && x.close !== null && x.high !== null && x.low !== null)
    .slice(-limit);

  ohlcvCache.set(cacheKey, { ts: now, data: quotes });
  return quotes;
}

app.get('/api/ohlcv', async (req, res) => {
  try {
    const { symbol, interval = 'day', limit = 300 } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });

    // ⑤ 최대 2000까지 허용
    const lim = Math.min(Number(limit) || 300, 2000);
    let data;

    const isKorean = /^\d{6}$/.test(symbol) || symbol.endsWith('.KS') || symbol.endsWith('.KQ');
    const isIndex  = symbol.startsWith('^');
    const code = symbol.replace(/\.(KS|KQ)$/, '');

    if (isIndex) {
      data = await fetchIndexOhlcv(symbol, interval, lim);
    } else if (isKorean && interval === 'day') {
      data = await fetchKoreanOhlcv(code, interval, lim);
      data = data.map(x => ({
        ...x,
        time: x.date
          ? x.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')
          : x.time,
      }));
    } else if (isKorean) {
      const sym = isKorean ? code + '.KS' : symbol;
      data = await fetchUsOhlcv(sym, interval, lim);
    } else {
      data = await fetchUsOhlcv(symbol, interval, lim);
    }

    // 중복 time 제거 및 정렬
    const seen = new Set();
    data = data
      .filter(d => { if (seen.has(d.time)) return false; seen.add(d.time); return true; })
      .sort((a, b) => (a.time > b.time ? 1 : -1));

    res.json(data);
  } catch (e) {
    console.error(`OHLCV error [${req.query.symbol}]:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Backend server listening on http://localhost:${PORT}`);
});
