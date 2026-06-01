import process from 'node:process';
import { existsSync } from 'node:fs';
import express from 'express';
import cors from 'cors';
import YahooFinance from 'yahoo-finance2';
import { analyzeCharts } from '../api/_analyze.js';

const yahooFinance = new YahooFinance();
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

let krxCache = { loadedAt: 0, items: [] };
const ohlcvCache = new Map();

function decodeEucKr(buffer) {
  try { return new TextDecoder('euc-kr').decode(buffer); }
  catch { return new TextDecoder('utf-8').decode(buffer); }
}

async function loadKrxList() {
  const now = Date.now();
  if (now - krxCache.loadedAt < 1000 * 60 * 60 * 6 && krxCache.items.length) return krxCache.items;
  try {
    const res = await fetch('https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' },
    });
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

const INDEX_MAP = {
  KOSPI: { symbol: '^KS11', name: 'KOSPI 종합', exchange: 'KRX' },
  KOSDAQ: { symbol: '^KQ11', name: 'KOSDAQ 종합', exchange: 'KRX' },
  'S&P500': { symbol: '^GSPC', name: 'S&P 500', exchange: 'NYSE' },
  SP500: { symbol: '^GSPC', name: 'S&P 500', exchange: 'NYSE' },
  NASDAQ: { symbol: '^IXIC', name: 'NASDAQ 종합', exchange: 'NASDAQ' },
  DOW: { symbol: '^DJI', name: 'Dow Jones', exchange: 'NYSE' },
  DOWJONES: { symbol: '^DJI', name: 'Dow Jones', exchange: 'NYSE' },
  VIX: { symbol: '^VIX', name: 'VIX 공포지수', exchange: 'CBOE' },
  NIKKEI: { symbol: '^N225', name: 'Nikkei 225', exchange: 'JPX' },
  HANGSENG: { symbol: '^HSI', name: 'Hang Seng', exchange: 'HKEX' },
};

function parseNumeric(text) {
  const s = String(text || '').replace(/,/g, '').trim();
  if (!s || /^N\/?[AD]$/i.test(s) || /^null$/i.test(s)) return null;
  const v = Number(s.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(v) ? v : null;
}

function krxMinuteOfDay(time) {
  if (typeof time !== 'number') return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(time * 1000));
  const hour = Number(parts.find(p => p.type === 'hour')?.value);
  const minute = Number(parts.find(p => p.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function filterKrxRegularMinutes(rows) {
  const open = 9 * 60;
  const auctionStart = 15 * 60 + 21;
  const auctionEnd = 15 * 60 + 29;
  const close = 15 * 60 + 30;
  return rows.filter((row) => {
    const minute = krxMinuteOfDay(row.time);
    if (minute == null) return true;
    if (minute < open || minute > close) return false;
    return minute < auctionStart || minute > auctionEnd;
  });
}

const KRX_INTRADAY_MINUTES = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '60m': 60,
  '1h': 60,
};

function kstMinuteTimeToSeconds(value) {
  const text = String(value || '');
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  return Math.floor(Date.UTC(y, mo - 1, d, h - 9, mi) / 1000);
}

function kstDateBucketToSeconds(dateText, minuteOfDay) {
  const text = String(dateText || '');
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d] = match.map(Number);
  const h = Math.floor(minuteOfDay / 60);
  const mi = minuteOfDay % 60;
  return Math.floor(Date.UTC(y, mo - 1, d, h - 9, mi) / 1000);
}

async function fetchKoreanMinuteOhlcv(code, interval, limit) {
  const intervalMinutes = KRX_INTRADAY_MINUTES[interval] || 1;
  const cacheKey = `krx-minute:${code}:${interval}:${limit}`;
  const now = Date.now();
  const cached = ohlcvCache.get(cacheKey);
  if (cached && now - cached.ts < 3000) return cached.data;

  const fetchCount = Math.min(Math.max(limit * intervalMinutes + 300, 600), 3000);
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${encodeURIComponent(code)}&timeframe=minute&count=${fetchCount}&requestType=0`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' } });
  if (!res.ok) throw new Error(`Naver minute responded ${res.status}`);

  const xml = await res.text();
  const minuteRows = [...xml.matchAll(/item data="([^"]+)"/g)]
    .map(m => m[1].split('|'))
    .map((p, idx, arr) => {
      const time = kstMinuteTimeToSeconds(p[0]);
      const close = parseNumeric(p[4]);
      const prevClose = idx > 0 ? parseNumeric(arr[idx - 1]?.[4]) : close;
      const cumulativeVolume = parseNumeric(p[5]);
      const prevCumulativeVolume = idx > 0 ? parseNumeric(arr[idx - 1]?.[5]) : null;
      const volume = Number.isFinite(cumulativeVolume) && Number.isFinite(prevCumulativeVolume)
        ? Math.max(0, cumulativeVolume - prevCumulativeVolume)
        : cumulativeVolume;
      if (time == null || close == null) return null;
      const open = parseNumeric(p[1]) ?? prevClose ?? close;
      const high = parseNumeric(p[2]) ?? Math.max(open, close);
      const low = parseNumeric(p[3]) ?? Math.min(open, close);
      return { time, open, high, low, close, volume };
    })
    .filter(Boolean);

  const regularRows = filterKrxRegularMinutes(minuteRows);
  if (intervalMinutes === 1) {
    const data = regularRows.slice(-limit);
    ohlcvCache.set(cacheKey, { ts: now, data });
    return data;
  }

  const buckets = new Map();
  const openMinute = 9 * 60;
  regularRows.forEach((row) => {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(row.time * 1000)).replaceAll('-', '');
    const minute = krxMinuteOfDay(row.time);
    if (minute == null) return;
    const bucketMinute = openMinute + Math.floor((minute - openMinute) / intervalMinutes) * intervalMinutes;
    const bucketTime = kstDateBucketToSeconds(date, bucketMinute);
    if (bucketTime == null) return;
    const current = buckets.get(bucketTime);
    if (!current) {
      buckets.set(bucketTime, { time: bucketTime, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume });
      return;
    }
    current.high = Math.max(current.high, row.high);
    current.low = Math.min(current.low, row.low);
    current.close = row.close;
    current.volume = (Number(current.volume) || 0) + (Number(row.volume) || 0);
  });

  const data = [...buckets.values()].sort((a, b) => a.time - b.time).slice(-limit);
  ohlcvCache.set(cacheKey, { ts: now, data });
  return data;
}

async function fetchUsOhlcv(symbol, interval, limit) {
  const cacheKey = `${symbol}:${interval}:${limit}`;
  const now = Date.now();
  const cached = ohlcvCache.get(cacheKey);
  const ttl = interval === 'day' || KRX_INTRADAY_MINUTES[interval] ? 3000 : ['week', 'month'].includes(interval) ? 3600000 : 300000;
  if (cached && now - cached.ts < ttl) return cached.data;

  const intervalMap = {
    '1m': '1m', '3m': '5m', '5m': '5m', '10m': '10m',
    '15m': '15m', '30m': '30m', '60m': '1h', '1h': '1h',
    day: '1d', week: '1wk', month: '1mo',
  };
  const yInterval = intervalMap[interval] || '1d';
  const daysPerBar = { '1m': 1 / 390, '3m': 5 / 390, '5m': 5 / 390, '15m': 15 / 390, '30m': 0.1, '60m': 0.2, '1h': 0.2, day: 1, week: 7, month: 30 };
  const daysPer = daysPerBar[interval] || 1;
  const daysBack = Math.ceil(limit * daysPer * 2.5) + 2;
  const maxDays = { '1m': 7, '3m': 14, '5m': 59, '15m': 59, '30m': 59, '60m': 59, '1h': 59 };
  const actualDays = Math.min(daysBack, maxDays[interval] || daysBack);
  const period1 = new Date(Date.now() - actualDays * 24 * 3600000).toISOString().slice(0, 10);
  const fallbackIntervalFor = (value) => value === '1m' ? '5m'
    : value === '3m' ? '5m'
      : value === '5m' ? '15m'
        : value === '15m' ? '30m'
          : value === '30m' ? '60m'
            : 'day';

  let result;
  try {
    result = await yahooFinance.chart(symbol, { period1, interval: yInterval });
  } catch (e) {
    if (['1m', '3m', '5m', '15m', '30m', '60m', '1h'].includes(interval)) {
      const fallbackInterval = fallbackIntervalFor(interval);
      return fetchUsOhlcv(symbol, fallbackInterval, limit);
    }
    throw e;
  }
  const quotes = (result.quotes || [])
    .map(q => {
      const d = new Date(q.date);
      const time = ['1d', '1wk', '1mo'].includes(yInterval) ? d.toISOString().slice(0, 10) : Math.floor(d.getTime() / 1000);
      return { time, open: q.open ?? null, high: q.high ?? null, low: q.low ?? null, close: q.close ?? null, volume: q.volume ?? null };
    })
    .filter(x => x.open !== null && x.close !== null && x.high !== null && x.low !== null)
    .slice(-limit);

  if (!quotes.length && ['1m', '3m', '5m', '15m', '30m', '60m', '1h'].includes(interval)) {
    return fetchUsOhlcv(symbol, fallbackIntervalFor(interval), limit);
  }

  ohlcvCache.set(cacheKey, { ts: now, data: quotes });
  return quotes;
}

async function fetchKoreanOhlcv(code, interval, limit) {
  if (interval !== 'day') {
    const cleanCode = code.replace(/\.(KS|KQ)$/, '');
    const normalizedInterval = interval === '1h' ? '60m' : interval;
    if (KRX_INTRADAY_MINUTES[normalizedInterval]) {
      return fetchKoreanMinuteOhlcv(cleanCode, normalizedInterval, limit);
    }
    const suffix = code.endsWith('.KS') || code.endsWith('.KQ') ? code : `${code}.KS`;
    try {
      return filterKrxRegularMinutes(await fetchUsOhlcv(suffix, normalizedInterval, limit));
    } catch (e) {
      console.warn(`Intraday fetch failed for ${suffix} ${interval}:`, e.message);
      if (normalizedInterval === '5m') return filterKrxRegularMinutes(await fetchUsOhlcv(suffix, '15m', limit));
      if (normalizedInterval === '15m') return filterKrxRegularMinutes(await fetchUsOhlcv(suffix, '30m', limit));
      if (normalizedInterval === '30m') return filterKrxRegularMinutes(await fetchUsOhlcv(suffix, '60m', limit));
      return fetchUsOhlcv(suffix, 'day', limit);
    }
  }
  const fetchCount = Math.min(limit + 300, 2500);
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${encodeURIComponent(code)}&timeframe=day&count=${fetchCount}&requestType=0`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' } });
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

app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 1) return res.json([]);
    const query = q.trim().toLowerCase();
    const upperQ = q.trim().toUpperCase().replace(/\s/g, '');
    const indexMatches = Object.entries(INDEX_MAP)
      .filter(([key]) => key.includes(upperQ) || upperQ.includes(key.slice(0, 3)))
      .map(([, v]) => ({ symbol: v.symbol, name: v.name, exchange: v.exchange, type: 'INDEX' }));
    const krxList = await loadKrxList();
    const krxMatches = krxList
      .filter(x => x.name.toLowerCase().includes(query) || x.code.includes(query))
      .slice(0, 15)
      .map(x => ({ symbol: `${x.code}.KS`, name: x.name, exchange: x.marketType === '코스닥' ? 'KOSDAQ' : 'KOSPI', type: 'KR' }));
    let usMatches = [];
    try {
      const result = await yahooFinance.search(q, { quotesCount: 10 });
      usMatches = (result.quotes || [])
        .filter(x => ['EQUITY', 'ETF', 'INDEX', 'FUTURE'].includes(x.quoteType) && !x.symbol.match(/\.(KS|KQ|T|HK|AX)$/))
        .slice(0, 10)
        .map(x => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, exchange: x.exchange || 'US', type: x.quoteType === 'INDEX' ? 'INDEX' : 'US' }));
    } catch (e) {
      console.error('Yahoo search error:', e.message);
    }
    return res.json([...indexMatches, ...krxMatches, ...usMatches]);
  } catch (e) {
    console.error('Search error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/ohlcv', async (req, res) => {
  try {
    const { symbol, interval = 'day', limit = 300 } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const lim = Math.min(Number(limit) || 300, 2000);
    let data;
    const isKorean = /^\d{6}$/.test(symbol) || symbol.endsWith('.KS') || symbol.endsWith('.KQ');
    const isIndex = symbol.startsWith('^');
    const code = symbol.replace(/\.(KS|KQ)$/, '');
    if (isIndex) data = await fetchUsOhlcv(symbol, interval, lim);
    else if (isKorean && interval === 'day') {
      data = await fetchKoreanOhlcv(code, interval, lim);
      data = data.map(x => ({ ...x, time: x.date ? x.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : x.time }));
    } else if (isKorean) data = await fetchKoreanOhlcv(code, interval, lim);
    else data = await fetchUsOhlcv(symbol, interval, lim);
    const seen = new Set();
    data = data.filter(d => { if (seen.has(d.time)) return false; seen.add(d.time); return true; }).sort((a, b) => (a.time > b.time ? 1 : -1));
    return res.json(data);
  } catch (e) {
    console.error(`OHLCV error [${req.query.symbol}]:`, e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  try {
    const result = await analyzeCharts(req.body);
    return res.json({ result });
  } catch (e) {
    console.error('Analyze error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

const distDir = new URL('../dist/', import.meta.url);
const indexHtml = new URL('../dist/index.html', import.meta.url);

if (existsSync(distDir)) {
  app.use(express.static(distDir.pathname));
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(indexHtml.pathname);
  });
}

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`✅ Backend server listening on http://localhost:${PORT}`);
  });
}

export default app;
