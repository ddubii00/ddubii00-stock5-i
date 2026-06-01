import YahooFinance from 'yahoo-finance2';

export const yahooFinance = new YahooFinance();

let krxCache = { loadedAt: 0, items: [] };
const ohlcvCache = new Map();

function decodeEucKr(buffer) {
  try {
    return new TextDecoder('euc-kr').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

export async function loadKrxList() {
  const now = Date.now();
  if (now - krxCache.loadedAt < 1000 * 60 * 60 * 6 && krxCache.items.length) {
    return krxCache.items;
  }

  const res = await fetch(
    'https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13',
    { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' } }
  );

  if (!res.ok) {
    throw new Error(`KRX responded ${res.status}`);
  }

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
}

export const INDEX_MAP = {
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

export function parseNumeric(text) {
  const s = String(text || '').replace(/,/g, '').trim();
  if (!s || /^N\/?[AD]$/i.test(s)) return null;
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

export async function fetchKoreanOhlcv(code, interval, limit) {
  if (interval !== 'day') {
    const suffix = code.endsWith('.KS') || code.endsWith('.KQ') ? code : `${code}.KS`;
    const normalizedInterval = interval === '3m' ? '5m' : interval;
    try {
      return filterKrxRegularMinutes(await fetchUsOhlcv(suffix, normalizedInterval, limit));
    } catch (e) {
      console.warn(`Intraday fetch failed for ${suffix} ${interval}:`, e.message);
      if (normalizedInterval === '5m') {
        return filterKrxRegularMinutes(await fetchUsOhlcv(suffix, '15m', limit));
      }
      if (normalizedInterval === '15m') {
        return filterKrxRegularMinutes(await fetchUsOhlcv(suffix, '30m', limit));
      }
      if (normalizedInterval === '30m') {
        return filterKrxRegularMinutes(await fetchUsOhlcv(suffix, '60m', limit));
      }
      return fetchUsOhlcv(suffix, 'day', limit);
    }
  }

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

export async function fetchUsOhlcv(symbol, interval, limit) {
  const cacheKey = `${symbol}:${interval}:${limit}`;
  const now = Date.now();
  const cached = ohlcvCache.get(cacheKey);
  const ttl = interval === 'day' ? 3000 : ['week', 'month'].includes(interval) ? 3600000 : 300000;
  if (cached && now - cached.ts < ttl) return cached.data;

  const intervalMap = {
    '1m': '1m', '3m': '5m', '5m': '5m', '10m': '10m',
    '15m': '15m', '30m': '30m', '60m': '1h', '1h': '1h',
    day: '1d', week: '1wk', month: '1mo',
  };
  const yInterval = intervalMap[interval] || '1d';

  const daysPerBar = { '1m': 1 / 390, '3m': 5 / 390, '5m': 5 / 390, '15m': 15 / 390,
    '30m': 0.1, '60m': 0.2, '1h': 0.2, day: 1, week: 7, month: 30 };
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
      const fallbackLimit = limit;
      return fetchUsOhlcv(symbol, fallbackInterval, fallbackLimit);
    }
    throw e;
  }

  const quotes = (result.quotes || [])
    .map(q => {
      const d = new Date(q.date);
      const time = ['1d', '1wk', '1mo'].includes(yInterval)
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
    .filter(x => x.open !== null && x.close !== null && x.high !== null && x.low !== null)
    .slice(-limit);

  if (!quotes.length && ['1m', '3m', '5m', '15m', '30m', '60m', '1h'].includes(interval)) {
    return fetchUsOhlcv(symbol, fallbackIntervalFor(interval), limit);
  }

  ohlcvCache.set(cacheKey, { ts: now, data: quotes });
  return quotes;
}
