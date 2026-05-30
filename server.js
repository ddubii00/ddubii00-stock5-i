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
  try {
    return new TextDecoder('euc-kr').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

async function loadKrxList() {
  const now = Date.now();
  if (now - krxCache.loadedAt < 1000 * 60 * 60 * 6 && krxCache.items.length) {
    return krxCache.items;
  }
  try {
    const res = await fetch(
      'https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        },
      }
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

// ─── 검색 ───
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 1) return res.json([]);

    const query = q.trim().toLowerCase();

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

    // 미국 종목 검색 (Yahoo Finance)
    let usMatches = [];
    try {
      const result = await yahooFinance.search(q, { quotesCount: 10 });
      usMatches = (result.quotes || [])
        .filter(x => (x.quoteType === 'EQUITY' || x.quoteType === 'ETF') && !x.symbol.includes('.'))
        .slice(0, 10)
        .map(x => ({
          symbol: x.symbol,
          name: x.shortname || x.longname || x.symbol,
          exchange: x.exchange || 'US',
          type: 'US',
        }));
    } catch (e) {
      console.error('Yahoo search error:', e.message);
    }

    res.json([...krxMatches, ...usMatches]);
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── OHLCV 히스토리 ───
function parseNumeric(text) {
  const s = String(text || '').replace(/,/g, '').trim();
  if (!s || /^N\/?[AD]$/i.test(s)) return null;
  const v = Number(s.replace(/[^\d.+\-]/g, ''));
  return Number.isFinite(v) ? v : null;
}

async function fetchKoreanOhlcv(code, interval, limit) {
  // Naver for daily
  if (interval === 'day') {
    const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${encodeURIComponent(code)}&timeframe=day&count=${limit + 300}&requestType=0`;
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
  // For intraday Korean stocks, use Yahoo Finance with .KS suffix
  const suffix = code.endsWith('.KS') || code.endsWith('.KQ') ? code : code + '.KS';
  return fetchUsOhlcv(suffix, interval, limit);
}

const ohlcvCache = new Map();
async function fetchUsOhlcv(symbol, interval, limit) {
  const cacheKey = `${symbol}:${interval}:${limit}`;
  const now = Date.now();
  const cached = ohlcvCache.get(cacheKey);
  // Cache 5 min for intraday, 1 hour for daily
  const ttl = interval === 'day' ? 3600000 : 300000;
  if (cached && now - cached.ts < ttl) return cached.data;

  const intervalMap = {
    '1m': '1m', '3m': '3m', '5m': '5m', '10m': '10m',
    '15m': '15m', '30m': '30m', '60m': '1h', '1h': '1h',
    'day': '1d', 'week': '1wk', 'month': '1mo',
  };
  const yInterval = intervalMap[interval] || '1d';

  // Determine period1 based on interval
  const daysBack = {
    '1m': 7, '3m': 7, '5m': 30, '10m': 30, '15m': 60,
    '30m': 60, '60m': 60, '1h': 60, 'day': 700, 'week': 1500, 'month': 3000,
  }[interval] || 365;
  const period1 = new Date(Date.now() - daysBack * 24 * 3600000).toISOString().slice(0, 10);

  const result = await yahooFinance.chart(symbol, { period1, interval: yInterval });
  const quotes = (result.quotes || [])
    .map(q => {
      const d = new Date(q.date);
      // For daily: use date string, for intraday: use unix timestamp
      const time = yInterval === '1d' || yInterval === '1wk' || yInterval === '1mo'
        ? d.toISOString().slice(0, 10)
        : Math.floor(d.getTime() / 1000);
      return {
        time,
        open: q.open ?? null,
        high: q.high ?? null,
        low: q.low ?? null,
        close: q.close ?? null,
        volume: q.volume ?? null,
      };
    })
    .filter(x => x.open !== null && x.close !== null)
    .slice(-limit);

  ohlcvCache.set(cacheKey, { ts: now, data: quotes });
  return quotes;
}

app.get('/api/ohlcv', async (req, res) => {
  try {
    const { symbol, interval = 'day', limit = 300 } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });

    const lim = Math.min(Number(limit) || 300, 1000);
    let data;

    // Detect Korean stock (6-digit code or .KS/.KQ suffix)
    const isKorean = /^\d{6}$/.test(symbol) || symbol.endsWith('.KS') || symbol.endsWith('.KQ');
    const code = symbol.replace(/\.(KS|KQ)$/, '');

    if (isKorean && interval === 'day') {
      data = await fetchKoreanOhlcv(code, interval, lim);
      // Convert Naver date format (YYYYMMDD) to YYYY-MM-DD
      data = data.map(x => ({
        ...x,
        time: x.date
          ? x.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')
          : x.time,
      }));
    } else {
      const sym = isKorean ? code + '.KS' : symbol;
      data = await fetchUsOhlcv(sym, interval, lim);
    }

    res.json(data);
  } catch (e) {
    console.error(`OHLCV error [${req.query.symbol}]:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Backend server listening on http://localhost:${PORT}`);
});
