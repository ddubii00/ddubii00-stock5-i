import process from 'node:process';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import WebSocket from 'ws';
import nodeFetch, { Headers, Request, Response } from 'node-fetch';
import { analyzeCharts } from '../api/_analyze.js';

dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ quiet: true });

if (!globalThis.fetch) globalThis.fetch = nodeFetch;
if (!globalThis.Headers) globalThis.Headers = Headers;
if (!globalThis.Request) globalThis.Request = Request;
if (!globalThis.Response) globalThis.Response = Response;

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

let krxCache = { loadedAt: 0, items: [] };
const ohlcvCache = new Map();
const quoteCache = new Map();
let kisTokenCache = { token: '', expiresAt: 0 };
let kisApprovalCache = { key: '', expiresAt: 0 };
const REALTIME_QUOTE_TTL_MS = 250;
const KRX_MINUTE_TTL_MS = 300;
const KIS_TR = {
  DOMESTIC_STOCK: 'H0STCNT0',
  DOMESTIC_INDEX: 'H0UPCNT0',
  OVERSEAS_STOCK: 'HDFSCNT0',
};
const KIS_REALTIME_COLUMNS = {
  [KIS_TR.DOMESTIC_STOCK]: 46,
  [KIS_TR.DOMESTIC_INDEX]: 30,
  [KIS_TR.OVERSEAS_STOCK]: 26,
};
const KIS_INDEX_SYMBOLS = {
  '0001': { key: '0001', symbol: '^KS11' },
  '^KS11': { key: '0001', symbol: '^KS11' },
  KOSPI: { key: '0001', symbol: '^KS11' },
  '1001': { key: '1001', symbol: '^KQ11' },
  '^KQ11': { key: '1001', symbol: '^KQ11' },
  KOSDAQ: { key: '1001', symbol: '^KQ11' },
  '2001': { key: '2001', symbol: '^KS200' },
  '^KS200': { key: '2001', symbol: '^KS200' },
  KOSPI200: { key: '2001', symbol: '^KS200' },
};
const KIS_US_WS_EXCHANGE = {
  NAS: 'DNAS',
  NASD: 'DNAS',
  NASDAQ: 'DNAS',
  NYS: 'DNYS',
  NYSE: 'DNYS',
  AMS: 'DAMS',
  AMEX: 'DAMS',
  ASE: 'DAMS',
  BAQ: 'RBAQ',
  BAY: 'RBAY',
  BAA: 'RBAA',
};
const realtimeClients = new Map();
const realtimeSymbols = new Map();
const realtimeQuotes = new Map();
let kisRealtimeSocket = null;
let kisRealtimeConnecting = null;
let kisReconnectTimer = null;

const KRX_FALLBACK_ITEMS = [
  { name: 'SK하이닉스', code: '000660', marketType: '유가증권' },
  { name: '삼성전자', code: '005930', marketType: '유가증권' },
  { name: '한미반도체', code: '042700', marketType: '유가증권' },
  { name: '현대차', code: '005380', marketType: '유가증권' },
  { name: '기아', code: '000270', marketType: '유가증권' },
  { name: 'NAVER', code: '035420', marketType: '유가증권' },
  { name: '카카오', code: '035720', marketType: '유가증권' },
  { name: '셀트리온', code: '068270', marketType: '유가증권' },
  { name: '삼성바이오로직스', code: '207940', marketType: '유가증권' },
  { name: 'LG에너지솔루션', code: '373220', marketType: '유가증권' },
];
const KRX_SEARCH_ALIASES = {
  '000660': ['하이', '하이닉스', 'sk하이', 'sk하이닉스', '에스케이하이닉스', 'hynix'],
  '005930': ['삼전', '삼성', '삼성전자', 'samsung'],
};

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
    const merged = mergeKrxItems(items);
    krxCache = { loadedAt: now, items: merged };
    return merged;
  } catch (e) {
    console.error('KRX load failed:', e.message);
    return krxCache.items.length ? krxCache.items : KRX_FALLBACK_ITEMS;
  }
}

function mergeKrxItems(items) {
  const byCode = new Map();
  [...KRX_FALLBACK_ITEMS, ...(items || [])].forEach((item) => {
    if (item?.code) byCode.set(item.code, item);
  });
  return [...byCode.values()];
}

function normalizeSearchText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function krxSearchScore(item, query) {
  const q = normalizeSearchText(query);
  const name = normalizeSearchText(item.name);
  const code = String(item.code || '');
  const aliases = (KRX_SEARCH_ALIASES[code] || []).map(normalizeSearchText);
  if (!q) return 0;
  if (code === q) return 100;
  if (name === q) return 95;
  if (aliases.includes(q)) return 90;
  if (name.startsWith(q)) return 80;
  if (aliases.some(alias => alias.startsWith(q))) return 75;
  if (name.includes(q)) return 60;
  if (aliases.some(alias => alias.includes(q) || q.includes(alias))) return 55;
  if (code.includes(q)) return 50;
  return 0;
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

function unixTimeFromDateInput(value) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  const parsed = Date.parse(String(value || ''));
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return Math.floor((Date.now() - 365 * 24 * 3600000) / 1000);
}

async function yahooFetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`Yahoo responded ${res.status}`);
  return res.json();
}

async function yahooSearch(query, quotesCount = 10) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=${quotesCount}&newsCount=0`;
  return yahooFetchJson(url);
}

async function yahooChart(symbol, { period1, interval }) {
  const params = new URLSearchParams({
    period1: String(unixTimeFromDateInput(period1)),
    period2: String(Math.floor(Date.now() / 1000)),
    interval,
    events: 'history',
    includePrePost: 'false',
  });
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
  const payload = await yahooFetchJson(url);
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  return {
    quotes: timestamps.map((ts, index) => ({
      date: new Date(ts * 1000),
      open: quote.open?.[index] ?? null,
      high: quote.high?.[index] ?? null,
      low: quote.low?.[index] ?? null,
      close: quote.close?.[index] ?? null,
      volume: quote.volume?.[index] ?? null,
    })),
  };
}

async function yahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const payload = await yahooFetchJson(url);
  return payload?.quoteResponse?.result?.[0] || null;
}

function quoteFromValues(price, change, changePct) {
  const p = Number(price);
  let c = Number(change);
  let pct = Number(changePct);
  if (!Number.isFinite(p)) return null;

  if (
    Number.isFinite(c) &&
    Number.isFinite(pct) &&
    c !== 0 &&
    pct !== 0 &&
    Math.sign(c) !== Math.sign(pct)
  ) {
    c = Math.sign(pct) * Math.abs(c);
  }

  return {
    price: p,
    change: Number.isFinite(c) ? c : null,
    changePct: Number.isFinite(pct) ? pct : null,
  };
}

function isKoreanStockSymbol(symbol) {
  return /^\d{6}(\.(KS|KQ))?$/.test(symbol || '') || /\.(KS|KQ)$/.test(symbol || '');
}

function cleanKoreanCode(symbol) {
  return String(symbol || '').replace(/\.(KS|KQ)$/, '');
}

function quoteFromCandles(candles) {
  const valid = (candles || []).filter(candle => Number.isFinite(candle?.close));
  if (!valid.length) return null;
  const latest = valid[valid.length - 1];
  const previous = valid.slice(0, -1).reverse().find(candle => Number.isFinite(candle.close));
  const price = Number(latest.close);
  const previousClose = previous ? Number(previous.close) : null;
  const change = Number.isFinite(previousClose) ? price - previousClose : null;
  const changePct = Number.isFinite(previousClose) && previousClose !== 0 ? (change / previousClose) * 100 : null;
  return quoteFromValues(price, change, changePct);
}

function kstDateKeyFromSeconds(time) {
  if (typeof time !== 'number') return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(time * 1000)).replaceAll('-', '');
}

function quoteFromPriceAndPreviousClose(price, previousClose) {
  const p = Number(price);
  const prev = Number(previousClose);
  if (!Number.isFinite(p)) return null;
  const change = Number.isFinite(prev) ? p - prev : null;
  const changePct = Number.isFinite(prev) && prev !== 0 ? (change / prev) * 100 : null;
  return quoteFromValues(p, change, changePct);
}

function kisBaseUrl() {
  return process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443';
}

function kisWsUrl() {
  const base = process.env.KIS_WS_URL || 'ws://ops.koreainvestment.com:21000';
  return base.endsWith('/tryitout') ? base : `${base.replace(/\/$/, '')}/tryitout`;
}

function hasKisConfig() {
  return Boolean(process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET);
}

async function fetchKisAccessToken() {
  if (!hasKisConfig()) return '';
  const now = Date.now();
  if (kisTokenCache.token && kisTokenCache.expiresAt - now > 60_000) return kisTokenCache.token;

  const res = await fetch(`${kisBaseUrl()}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`KIS token responded ${res.status}`);
  const json = await res.json();
  const token = json.access_token || '';
  const expiresIn = Number(json.expires_in) || 3600;
  kisTokenCache = { token, expiresAt: now + expiresIn * 1000 };
  return token;
}

async function fetchKisApprovalKey() {
  if (!hasKisConfig()) return '';
  const now = Date.now();
  if (kisApprovalCache.key && kisApprovalCache.expiresAt - now > 60_000) return kisApprovalCache.key;

  const res = await fetch(`${kisBaseUrl()}/oauth2/Approval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: process.env.KIS_APP_KEY,
      secretkey: process.env.KIS_APP_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`KIS approval key responded ${res.status}`);
  const json = await res.json();
  const key = json.approval_key || '';
  if (!key) throw new Error('KIS approval key missing');
  kisApprovalCache = { key, expiresAt: now + 23 * 60 * 60 * 1000 };
  return key;
}

function kisHeaders(token, trId) {
  return {
    Authorization: `Bearer ${token}`,
    appkey: process.env.KIS_APP_KEY,
    appsecret: process.env.KIS_APP_SECRET,
    tr_id: trId,
    custtype: 'P',
  };
}

async function fetchKisDomesticStockQuote(symbol) {
  const token = await fetchKisAccessToken();
  if (!token) return null;
  const params = new URLSearchParams({
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_INPUT_ISCD: cleanKoreanCode(symbol),
  });
  const res = await fetch(`${kisBaseUrl()}/uapi/domestic-stock/v1/quotations/inquire-price?${params}`, {
    headers: kisHeaders(token, 'FHKST01010100'),
  });
  if (!res.ok) throw new Error(`KIS domestic quote responded ${res.status}`);
  const json = await res.json();
  const out = json.output || {};
  return quoteFromValues(
    parseNumeric(out.stck_prpr),
    parseNumeric(out.prdy_vrss),
    parseNumeric(out.prdy_ctrt)
  );
}

async function fetchKoreanStockQuote(symbol) {
  const code = cleanKoreanCode(symbol);
  const [intraday, daily] = await Promise.all([
    fetchKoreanOhlcv(code, '1m', 10).catch(() => []),
    fetchKoreanOhlcv(code, 'day', 3).catch(() => []),
  ]);
  const minuteCandles = filterKrxRegularMinutes(intraday || []);
  const latestSource = minuteCandles.length ? minuteCandles : (intraday || []);
  const latest = latestSource[latestSource.length - 1] || daily[daily.length - 1];
  const latestDate = latest?.date || kstDateKeyFromSeconds(latest?.time);
  const dailyRows = (daily || []).filter(row => Number.isFinite(row?.close));
  const previousDaily = [...dailyRows].reverse().find(row => row.date !== latestDate);
  const previousClose = previousDaily?.close ?? dailyRows[dailyRows.length - 2]?.close;
  return quoteFromPriceAndPreviousClose(latest?.close, previousClose) || quoteFromCandles(dailyRows);
}

function kisExchangeForUsSymbol(symbol) {
  const overrides = (() => {
    try { return JSON.parse(process.env.KIS_US_EXCHANGE_OVERRIDES || '{}'); }
    catch { return {}; }
  })();
  const upper = String(symbol || '').toUpperCase();
  return overrides[upper] || process.env.KIS_DEFAULT_US_EXCHANGE || 'NAS';
}

function realtimeKeyForSymbol(symbol) {
  return String(symbol || '').toUpperCase().replace(/\.(KS|KQ)$/, '');
}

function kisRealtimeTopic(symbol) {
  const raw = String(symbol || '').trim();
  const upper = raw.toUpperCase();
  const index = KIS_INDEX_SYMBOLS[upper];
  if (index) {
    return {
      kind: 'domestic-index',
      trId: KIS_TR.DOMESTIC_INDEX,
      trKey: index.key,
      appSymbol: index.symbol,
      cacheKey: realtimeKeyForSymbol(index.symbol),
    };
  }

  if (isKoreanStockSymbol(raw)) {
    const code = cleanKoreanCode(raw);
    return {
      kind: 'domestic-stock',
      trId: KIS_TR.DOMESTIC_STOCK,
      trKey: code,
      appSymbol: code,
      cacheKey: code,
    };
  }

  if (!upper.startsWith('^') && !upper.includes('=')) {
    const exchange = kisExchangeForUsSymbol(upper);
    const prefix = KIS_US_WS_EXCHANGE[String(exchange || '').toUpperCase()] || 'DNAS';
    return {
      kind: 'overseas-stock',
      trId: KIS_TR.OVERSEAS_STOCK,
      trKey: `${prefix}${upper}`,
      appSymbol: upper,
      cacheKey: upper,
    };
  }

  return null;
}

async function fetchKisOverseasStockQuote(symbol) {
  if (String(symbol || '').startsWith('^') || String(symbol || '').includes('=')) return null;
  const token = await fetchKisAccessToken();
  if (!token) return null;
  const params = new URLSearchParams({
    AUTH: '',
    EXCD: kisExchangeForUsSymbol(symbol),
    SYMB: String(symbol || '').toUpperCase(),
  });
  const res = await fetch(`${kisBaseUrl()}/uapi/overseas-price/v1/quotations/price?${params}`, {
    headers: kisHeaders(token, 'HHDFS00000300'),
  });
  if (!res.ok) throw new Error(`KIS overseas quote responded ${res.status}`);
  const json = await res.json();
  const out = json.output || {};
  const price = parseNumeric(out.last);
  const change = parseNumeric(out.diff);
  const changePct = parseNumeric(out.rate);
  return quoteFromValues(price, change, changePct);
}

async function fetchNaverIndexQuotes() {
  const cacheKey = 'naver-index-quotes';
  const now = Date.now();
  const cached = quoteCache.get(cacheKey);
  if (cached && now - cached.ts < 800) return cached.data;

  const res = await fetch('https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9', Referer: 'https://finance.naver.com/' },
  });
  if (!res.ok) throw new Error(`Naver index quote responded ${res.status}`);
  const json = await res.json();
  const data = new Map((json.datas || []).map(item => [
    item.itemCode,
    quoteFromValues(
      parseNumeric(item.closePrice),
      parseNumeric(item.compareToPreviousClosePrice),
      parseNumeric(item.fluctuationsRatio)
    ),
  ]));
  quoteCache.set(cacheKey, { ts: now, data });
  return data;
}

async function fetchRealtimeQuote(symbol) {
  const key = String(symbol || '').toUpperCase();
  const realtime = realtimeQuotes.get(realtimeKeyForSymbol(key));
  if (realtime && Date.now() - realtime.receivedAt < 10_000) return realtime.quote;

  const kisQuoteKey = `kis-quote:${symbol}`;
  const now = Date.now();
  const kisCached = quoteCache.get(kisQuoteKey);
  if (kisCached && now - kisCached.ts < REALTIME_QUOTE_TTL_MS) return kisCached.data;

  if (hasKisConfig()) {
    try {
      const kisQuote = isKoreanStockSymbol(symbol)
        ? await fetchKisDomesticStockQuote(symbol)
        : await fetchKisOverseasStockQuote(symbol);
      if (kisQuote) {
        quoteCache.set(kisQuoteKey, { ts: now, data: kisQuote });
        return kisQuote;
      }
    } catch (e) {
      console.warn(`KIS quote fallback [${symbol}]:`, e.message);
    }
  }

  if (isKoreanStockSymbol(symbol)) {
    const cacheKey = `krx-quote:${symbol}`;
    const cached = quoteCache.get(cacheKey);
    if (cached && now - cached.ts < REALTIME_QUOTE_TTL_MS) return cached.data;
    const krxQuote = await fetchKoreanStockQuote(symbol);
    if (krxQuote) {
      quoteCache.set(cacheKey, { ts: now, data: krxQuote });
      return krxQuote;
    }
  }

  if (key === '^KS11' || key === 'KOSPI') {
    return (await fetchNaverIndexQuotes()).get('KOSPI') || null;
  }
  if (key === '^KQ11' || key === 'KOSDAQ') {
    return (await fetchNaverIndexQuotes()).get('KOSDAQ') || null;
  }

  const cacheKey = `quote:${symbol}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && now - cached.ts < 3000) return cached.data;

  const q = await yahooQuote(symbol);
  if (!q) return null;
  const price = q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice;
  const previousClose = q.regularMarketPreviousClose;
  const change = q.regularMarketChange ?? (Number.isFinite(price) && Number.isFinite(previousClose) ? price - previousClose : null);
  const changePct = q.regularMarketChangePercent ?? (Number.isFinite(change) && Number.isFinite(previousClose) && previousClose !== 0 ? (change / previousClose) * 100 : null);
  const data = quoteFromValues(price, change, changePct);
  quoteCache.set(cacheKey, { ts: now, data });
  return data;
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastRealtimeQuote(symbol, quote) {
  const code = realtimeKeyForSymbol(symbol);
  const payload = { symbol: code, quote, receivedAt: Date.now() };
  realtimeQuotes.set(code, payload);

  for (const [id, client] of realtimeClients) {
    if (client.symbol !== code) continue;
    try {
      sendSse(client.res, 'quote', payload);
    } catch {
      realtimeClients.delete(id);
    }
  }
}

function signedKisValue(signCode, value) {
  const n = parseNumeric(value);
  if (!Number.isFinite(n)) return null;
  const code = String(signCode || '').trim();
  if (code === '4' || code === '5') return -Math.abs(n);
  if (code === '1' || code === '2') return Math.abs(n);
  return n;
}

function kisSubscribeMessage(approvalKey, topic, trType = '1') {
  return JSON.stringify({
    header: {
      approval_key: approvalKey,
      custtype: 'P',
      tr_type: trType,
      'content-type': 'utf-8',
    },
    body: {
      input: {
        tr_id: topic.trId,
        tr_key: topic.trKey,
      },
    },
  });
}

function subscribeKisSymbol(cacheKey) {
  const topic = realtimeSymbols.get(cacheKey);
  if (!topic || !kisRealtimeSocket || kisRealtimeSocket.readyState !== WebSocket.OPEN) return;
  fetchKisApprovalKey()
    .then(approvalKey => kisRealtimeSocket?.send(kisSubscribeMessage(approvalKey, topic, '1')))
    .catch(e => console.warn(`KIS realtime subscribe skipped [${cacheKey}]:`, e.message));
}

function unsubscribeKisSymbol(cacheKey) {
  const topic = realtimeSymbols.get(cacheKey);
  if (!topic) return;
  realtimeSymbols.delete(cacheKey);
  if (!kisRealtimeSocket || kisRealtimeSocket.readyState !== WebSocket.OPEN) return;
  fetchKisApprovalKey()
    .then(approvalKey => kisRealtimeSocket?.send(kisSubscribeMessage(approvalKey, topic, '2')))
    .catch(e => console.warn(`KIS realtime unsubscribe skipped [${cacheKey}]:`, e.message));
}

function hasRealtimeClientForSymbol(cacheKey) {
  for (const client of realtimeClients.values()) {
    if (client.symbol === cacheKey) return true;
  }
  return false;
}

function scheduleKisReconnect() {
  if (kisReconnectTimer || !realtimeSymbols.size) return;
  kisReconnectTimer = setTimeout(() => {
    kisReconnectTimer = null;
    connectKisRealtime().catch(e => console.warn('KIS realtime reconnect failed:', e.message));
  }, 2000);
}

function parseKisDomesticStockRow(row) {
  const price = parseNumeric(row[2]);
  if (!Number.isFinite(price)) return null;
  const sign = row[3];
  return {
    symbol: row[0],
    quote: {
      price,
      change: signedKisValue(sign, row[4]),
      changePct: signedKisValue(sign, row[5]),
      open: parseNumeric(row[7]),
      high: parseNumeric(row[8]),
      low: parseNumeric(row[9]),
      ask: parseNumeric(row[10]),
      bid: parseNumeric(row[11]),
      tradeVolume: parseNumeric(row[12]),
      volume: parseNumeric(row[13]),
      tradeTime: row[1],
      tradeDate: row[33],
      source: 'kis-ws',
    },
  };
}

function parseKisDomesticIndexRow(row) {
  const index = KIS_INDEX_SYMBOLS[row[0]];
  const price = parseNumeric(row[2]);
  if (!index || !Number.isFinite(price)) return null;
  const sign = row[3];
  return {
    symbol: index.symbol,
    quote: {
      price,
      change: signedKisValue(sign, row[4]),
      changePct: signedKisValue(sign, row[9]),
      open: parseNumeric(row[10]),
      high: parseNumeric(row[11]),
      low: parseNumeric(row[12]),
      tradeVolume: parseNumeric(row[7]),
      volume: parseNumeric(row[5]),
      tradeTime: row[1],
      source: 'kis-ws-index',
    },
  };
}

function parseKisOverseasStockRow(row) {
  const topic = [...realtimeSymbols.values()].find(item => item.trId === KIS_TR.OVERSEAS_STOCK && item.trKey === row[0]);
  const price = parseNumeric(row[10]);
  if (!topic || !Number.isFinite(price)) return null;
  const sign = row[11];
  return {
    symbol: topic.appSymbol,
    quote: {
      price,
      change: signedKisValue(sign, row[12]),
      changePct: signedKisValue(sign, row[13]),
      open: parseNumeric(row[7]),
      high: parseNumeric(row[8]),
      low: parseNumeric(row[9]),
      bid: parseNumeric(row[14]),
      ask: parseNumeric(row[15]),
      tradeVolume: parseNumeric(row[18]),
      volume: parseNumeric(row[19]),
      tradeTime: row[6] || row[4],
      tradeDate: row[5] || row[3],
      source: 'kis-ws-overseas',
    },
  };
}

function parseKisRealtimePacket(message) {
  const text = String(message || '');
  if (!text || text[0] !== '0') return [];
  const [encrypted, trId, countText, body] = text.split('|');
  if (encrypted !== '0' || !body) return [];

  const columnCount = KIS_REALTIME_COLUMNS[trId];
  if (!columnCount) return [];

  const count = Number(countText) || 1;
  const values = body.split('^');
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const offset = i * columnCount;
    const row = values.slice(offset, offset + columnCount);
    let parsed = null;
    if (trId === KIS_TR.DOMESTIC_STOCK) parsed = parseKisDomesticStockRow(row);
    if (trId === KIS_TR.DOMESTIC_INDEX) parsed = parseKisDomesticIndexRow(row);
    if (trId === KIS_TR.OVERSEAS_STOCK) parsed = parseKisOverseasStockRow(row);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

async function connectKisRealtime() {
  if (!hasKisConfig()) throw new Error('KIS_APP_KEY/KIS_APP_SECRET missing');
  if (kisRealtimeSocket?.readyState === WebSocket.OPEN) return kisRealtimeSocket;
  if (kisRealtimeConnecting) return kisRealtimeConnecting;

  kisRealtimeConnecting = (async () => {
    const approvalKey = await fetchKisApprovalKey();
    const socket = new WebSocket(kisWsUrl());
    kisRealtimeSocket = socket;

    socket.on('open', () => {
      console.log(`✅ KIS realtime WebSocket connected (${realtimeSymbols.size} symbols)`);
      for (const topic of realtimeSymbols.values()) {
        socket.send(kisSubscribeMessage(approvalKey, topic, '1'));
      }
    });

    socket.on('message', (data) => {
      const text = data.toString();
      if (text[0] === '{') {
        try {
          const json = JSON.parse(text);
          const msg = json?.body?.msg1;
          if (msg && !/SUBSCRIBE SUCCESS/i.test(msg)) console.warn('KIS realtime:', msg);
        } catch {
          // ignore malformed control messages
        }
        return;
      }

      for (const row of parseKisRealtimePacket(text)) {
        broadcastRealtimeQuote(row.symbol, row.quote);
      }
    });

    socket.on('close', () => {
      console.warn('KIS realtime WebSocket closed');
      if (kisRealtimeSocket === socket) kisRealtimeSocket = null;
      scheduleKisReconnect();
    });

    socket.on('error', (e) => {
      console.warn('KIS realtime WebSocket error:', e.message);
    });

    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      setTimeout(() => reject(new Error('KIS realtime WebSocket timeout')), 8000);
    });
    return socket;
  })();

  try {
    return await kisRealtimeConnecting;
  } finally {
    kisRealtimeConnecting = null;
  }
}

function registerRealtimeSymbol(symbol) {
  const topic = kisRealtimeTopic(symbol);
  if (!topic) return null;
  const wasSubscribed = realtimeSymbols.has(topic.cacheKey);
  realtimeSymbols.set(topic.cacheKey, topic);

  if (wasSubscribed) return topic;

  if (kisRealtimeSocket?.readyState === WebSocket.OPEN) {
    subscribeKisSymbol(topic.cacheKey);
    return topic;
  }

  connectKisRealtime()
    .catch(e => console.warn(`KIS realtime unavailable [${topic.cacheKey}]:`, e.message));

  return topic;
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
  if (cached && now - cached.ts < KRX_MINUTE_TTL_MS) return cached.data;

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
  const ttl = interval === 'day' ? 3000 : KRX_INTRADAY_MINUTES[interval] ? KRX_MINUTE_TTL_MS : ['week', 'month'].includes(interval) ? 3600000 : 300000;
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
    result = await yahooChart(symbol, { period1, interval: yInterval });
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
    const isKoreanQuery = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(query);
    const indexMatches = Object.entries(INDEX_MAP)
      .filter(([key]) => key.includes(upperQ) || upperQ.includes(key.slice(0, 3)))
      .map(([, v]) => ({ symbol: v.symbol, name: v.name, exchange: v.exchange, type: 'INDEX' }));
    const krxList = isKoreanQuery && !krxCache.items.length
      ? KRX_FALLBACK_ITEMS
      : await loadKrxList();
    if (isKoreanQuery && !krxCache.items.length) {
      loadKrxList().catch(() => {});
    }
    const krxMatches = krxList
      .map(x => ({ item: x, score: krxSearchScore(x, query) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, 'ko'))
      .slice(0, 15)
      .map(({ item }) => ({ symbol: `${item.code}.KS`, name: item.name, exchange: item.marketType === '코스닥' ? 'KOSDAQ' : 'KOSPI', type: 'KR' }));
    let usMatches = [];
    if (!isKoreanQuery) {
      try {
        const result = await yahooSearch(q, 10);
        usMatches = (result.quotes || [])
          .filter(x => ['EQUITY', 'ETF', 'INDEX', 'FUTURE'].includes(x.quoteType) && !x.symbol.match(/\.(KS|KQ|T|HK|AX)$/))
          .slice(0, 10)
          .map(x => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, exchange: x.exchange || 'US', type: x.quoteType === 'INDEX' ? 'INDEX' : 'US' }));
      } catch (e) {
        console.error('Yahoo search error:', e.message);
      }
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

app.get('/api/quote', async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const quote = await fetchRealtimeQuote(symbol);
    if (!quote) return res.status(404).json({ error: 'quote not found' });
    return res.json(quote);
  } catch (e) {
    console.error(`Quote error [${req.query.symbol}]:`, e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/stream/quote', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const topic = kisRealtimeTopic(symbol);
  if (!topic) return res.status(400).json({ error: 'KIS realtime does not support this symbol' });

  const id = `${topic.cacheKey}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  sendSse(res, 'ready', {
    symbol: topic.cacheKey,
    kind: topic.kind,
    trId: topic.trId,
    trKey: topic.trKey,
    kisConfigured: hasKisConfig(),
    source: hasKisConfig() ? 'kis-ws' : 'fallback',
  });

  realtimeClients.set(id, { symbol: topic.cacheKey, res });
  const latest = realtimeQuotes.get(topic.cacheKey);
  if (latest) sendSse(res, 'quote', latest);
  registerRealtimeSymbol(symbol);

  const heartbeat = setInterval(() => {
    try {
      sendSse(res, 'heartbeat', { ts: Date.now() });
    } catch {
      clearInterval(heartbeat);
      realtimeClients.delete(id);
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    realtimeClients.delete(id);
    if (!hasRealtimeClientForSymbol(topic.cacheKey)) unsubscribeKisSymbol(topic.cacheKey);
  });
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
