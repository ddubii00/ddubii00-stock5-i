import { useState, useEffect, useRef, useCallback } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  CrosshairMode,
} from 'lightweight-charts';
import { calculateMACD, calculateIchimoku, calculateMA, buildTimeMap } from '../utils/indicators';
import StockSearch from './StockSearch';

const MAIN_TFS = [
  { label: '1분',  interval: '1m' },
  { label: '3분',  interval: '3m' },
  { label: '5분',  interval: '5m' },
  { label: '15분', interval: '15m' },
  { label: '30분', interval: '30m' },
  { label: '1시간',interval: '60m' },
  { label: '일',   interval: 'day' },
  { label: '주',   interval: 'week' },
  { label: '월',   interval: 'month' },
];

const ICHI_TFS = [
  { label: '1분',  interval: '1m' },
  { label: '3분',  interval: '3m' },
  { label: '5분',  interval: '5m' },
  { label: '15분', interval: '15m' },
  { label: '30분', interval: '30m' },
  { label: '1시간',interval: '60m' },
  { label: '일',   interval: 'day' },
  { label: '주',   interval: 'week' },
  { label: '월',   interval: 'month' },
];
const DEFAULT_ICHI_TF = ICHI_TFS.find(tf => tf.interval === 'day') || ICHI_TFS[0];

const MA_PERIODS = [5, 10, 20, 60, 120];
const MA_COLORS  = ['#f59e0b', '#22c55e', '#a855f7', '#06b6d4', '#64748b'];
const INTRA_INTERVALS = ['1m','3m','5m','15m','30m','60m'];
const PRICE_SCALE_WIDTH = 92;
const ICHIMOKU_DISPLACEMENT = 26;

// ④ 마지막 종가 수평 점선 제거를 위한 헬퍼
const NO_PRICE_LINE = { priceLineVisible: false, lastValueVisible: false };

function isIntradayTf(tf) {
  return INTRA_INTERVALS.includes(tf?.interval);
}

function requestLimit(tf, baseLimit) {
  if (isIntradayTf(tf)) {
    const buffer = 1200;
    return Math.min(Math.max(baseLimit + buffer, baseLimit * 4, 240), 2000);
  }
  const buffer = 720;
  return Math.min(Math.max(baseLimit + buffer, baseLimit * 4), 2000);
}

function ichimokuRequestLimit(tf, baseLimit) {
  const minHistory = baseLimit + 52 + ICHIMOKU_DISPLACEMENT * 2;
  if (!isIntradayTf(tf)) return Math.min(Math.max(minHistory + 360, baseLimit * 5), 2000);
  return Math.min(Math.max(minHistory + 1800, baseLimit * 12), 2000);
}

function isKoreanSymbol(symbol) {
  return /^\d{6}(\.(KS|KQ))?$/.test(symbol || '') || /\.(KS|KQ)$/.test(symbol || '');
}

function isKoreanMarketSymbol(symbol) {
  return isKoreanSymbol(symbol) || symbol === '^KS11' || symbol === '^KQ11';
}

function isIndexSymbol(symbol) {
  return String(symbol || '').startsWith('^');
}

function supportsKisRealtimeStream(symbol) {
  const value = String(symbol || '').toUpperCase();
  if (isKoreanSymbol(value)) return true;
  if (value === '^KS11' || value === '^KQ11') return true;
  return Boolean(value) && !value.startsWith('^') && !value.includes('=');
}

function symbolTimeZone(symbol) {
  return isKoreanMarketSymbol(symbol) ? 'Asia/Seoul' : 'America/New_York';
}

function marketClock(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const weekday = parts.find(part => part.type === 'weekday')?.value;
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  const minute = Number(parts.find(part => part.type === 'minute')?.value);
  return { weekday, minutes: hour * 60 + minute };
}

function isRegularMarketOpen(symbol) {
  const korean = isKoreanMarketSymbol(symbol);
  const { weekday, minutes } = marketClock(symbolTimeZone(symbol));
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  if (korean) return minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
  return minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

function isMarketUpdateWindow(symbol) {
  const korean = isKoreanMarketSymbol(symbol);
  const { weekday, minutes } = marketClock(symbolTimeZone(symbol));
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  if (korean) return minutes >= 9 * 60 && minutes <= 15 * 60 + 31;
  return minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

function marketStateLabel(symbol) {
  return isRegularMarketOpen(symbol) ? '실시간' : '종가';
}

function formatNumberNoDecimals(value) {
  return Math.round(Number(value) || 0).toLocaleString('ko-KR');
}

function formatNumber(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPriceLabel(value, symbol) {
  if (isIndexSymbol(symbol)) return formatNumberNoDecimals(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1000) return `${formatNumberNoDecimals(n / 1000)}k`;
  return formatNumberNoDecimals(n);
}

function formatVolumeLabel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1000) return `${formatNumberNoDecimals(n / 1000)}k`;
  return formatNumberNoDecimals(n);
}

function formatHeaderPrice(value, symbol) {
  return formatNumber(value, isKoreanSymbol(symbol) ? 0 : 2);
}

function quoteValueDigits(symbol) {
  return isKoreanSymbol(symbol) ? 0 : 2;
}

function quoteTone(quote) {
  const change = Number(quote?.change);
  if (Number.isFinite(change) && change !== 0) return change > 0 ? 'up' : 'down';
  const pct = Number(quote?.changePct);
  if (Number.isFinite(pct) && pct !== 0) return pct > 0 ? 'up' : 'down';
  return 'flat';
}

function formatSignedValue(value, suffix = '', digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const sign = n > 0 ? '+' : '';
  return `${sign}${formatNumber(n, digits)}${suffix}`;
}

function formatSignedPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function volumeColorByChange(currentVolume, previousVolume) {
  if (!Number.isFinite(currentVolume) || !Number.isFinite(previousVolume)) {
    return '#ef5350';
  }
  return currentVolume >= previousVolume ? '#ef5350' : '#1565c0';
}

function koreanMarketMinute(time) {
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

function filterKoreanRegularIntraday(candles, symbol, tf) {
  if (!isKoreanSymbol(symbol) || !isIntradayTf(tf)) return candles;
  const open = 9 * 60;
  const auctionStart = 15 * 60 + 21;
  const auctionEnd = 15 * 60 + 29;
  const close = 15 * 60 + 30;
  return candles.filter((candle) => {
    const minute = koreanMarketMinute(candle.time);
    if (minute == null) return true;
    if (minute < open || minute > close) return false;
    return minute < auctionStart || minute > auctionEnd;
  });
}

function drawLabel(ctx, text, scale) {
  if (!text) return;
  ctx.font = `${11 * scale}px Inter, sans-serif`;
  const paddingX = 5 * scale;
  const paddingY = 3 * scale;
  const x = 10 * scale;
  const y = 5 * scale;
  const width = ctx.measureText(text).width + paddingX * 2;
  const height = 20 * scale;
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = '#6b7280';
  ctx.fillText(text, x + paddingX, y + height - paddingY - 3 * scale);
}

async function captureChartSection(section, label) {
  if (!section) throw new Error(`${label} 영역을 찾을 수 없습니다.`);
  await new Promise(resolve => requestAnimationFrame(resolve));

  const rect = section.getBoundingClientRect();
  const maxWidth = 1100;
  const scale = Math.min(window.devicePixelRatio || 1, maxWidth / Math.max(rect.width, 1), 1.5);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f7f9fc';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  [...section.querySelectorAll('canvas')].forEach(source => {
    const sourceRect = source.getBoundingClientRect();
    if (!sourceRect.width || !sourceRect.height) return;
    ctx.drawImage(
      source,
      Math.round((sourceRect.left - rect.left) * scale),
      Math.round((sourceRect.top - rect.top) * scale),
      Math.round(sourceRect.width * scale),
      Math.round(sourceRect.height * scale)
    );
  });

  drawLabel(ctx, section.querySelector('.chart-label')?.textContent?.trim() || label, scale);
  return { label, dataUrl: canvas.toDataURL('image/png') };
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('차트 이미지를 PNG로 변환하지 못했습니다.'));
    image.src = dataUrl;
  });
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 이미지를 만들지 못했습니다.'));
    }, 'image/png');
  });
}

async function buildChartSetPng(images, { symbolName, symbol, mainTf, limit, ichiTf, ichiLimit }) {
  const loadedImages = await Promise.all(images.map(async image => ({
    ...image,
    element: await loadImage(image.dataUrl),
  })));

  const padding = 28;
  const gap = 14;
  const headerHeight = 62;
  const width = Math.max(...loadedImages.map(image => image.element.width)) + padding * 2;
  const height = headerHeight
    + loadedImages.reduce((sum, image) => sum + image.element.height, 0)
    + gap * (loadedImages.length - 1)
    + padding;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f3f6fb';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#111827';
  ctx.font = '700 22px Inter, sans-serif';
  ctx.fillText(`${symbolName || symbol || '종목'} 차트 세트`, padding, 32);
  ctx.fillStyle = '#64748b';
  ctx.font = '13px Inter, sans-serif';
  ctx.fillText(`캔들/MACD: ${mainTf?.label || '-'} · 기간 ${limit} | 일목균형표: ${ichiTf?.label || '-'} · 기간 ${ichiLimit}`, padding, 53);

  let y = headerHeight;
  loadedImages.forEach(image => {
    const x = Math.round((width - image.element.width) / 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, image.element.width, image.element.height);
    ctx.drawImage(image.element, x, y);
    y += image.element.height + gap;
  });

  return canvasToPngBlob(canvas);
}

async function copyPngToClipboard(blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('현재 브라우저가 PNG 클립보드 복사를 지원하지 않습니다. Chrome/Edge의 localhost 또는 HTTPS에서 사용해주세요.');
  }
  await navigator.clipboard.write([
    new ClipboardItem({ [blob.type]: blob }),
  ]);
}

function formatAxisTime(time, zone) {
  if (typeof time === 'string') {
    const normalized = time.replace('T', ' ').replace('Z', '');
    const [datePart, timePart] = normalized.split(' ');
    if (!timePart) return datePart.replace(/-/g, '.');
    return `${datePart.replace(/-/g, '.') } ${timePart.slice(0, 5)}`;
  }
  if (typeof time === 'number') {
    const d = new Date(time * 1000);
    return d.toLocaleString('ko-KR', {
      timeZone: zone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).replace(/\. /g, '.').replace(/\.$/, '');
  }
  return String(time);
}

function timeKey(time) {
  if (typeof time === 'string') return time.slice(0, 16);
  return String(time);
}

function barSeconds(interval) {
  return {
    '1m': 60,
    '3m': 180,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '60m': 3600,
    '1h': 3600,
    day: 86400,
    week: 7 * 86400,
    month: 30 * 86400,
  }[interval] || 86400;
}

function dateStringFromUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function observedFixedHoliday(year, monthIndex, day) {
  const date = new Date(Date.UTC(year, monthIndex, day));
  const weekDay = date.getUTCDay();
  if (weekDay === 0) date.setUTCDate(date.getUTCDate() + 1);
  if (weekDay === 6) date.setUTCDate(date.getUTCDate() - 1);
  return dateStringFromUtcDate(date);
}

function nthWeekdayOfMonth(year, monthIndex, weekday, nth) {
  const date = new Date(Date.UTC(year, monthIndex, 1));
  while (date.getUTCDay() !== weekday) date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCDate(date.getUTCDate() + (nth - 1) * 7);
  return dateStringFromUtcDate(date);
}

function lastWeekdayOfMonth(year, monthIndex, weekday) {
  const date = new Date(Date.UTC(year, monthIndex + 1, 0));
  while (date.getUTCDay() !== weekday) date.setUTCDate(date.getUTCDate() - 1);
  return dateStringFromUtcDate(date);
}

function easterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month, day));
}

function marketHolidaySet(year, symbol) {
  const holidays = new Set();
  const korean = isKoreanMarketSymbol(symbol);
  if (korean) {
    [
      `${year}-01-01`, `${year}-03-01`, `${year}-05-05`, `${year}-06-06`,
      `${year}-08-15`, `${year}-10-03`, `${year}-10-09`, `${year}-12-25`,
      '2026-02-16', '2026-02-17', '2026-02-18',
      '2026-03-02',
      '2026-05-25',
      '2026-08-17',
      '2026-09-24', '2026-09-25', '2026-09-28',
      '2026-10-05',
    ].forEach(date => holidays.add(date));
    return holidays;
  }

  const goodFriday = dateStringFromUtcDate(addUtcDays(easterDate(year), -2));
  [
    observedFixedHoliday(year, 0, 1),
    nthWeekdayOfMonth(year, 0, 1, 3),
    nthWeekdayOfMonth(year, 1, 1, 3),
    goodFriday,
    lastWeekdayOfMonth(year, 4, 1),
    observedFixedHoliday(year, 5, 19),
    observedFixedHoliday(year, 6, 4),
    nthWeekdayOfMonth(year, 8, 1, 1),
    nthWeekdayOfMonth(year, 10, 4, 4),
    observedFixedHoliday(year, 11, 25),
  ].forEach(date => holidays.add(date));
  return holidays;
}

function isClosedDailyDate(dateString, symbol) {
  const date = new Date(`${dateString}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return true;
  return marketHolidaySet(date.getUTCFullYear(), symbol).has(dateString);
}

function filterDailyTradingCandles(candles, symbol, tf) {
  if (tf?.interval !== 'day') return candles;
  return candles.filter(candle => {
    const date = typeof candle.time === 'string' ? candle.time.slice(0, 10) : null;
    return date ? !isClosedDailyDate(date, symbol) : true;
  });
}

function nextTradingDateString(time, symbol) {
  const base = String(time || '').includes('T') ? new Date(time) : new Date(`${time}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return time;

  const next = new Date(base);
  do {
    next.setUTCDate(next.getUTCDate() + 1);
  } while (isClosedDailyDate(dateStringFromUtcDate(next), symbol));

  return dateStringFromUtcDate(next);
}

function nextProjectedTime(time, interval, symbol) {
  if (typeof time === 'number') {
    const next = time + barSeconds(interval);
    if (!isKoreanMarketSymbol(symbol) || !isIntradayTf({ interval })) return next;

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(next * 1000));
    const year = Number(parts.find(p => p.type === 'year')?.value);
    const month = Number(parts.find(p => p.type === 'month')?.value);
    const day = Number(parts.find(p => p.type === 'day')?.value);
    const hour = Number(parts.find(p => p.type === 'hour')?.value);
    const minute = Number(parts.find(p => p.type === 'minute')?.value);
    const minuteOfDay = hour * 60 + minute;
    const auctionStart = 15 * 60 + 21;
    const auctionEnd = 15 * 60 + 29;
    const close = 15 * 60 + 30;

    if (minuteOfDay >= auctionStart && minuteOfDay <= auctionEnd) {
      return Math.floor(Date.UTC(year, month - 1, day, 6, 30) / 1000);
    }
    if (minuteOfDay > close) {
      const nextDay = new Date(Date.UTC(year, month - 1, day + 1, 0, 0));
      while (isClosedDailyDate(dateStringFromUtcDate(nextDay), symbol)) {
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      }
      return Math.floor(Date.UTC(nextDay.getUTCFullYear(), nextDay.getUTCMonth(), nextDay.getUTCDate(), 0, 0) / 1000);
    }
    return next;
  }

  const base = String(time || '').includes('T') ? new Date(time) : new Date(`${time}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return time;
  if (interval === 'day') return nextTradingDateString(time, symbol);
  if (interval === 'week') {
    const next = new Date(base);
    next.setUTCDate(next.getUTCDate() + 7);
    return dateStringFromUtcDate(next);
  }
  if (interval === 'month') {
    const next = new Date(base);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return dateStringFromUtcDate(next);
  }
  const next = new Date(base.getTime() + barSeconds(interval) * 1000);
  return dateStringFromUtcDate(next);
}

function buildProjectedTimes(candles, tf, symbol, extraBars) {
  const times = candles.map(candle => candle.time);
  const targetLength = candles.length + extraBars + 2;
  while (times.length < targetLength && times.length > 0) {
    times.push(nextProjectedTime(times[times.length - 1], tf.interval, symbol));
  }
  return times;
}

function ichimokuSpanBValue(candles, idx, period = 52) {
  if (idx < period - 1) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let i = idx - period + 1; i <= idx; i++) {
    high = Math.max(high, candles[i].high);
    low = Math.min(low, candles[i].low);
  }
  return Number.isFinite(high) && Number.isFinite(low) ? (high + low) / 2 : null;
}

/** ② "Value is null" 방지: lightweight-charts에 null/중복/시간 없는 캔들 전달 금지 */
function normalizeCandleData(arr) {
  const rows = (arr || [])
    .filter(d =>
      d != null &&
      (typeof d.time === 'string' || Number.isFinite(d.time)) &&
      Number.isFinite(d.open) &&
      Number.isFinite(d.high) &&
      Number.isFinite(d.low) &&
      Number.isFinite(d.close)
    )
    .map(d => ({
      time: d.time,
      open: Number(d.open),
      high: Number(d.high),
      low: Number(d.low),
      close: Number(d.close),
      volume: Number.isFinite(+d.volume) ? +d.volume : null,
    }))
    .sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));

  const unique = new Map();
  rows.forEach(d => unique.set(timeKey(d.time), d));
  return [...unique.values()];
}
function safeLineData(arr) {
  return arr.filter(d => d != null && Number.isFinite(d.value));
}

function buildValueMap(arr) {
  return new Map((arr || [])
    .filter(d => d?.time != null && Number.isFinite(d.value))
    .map(d => [timeKey(d.time), d.value]));
}

function buildQuoteFromCandles(candles) {
  const valid = (candles || []).filter(candle => Number.isFinite(candle?.close));
  if (!valid.length) return null;
  const latest = valid[valid.length - 1];
  const previous = valid.slice(0, -1).reverse().find(candle => Number.isFinite(candle.close));
  const price = Number(latest.close);
  const previousClose = previous ? Number(previous.close) : null;
  const change = Number.isFinite(previousClose) ? price - previousClose : null;
  const changePct = Number.isFinite(previousClose) && previousClose !== 0 ? (change / previousClose) * 100 : null;
  return { price, change, changePct };
}

function buildQuoteFromIntradayPrice(price, dailyCandles) {
  const latestPrice = Number(price);
  if (!Number.isFinite(latestPrice)) return null;
  const valid = (dailyCandles || []).filter(candle => Number.isFinite(candle?.close));
  const previous = valid.length >= 2 ? valid[valid.length - 2] : valid[0];
  const previousClose = previous ? Number(previous.close) : null;
  const change = Number.isFinite(previousClose) ? latestPrice - previousClose : null;
  const changePct = Number.isFinite(previousClose) && previousClose !== 0 ? (change / previousClose) * 100 : null;
  return { price: latestPrice, change, changePct };
}

function kstDatePartsFromNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  return {
    year: Number(parts.find(p => p.type === 'year')?.value),
    month: Number(parts.find(p => p.type === 'month')?.value),
    day: Number(parts.find(p => p.type === 'day')?.value),
  };
}

function realtimeBarTime(quote, tf) {
  const tradeTime = String(quote?.tradeTime || '').padStart(6, '0');
  if (!/^\d{6}$/.test(tradeTime) || !isIntradayTf(tf)) return null;
  const tradeDate = String(quote?.tradeDate || '');
  const fallback = kstDatePartsFromNow();
  const year = /^\d{8}$/.test(tradeDate) ? Number(tradeDate.slice(0, 4)) : fallback.year;
  const month = /^\d{8}$/.test(tradeDate) ? Number(tradeDate.slice(4, 6)) : fallback.month;
  const day = /^\d{8}$/.test(tradeDate) ? Number(tradeDate.slice(6, 8)) : fallback.day;
  const hour = Number(tradeTime.slice(0, 2));
  const minute = Number(tradeTime.slice(2, 4));
  const second = Number(tradeTime.slice(4, 6));
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;

  const utcSeconds = Math.floor(Date.UTC(year, month - 1, day, hour - 9, minute, second) / 1000);
  const step = barSeconds(tf.interval);
  return Math.floor(utcSeconds / step) * step;
}

function renderInlineMarkdown(text, keyPrefix) {
  const parts = String(text || '').split(/(\*\*[^*]+?\*\*|\*[^*\n]+?\*)/g);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return <span key={key}>{part}</span>;
  });
}

function isMarkdownTableSeparator(line) {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function splitMarkdownTableRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
}

function renderMarkdownTable(lines, key) {
  const hasHeader = lines.length > 1 && isMarkdownTableSeparator(lines[1]);
  const header = hasHeader ? splitMarkdownTableRow(lines[0]) : null;
  const bodyLines = hasHeader ? lines.slice(2) : lines;

  return (
    <div className="md-table-wrap" key={key}>
      <table className="md-table">
        {header && (
          <thead>
            <tr>
              {header.map((cell, index) => (
                <th key={`${key}-h-${index}`}>{renderInlineMarkdown(cell, `${key}-h-${index}`)}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {bodyLines.map((line, rowIndex) => (
            <tr key={`${key}-r-${rowIndex}`}>
              {splitMarkdownTableRow(line).map((cell, cellIndex) => (
                <td key={`${key}-r-${rowIndex}-${cellIndex}`}>{renderInlineMarkdown(cell, `${key}-r-${rowIndex}-${cellIndex}`)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderMarkdown(text) {
  const lines = String(text || '').split(/\r?\n/);
  const nodes = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const key = `md-${i}-${nodes.length}`;

    if (!trimmed) {
      nodes.push(<div className="md-spacer" key={key} />);
      i += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const codeLines = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      nodes.push(<pre className="md-code" key={key}>{codeLines.join('\n')}</pre>);
      i += i < lines.length ? 1 : 0;
      continue;
    }

    if (trimmed.includes('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().includes('|')) {
        tableLines.push(lines[i]);
        i += 1;
      }
      nodes.push(renderMarkdownTable(tableLines, key));
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const HeadingTag = `h${level + 1}`;
      nodes.push(<HeadingTag className={`md-heading md-h${level}`} key={key}>{renderInlineMarkdown(heading[2], key)}</HeadingTag>);
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i += 1;
      }
      nodes.push(
        <ul className="md-list" key={key}>
          {items.map((item, index) => <li key={`${key}-li-${index}`}>{renderInlineMarkdown(item, `${key}-li-${index}`)}</li>)}
        </ul>
      );
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''));
        i += 1;
      }
      nodes.push(
        <ol className="md-list" key={key}>
          {items.map((item, index) => <li key={`${key}-li-${index}`}>{renderInlineMarkdown(item, `${key}-li-${index}`)}</li>)}
        </ol>
      );
      continue;
    }

    const paragraph = [trimmed];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3})\s+/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+[.)]\s+/.test(lines[i].trim()) &&
      !lines[i].trim().includes('|') &&
      !lines[i].trim().startsWith('```')
    ) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    nodes.push(<p className="md-p" key={key}>{renderInlineMarkdown(paragraph.join(' '), key)}</p>);
  }

  return nodes;
}

const BASE_OPTS = {
  layout: {
    background: { type: 'solid', color: '#f7f9fc' },
    textColor: '#374151',
    attributionLogo: false,
  },
  grid: { vertLines: { color: '#e6ebf3' }, horzLines: { color: '#e6ebf3' } },
  // ③ 마우스 휠 스크롤 줌 비활성화, 좌우 드래그만 허용
  handleScale: { mouseWheel: false, pinch: false },
  handleScroll: { pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false, mouseWheel: false },
  rightPriceScale: { borderColor: '#e2e5ec', minimumWidth: PRICE_SCALE_WIDTH },
  timeScale: {
    borderColor: '#e2e5ec',
    timeVisible: true,
    secondsVisible: false,
  },
};

export default function ChartColumn({ id, defaultSymbol, defaultName }) {
  // ① localStorage로 마지막 선택 종목 복원
  const storageKey = `stock5_symbol_${id}`;
  const storedRaw   = localStorage.getItem(storageKey);
  const stored      = storedRaw ? JSON.parse(storedRaw) : null;

  const [symbol,     setSymbol]     = useState(stored?.symbol || defaultSymbol || null);
  const [symbolName, setSymbolName] = useState(stored?.name   || defaultName   || '');
  const [mainTf,     setMainTf]     = useState(MAIN_TFS[6]);   // 일봉 default
  const [ichiTf,     setIchiTf]     = useState(DEFAULT_ICHI_TF); // 일봉 default
  const [limit,      setLimit]      = useState(120);
  const [limitInput, setLimitInput] = useState('120');
  const [ichiLimit,  setIchiLimit]  = useState(120);
  const [ichiLimitInput, setIchiLimitInput] = useState('120');
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const [analysisResult, setAnalysisResult] = useState('');
  const [analysisFontSize, setAnalysisFontSize] = useState(15);
  const [quote, setQuote] = useState(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [chartsReady, setChartsReady] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [mainVisible, setMainVisible] = useState({
    candle: true,
    ma5: true,
    ma10: true,
    ma20: true,
    ma60: true,
    ma120: true,
  });
  const [ichiVisible, setIchiVisible] = useState({
    candle: true,
    tenkan: true,
    kijun: true,
    chikou: true,
    spanA: true,
    spanB: true,
  });

  // DOM refs
  const priceSectionRef = useRef(null);
  const volumeSectionRef = useRef(null);
  const macdSectionRef = useRef(null);
  const ichiSectionRef = useRef(null);
  const priceRef   = useRef(null);
  const volumeRef  = useRef(null);
  const macdRef    = useRef(null);
  const ichiRef    = useRef(null);
  const tooltipRef = useRef(null);
  const ichiTooltipRef = useRef(null);
  const bgCanvasRef= useRef(null);  // ③ MACD 배경색 캔버스

  // Runtime refs
  const charts      = useRef({});
  const ser         = useRef({});
  const maMaps      = useRef([]);
  const macdDataRef = useRef([]);   // ③ MACD 데이터 저장
  const mainCandlesRef = useRef([]);
  const mainVolumeRef = useRef([]);
  const crosshairValueMapsRef = useRef({ candle: new Map(), volume: new Map(), macd: new Map() });
  const ichiValueMapsRef = useRef({
    candle: new Map(),
    kijun: new Map(),
    tenkan: new Map(),
    chikou: new Map(),
    spanA: new Map(),
    spanB: new Map(),
  });
  const symbolRef   = useRef(symbol);
  const timeZoneRef = useRef(symbolTimeZone(symbol));
  const mainViewKeyRef = useRef('');
  const ichiViewKeyRef = useRef('');
  const cloudCanvas = useRef(null);
  const syncLock    = useRef(false);
  const xhairLock   = useRef(false);
  const inited      = useRef(false);

  // ① 종목 선택 시 localStorage 저장
  const handleSelect = useCallback(({ symbol: sym, name }) => {
    setSymbol(sym);
    setSymbolName(name);
    setError('');
    localStorage.setItem(storageKey, JSON.stringify({ symbol: sym, name }));
  }, [storageKey]);

  useEffect(() => {
    symbolRef.current = symbol;
    timeZoneRef.current = symbolTimeZone(symbol);
  }, [symbol]);

  useEffect(() => {
    ser.current.candle?.applyOptions({ visible: mainVisible.candle });
    MA_PERIODS.forEach((period, idx) => {
      ser.current.maLines?.[idx]?.applyOptions({ visible: mainVisible[`ma${period}`] });
    });
  }, [mainVisible]);

  useEffect(() => {
    ser.current.ichiCandle?.applyOptions({ visible: ichiVisible.candle });
    ser.current.tenkan?.applyOptions({ visible: ichiVisible.tenkan });
    ser.current.kijun?.applyOptions({ visible: ichiVisible.kijun });
    ser.current.chikou?.applyOptions({ visible: ichiVisible.chikou });
    ser.current.spanA?.applyOptions({ visible: ichiVisible.spanA });
    ser.current.spanB?.applyOptions({ visible: ichiVisible.spanB });
    if (cloudCanvas.current) {
      cloudCanvas.current.style.display = ichiVisible.spanA && ichiVisible.spanB ? 'block' : 'none';
    }
  }, [ichiVisible]);

  const toggleMainVisible = (key) => {
    setMainVisible(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleIchiVisible = (key) => {
    setIchiVisible(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // ③ MACD 배경색 캔버스에 그리기
  const drawMacdBackground = useCallback(() => {
    const container = priceRef.current;
    const macdChart = charts.current.macd;
    const macdData  = macdDataRef.current;
    if (!container || !macdChart || !macdData.length) return;

    if (!bgCanvasRef.current) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1;';
      container.style.position = 'relative';
      container.appendChild(canvas);
      bgCanvasRef.current = canvas;
    }
    const canvas = bgCanvasRef.current;
    const dpr  = window.devicePixelRatio || 1;
    const rect  = container.getBoundingClientRect();
    if (!rect.width) return;

    canvas.width  = Math.floor(rect.width  * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    canvas.style.width  = rect.width  + 'px';
    canvas.style.height = rect.height + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // MACD 0선 기준으로 배경 칠하기
    const ts = macdChart.timeScale();
    let prevX = null, prevFill = null;
    let firstX = null, firstFill = null;
    const plotRight = rect.width;

    for (let i = 0; i < macdData.length; i++) {
      const d = macdData[i];
      if (!Number.isFinite(d.macd)) continue;
      const sign = d.macd >= 0 ? 1 : -1;
      const x = ts.timeToCoordinate(d.time);
      if (x == null) { prevX = null; continue; }

      const fill = sign > 0
        ? 'rgba(239,83,80,0.12)'
        : 'rgba(21,101,192,0.12)';

      if (firstX === null) {
        firstX = x;
        firstFill = fill;
      }
      if (prevX !== null) {
        ctx.fillStyle = prevFill || fill;
        ctx.fillRect(prevX, 0, x - prevX, rect.height);
      }
      prevX = x;
      prevFill = fill;
    }

    if (firstX !== null && firstFill && firstX > 0) {
      ctx.fillStyle = firstFill;
      ctx.fillRect(0, 0, firstX, rect.height);
    }
    if (prevX !== null && prevFill && plotRight > prevX) {
      ctx.fillStyle = prevFill;
      ctx.fillRect(prevX, 0, plotRight - prevX, rect.height);
    }
  }, []);

  // ─── 차트 초기화 (once) ──────────────────────────────
  useEffect(() => {
    if (inited.current) return;
    if (!priceRef.current || !volumeRef.current || !macdRef.current || !ichiRef.current) return;
    inited.current = true;
    [priceRef, volumeRef, macdRef, ichiRef].forEach((ref) => {
      ref.current?.replaceChildren();
    });
    bgCanvasRef.current = null;
    cloudCanvas.current = null;

    const w = (ref) => ref.current?.clientWidth || 400;
    const chartOptions = {
      ...BASE_OPTS,
      timeScale: {
        ...BASE_OPTS.timeScale,
        tickMarkFormatter: (time) => formatAxisTime(time, timeZoneRef.current),
      },
      localization: {
        timeFormatter: (time) => formatAxisTime(time, timeZoneRef.current),
        priceFormatter: (price) => formatPriceLabel(price, symbolRef.current),
      },
    };
    const pc = createChart(priceRef.current, {
      ...chartOptions,
      crosshair: { mode: CrosshairMode.Normal },
      height: 300, width: w(priceRef),
    });
    const vc = createChart(volumeRef.current, {
      ...chartOptions,
      localization: {
        ...chartOptions.localization,
        priceFormatter: formatVolumeLabel,
      },
      crosshair: { mode: CrosshairMode.Normal, horzLine: { visible: false, labelVisible: false } },
      height: 120, width: w(volumeRef),
    });
    const mc = createChart(macdRef.current, {
      ...chartOptions,
      localization: {
        ...chartOptions.localization,
        priceFormatter: formatNumberNoDecimals,
      },
      crosshair: { mode: CrosshairMode.Normal, horzLine: { visible: false, labelVisible: false } },
      height: 130, width: w(macdRef),
    });
    const ic = createChart(ichiRef.current, {
      ...chartOptions,
      crosshair: { mode: CrosshairMode.Normal },
      height: 240, width: w(ichiRef),
    });

    charts.current = { price: pc, volume: vc, macd: mc, ichi: ic };

    // ── 시리즈 생성 ─────────────────────────────────────
    // ② 음봉=파란색, ④ 마지막 종가 점선 제거
    ser.current.candle = pc.addSeries(CandlestickSeries, {
      upColor: '#ef5350', downColor: '#1565c0',
      borderVisible: true,
      wickVisible: true,
      borderUpColor: '#dc2626',
      borderDownColor: '#0f5fb8',
      wickUpColor: '#ef5350', wickDownColor: '#1565c0',
      priceFormat: { type: 'custom', formatter: (price) => formatPriceLabel(price, symbolRef.current) },
      ...NO_PRICE_LINE,
    });

    // MA 라인들
    ser.current.maLines = MA_PERIODS.map((_, idx) =>
      pc.addSeries(LineSeries, {
        color: MA_COLORS[idx], lineWidth: 1,
        crosshairMarkerVisible: false,
        priceFormat: { type: 'custom', formatter: (price) => formatPriceLabel(price, symbolRef.current) },
        ...NO_PRICE_LINE,
      })
    );

    ser.current.vol = vc.addSeries(HistogramSeries, {
      color: '#ef5350',
      priceFormat: { type: 'custom', formatter: formatVolumeLabel },
      priceScaleId: 'right',
    });
    vc.priceScale('right').applyOptions({
      scaleMargins: { top: 0.1, bottom: 0 },
      minimumWidth: PRICE_SCALE_WIDTH,
    });

    const macdPriceFormat = { type: 'custom', formatter: formatNumberNoDecimals };
    ser.current.macdHist = mc.addSeries(HistogramSeries, { color: '#26a69a', priceFormat: macdPriceFormat, ...NO_PRICE_LINE });
    ser.current.macdLine = mc.addSeries(LineSeries, { color: '#2962ff', lineWidth: 1, priceFormat: macdPriceFormat, ...NO_PRICE_LINE });
    ser.current.signal   = mc.addSeries(LineSeries, { color: '#ff6d00', lineWidth: 1, priceFormat: macdPriceFormat, ...NO_PRICE_LINE });

    ser.current.ichiCandle = ic.addSeries(CandlestickSeries, {
      upColor: '#ef5350', downColor: '#1565c0',
      borderVisible: true,
      wickVisible: true,
      borderUpColor: '#dc2626',
      borderDownColor: '#0f5fb8',
      wickUpColor: '#ef5350', wickDownColor: '#1565c0',
      priceFormat: { type: 'custom', formatter: (price) => formatPriceLabel(price, symbolRef.current) },
      ...NO_PRICE_LINE,
    });
    const priceFormat = { type: 'custom', formatter: (price) => formatPriceLabel(price, symbolRef.current) };
    ser.current.tenkan = ic.addSeries(LineSeries, { color: '#e53935', lineWidth: 1, priceFormat, ...NO_PRICE_LINE });
    ser.current.kijun  = ic.addSeries(LineSeries, { color: '#1565c0', lineWidth: 1, priceFormat, ...NO_PRICE_LINE });
    ser.current.chikou = ic.addSeries(LineSeries, { color: '#9c27b0', lineWidth: 1, priceFormat, ...NO_PRICE_LINE });
    ser.current.spanA  = ic.addSeries(LineSeries, { color: '#43a047', lineWidth: 1, lineStyle: 2, priceFormat, ...NO_PRICE_LINE });
    ser.current.spanB  = ic.addSeries(LineSeries, { color: '#e53935', lineWidth: 1, lineStyle: 2, priceFormat, ...NO_PRICE_LINE });
    [pc, vc, mc, ic].forEach(chart => {
      chart.priceScale('right').applyOptions({ minimumWidth: PRICE_SCALE_WIDTH });
    });
    setChartsReady(true);
    setTimeout(() => setLoadVersion(v => v + 1), 0);

    // ⑧ 타임스케일 동기화 (양방향: price↔volume↔macd)
    const triCharts = [pc, vc, mc];
    triCharts.forEach((chart, i) => {
      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (syncLock.current || !range) return;
        syncLock.current = true;
        triCharts.forEach((other, j) => {
          if (j !== i) {
            try {
              other.timeScale().setVisibleLogicalRange(range);
            } catch (e) {
              console.warn('Visible range sync skipped:', e);
            }
          }
        });
        // ③ MACD 배경 다시 그리기
        drawMacdBackground();
        syncLock.current = false;
      });
    });

    // ⑦ 크로스헤어 동기화 (price, volume, macd)
    const mainTrio = [
      { c: pc, s: () => ser.current.candle, key: 'candle' },
      { c: vc, s: () => ser.current.vol, key: 'volume' },
      { c: mc, s: () => ser.current.macdHist, key: 'macd' },
    ];

    mainTrio.forEach(({ c: chart }, i) => {
      chart.subscribeCrosshairMove((param) => {
        // 툴팁 (price 차트에서만)
        if (i === 0) {
          const tip = tooltipRef.current;
          if (tip) {
            if (!param.point || !param.time) {
              tip.style.display = 'none';
            } else {
              const data = param.seriesData?.get(ser.current.candle);
              if (data?.open != null) {
                const isUp  = data.close >= data.open;
                const color = isUp ? '#dc2626' : '#1565c0';
                const tk    = timeKey(param.time);
                const candles = mainCandlesRef.current;
                const candleIndex = candles.findIndex(candle => timeKey(candle.time) === tk);
                const previousClose = candleIndex > 0 ? Number(candles[candleIndex - 1]?.close) : null;
                const changePct = Number.isFinite(previousClose) && previousClose !== 0
                  ? ((Number(data.close) - previousClose) / previousClose) * 100
                  : null;
                const changePctColor = Number.isFinite(changePct)
                  ? (changePct >= 0 ? '#dc2626' : '#1565c0')
                  : color;
                const maRows = MA_PERIODS.slice(0, 4).map((p, idx) => {
                  const val = maMaps.current[idx]?.get(tk);
                  return val != null
                    ? `<span class="tt-ma" style="color:${MA_COLORS[idx]}">${p} <b>${formatPriceLabel(val, symbolRef.current)}</b></span>`
                    : '';
                }).join('');

                tip.innerHTML =
                  `<div class="tt-row" style="color:${color}">` +
                  `<span>시가 <b>${formatPriceLabel(data.open, symbolRef.current)}</b></span>` +
                  `<span>종가 <b>${formatPriceLabel(data.close, symbolRef.current)}</b></span>` +
                  `</div>` +
                  (Number.isFinite(changePct)
                    ? `<div class="tt-row" style="color:${changePctColor}"><span>등락률</span><b>${formatSignedPercent(changePct)}</b></div>`
                    : '') +
                  (maRows ? `<div class="tt-ma-row">${maRows}</div>` : '');

                const cw = priceRef.current?.clientWidth || 400;
                const tooltipWidth = 168;
                let lx = param.point.x - tooltipWidth - 14;
                if (lx < 4) lx = param.point.x + 12;
                if (lx + tooltipWidth > cw) lx = Math.max(4, cw - tooltipWidth);
                tip.style.left = lx + 'px';
                tip.style.top  = Math.max(4, param.point.y - 58) + 'px';
                tip.style.display = 'block';
              }
            }
          }
        }

        // ② 크로스헤어 동기화 (Value is null 방지: try-catch)
        if (xhairLock.current) return;
        xhairLock.current = true;
        mainTrio.forEach(({ c: other, s, key }, j) => {
          if (j === i) return;
          const series = s();
          if (!series) return;
          try {
            const tk = param.time ? timeKey(param.time) : null;
            const value = tk ? crosshairValueMapsRef.current[key]?.get(tk) : null;
            if (param.time && Number.isFinite(value)) {
              other.setCrosshairPosition(value, param.time, series);
            } else {
              other.clearCrosshairPosition();
            }
          } catch (e) {
            console.warn('Crosshair sync skipped:', e);
          }
        });
        xhairLock.current = false;
      });
    });

    ic.subscribeCrosshairMove((param) => {
      const tip = ichiTooltipRef.current;
      if (!tip) return;
      if (!param.point || !param.time) {
        tip.style.display = 'none';
        return;
      }

      const tk = timeKey(param.time);
      const maps = ichiValueMapsRef.current;
      const candle = maps.candle.get(tk);
      const rows = [];
      const addRow = (label, value, color = '#334155') => {
        if (Number.isFinite(value)) {
          rows.push(`<span class="ichi-tt-item" style="color:${color}">${label} <b>${formatPriceLabel(value, symbolRef.current)}</b></span>`);
        }
      };

      if (candle) {
        addRow('시가', candle.open, candle.close >= candle.open ? '#dc2626' : '#1565c0');
        addRow('종가', candle.close, candle.close >= candle.open ? '#dc2626' : '#1565c0');
      }
      addRow('기준선', maps.kijun.get(tk), '#1565c0');
      addRow('전환선', maps.tenkan.get(tk), '#e53935');
      addRow('후행선', maps.chikou.get(tk), '#9c27b0');
      addRow('선행1', maps.spanA.get(tk), '#43a047');
      addRow('선행2', maps.spanB.get(tk), '#e53935');

      if (!rows.length) {
        tip.style.display = 'none';
        return;
      }

      tip.innerHTML = rows.join('');
      const cw = ichiRef.current?.clientWidth || 400;
      let lx = param.point.x - 154;
      if (lx < 4) lx = param.point.x + 10;
      if (lx + 148 > cw) lx = Math.max(4, cw - 148);
      tip.style.left = `${lx}px`;
      tip.style.top = `${Math.max(4, param.point.y - 36)}px`;
      tip.style.display = 'grid';
    });

    // 리사이즈
    const onResize = () => {
      [[pc, priceRef], [vc, volumeRef], [mc, macdRef], [ic, ichiRef]].forEach(([chart, ref]) => {
        if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
      });
      drawMacdBackground();
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      inited.current = false;
      bgCanvasRef.current?.remove();
      cloudCanvas.current?.remove();
      bgCanvasRef.current = null;
      cloudCanvas.current = null;
      Object.values(charts.current).forEach(c => { try { c.remove(); } catch (e) { console.warn('Chart remove skipped:', e); } });
      [priceRef, volumeRef, macdRef, ichiRef].forEach((ref) => {
        ref.current?.replaceChildren();
      });
      charts.current = {};
      ser.current = {};
      maMaps.current = [];
      ichiValueMapsRef.current = {
        candle: new Map(),
        kijun: new Map(),
        tenkan: new Map(),
        chikou: new Map(),
        spanA: new Map(),
        spanB: new Map(),
      };
    };
  }, [drawMacdBackground]);

  // ─── Ichimoku cloud ──────────────────────────────────
  const drawCloud = useCallback((spanAData, spanBData) => {
    const container = ichiRef.current;
    const chart = charts.current.ichi;
    if (!container || !chart) return;
    if (cloudCanvas.current) {
      try { cloudCanvas.current.remove(); } catch (e) { console.warn('Cloud canvas remove skipped:', e); }
    }
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1;';
    container.style.position = 'relative';
    container.appendChild(canvas);
    cloudCanvas.current = canvas;

    const dpr = window.devicePixelRatio || 1;
    const paint = () => {
      const rect = container.getBoundingClientRect();
      if (!rect.width) return;
      canvas.width  = Math.floor(rect.width  * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvas.style.width  = rect.width  + 'px';
      canvas.style.height = rect.height + 'px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const plotRight = typeof chart.timeScale().width === 'function'
        ? chart.timeScale().width()
        : Math.max(0, rect.width - PRICE_SCALE_WIDTH);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, plotRight, rect.height);
      ctx.clip();

      const spanBMap = new Map(spanBData.map(d => [timeKey(d.time), d]));
      const points = spanAData
        .map((aPoint) => {
          const bPoint = spanBMap.get(timeKey(aPoint.time));
          const a = aPoint?.value;
          const b = bPoint?.value;
          if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
          const x = chart.timeScale().timeToCoordinate(aPoint.time);
          const yA = ser.current.spanA?.priceToCoordinate(a);
          const yB = ser.current.spanB?.priceToCoordinate(b);
          if (x == null || yA == null || yB == null || x > plotRight) return null;
          return {
            x,
            top: Math.min(yA, yB),
            bottom: Math.max(yA, yB),
            sign: a > b ? 1 : a < b ? -1 : 0,
          };
        })
        .filter(Boolean);

      const fillSegment = (segment, color) => {
        if (segment.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(segment[0].x, segment[0].top);
        segment.forEach(p => ctx.lineTo(p.x, p.top));
        for (let i = segment.length - 1; i >= 0; i--) ctx.lineTo(segment[i].x, segment[i].bottom);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };

      let segment = [];
      let segmentSign = 0;
      const colorForSign = (sign) => sign > 0 ? 'rgba(220,38,38,0.16)' : 'rgba(21,101,192,0.16)';
      points.forEach((point) => {
        if (point.sign === 0) {
          if (segmentSign) fillSegment(segment, colorForSign(segmentSign));
          segment = [point];
          segmentSign = 0;
          return;
        }
        if (segmentSign && point.sign !== segmentSign) {
          fillSegment(segment, colorForSign(segmentSign));
          segment = segment.length ? [segment[segment.length - 1], point] : [point];
        } else {
          segment.push(point);
        }
        segmentSign = point.sign;
      });
      if (segmentSign) fillSegment(segment, colorForSign(segmentSign));
      ctx.restore();
    };
    paint();
    requestAnimationFrame(paint);
    chart.timeScale().subscribeVisibleTimeRangeChange(paint);
  }, []);

  const applyRealtimeQuote = useCallback((quoteData) => {
    const activeSymbol = symbolRef.current;
    if (!activeSymbol || !quoteData || !Number.isFinite(Number(quoteData.price))) return;
    setQuote({ ...quoteData, symbol: activeSymbol });

    if (!isIntradayTf(mainTf) || !ser.current.candle) return;
    const barTime = realtimeBarTime(quoteData, mainTf);
    if (!barTime) return;

    const candles = [...mainCandlesRef.current];
    const price = Number(quoteData.price);
    const tradeVolume = Number(quoteData.tradeVolume);
    const last = candles[candles.length - 1];
    if (!last || barTime < Number(last.time)) return;

    if (barTime === Number(last.time)) {
      const nextVolume = Number.isFinite(tradeVolume)
        ? (Number(last.volume) || 0) + tradeVolume
        : last.volume;
      candles[candles.length - 1] = {
        ...last,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        close: price,
        volume: nextVolume,
      };
    } else {
      candles.push({
        time: barTime,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: Number.isFinite(tradeVolume) ? tradeVolume : 0,
      });
    }

    mainCandlesRef.current = candles;
    ser.current.candle.setData(candles);
    crosshairValueMapsRef.current.candle = new Map(candles.map(d => [timeKey(d.time), d.close]));

    const volData = candles.map((d, i) => {
      const currentVolume = +d.volume;
      const previousVolume = candles[i - 1]?.volume;
      if (!Number.isFinite(currentVolume)) return { time: d.time };
      return {
        time: d.time,
        value: currentVolume,
        color: volumeColorByChange(currentVolume, previousVolume),
      };
    });
    mainVolumeRef.current = volData;
    ser.current.vol?.setData(volData);
    crosshairValueMapsRef.current.volume = new Map(volData.filter(d => Number.isFinite(d.value)).map(d => [timeKey(d.time), d.value]));

    const macd = calculateMACD(candles);
    macdDataRef.current = macd;
    const macdHistData = macd.map(d => (
      Number.isFinite(d.histogram)
        ? { time: d.time, value: d.histogram, color: d.histogram >= 0 ? '#ef5350' : '#1565c0' }
        : { time: d.time }
    ));
    ser.current.macdHist?.setData(macdHistData);
    ser.current.macdLine?.setData(macd.map(d => (
      Number.isFinite(d.macd) ? { time: d.time, value: d.macd } : { time: d.time }
    )));
    ser.current.signal?.setData(macd.map(d => (
      Number.isFinite(d.signal) ? { time: d.time, value: d.signal } : { time: d.time }
    )));
    crosshairValueMapsRef.current.macd = new Map(macdHistData.filter(d => Number.isFinite(d.value)).map(d => [timeKey(d.time), d.value]));

    maMaps.current = MA_PERIODS.map((period, idx) => {
      const maData = calculateMA(candles, period);
      ser.current.maLines[idx]?.setData(safeLineData(maData));
      return buildTimeMap(maData);
    });
    drawMacdBackground();
  }, [drawMacdBackground, mainTf]);

  const fetchQuote = useCallback(async (sym, signal) => {
    if (!sym) return;
    const quoteResponse = await fetch(`/api/quote?symbol=${encodeURIComponent(sym)}`, { signal });
    const quoteContentType = quoteResponse.headers.get('content-type') || '';
    if (quoteResponse.ok && quoteContentType.includes('application/json')) {
      const quoteData = await quoteResponse.json();
      if (Number.isFinite(Number(quoteData?.price))) {
        setQuote({ ...quoteData, symbol: sym });
        return;
      }
    }

    const realtimeKorean = isKoreanSymbol(sym) && isMarketUpdateWindow(sym);
    const dailyUrl = `/api/ohlcv?symbol=${encodeURIComponent(sym)}&interval=day&limit=6`;
    const response = await fetch(dailyUrl, { signal });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('application/json')) return;
    const data = await response.json();
    const candles = filterDailyTradingCandles(normalizeCandleData(data), sym, { interval: 'day' });

    let nextQuote = buildQuoteFromCandles(candles);
    if (realtimeKorean) {
      const minuteResponse = await fetch(`/api/ohlcv?symbol=${encodeURIComponent(sym)}&interval=1m&limit=5`, { signal });
      const minuteContentType = minuteResponse.headers.get('content-type') || '';
      if (minuteResponse.ok && minuteContentType.includes('application/json')) {
        const minuteData = await minuteResponse.json();
        const minuteCandles = normalizeCandleData(minuteData);
        const latestMinute = minuteCandles[minuteCandles.length - 1];
        nextQuote = buildQuoteFromIntradayPrice(latestMinute?.close, candles) || nextQuote;
      }
    }

    if (nextQuote) setQuote({ ...nextQuote, symbol: sym });
  }, []);

  // ─── 메인 3개 차트 데이터 로드 ───────────────────────
  const fetchMain = useCallback(async (sym, tf, lim, { followLatest = false } = {}) => {
    if (!sym || !ser.current.candle) return;
    const viewKey = `${sym}:${tf.interval}:${lim}`;
    const r    = await fetch(`/api/ohlcv?symbol=${encodeURIComponent(sym)}&interval=${tf.interval}&limit=${requestLimit(tf, lim)}`);
    const contentType = r.headers.get('content-type') || '';
    if (!r.ok) {
      const body = contentType.includes('application/json') ? await r.json().catch(() => null) : await r.text();
      throw new Error(body?.error || body || `시세 조회 실패 (${r.status})`);
    }
    if (!contentType.includes('application/json')) {
      throw new Error('시세 API가 JSON 대신 HTML을 반환했습니다. 배포 API 연결을 확인하세요.');
    }
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) {
      throw new Error(`${tf.label} 데이터가 비어 있습니다.`);
    }

    // ② null 값 필터링
    const candles = normalizeCandleData(data);
    if (!candles.length) throw new Error('시세 데이터가 비어 있습니다.');
    crosshairValueMapsRef.current = { candle: new Map(), volume: new Map(), macd: new Map() };
    mainCandlesRef.current = candles;
    ser.current.candle.setData(candles);
    crosshairValueMapsRef.current.candle = new Map(candles.map(d => [timeKey(d.time), d.close]));

    // MA 계산 및 팝업용 맵 저장
    maMaps.current = MA_PERIODS.map((period, idx) => {
      const maData = calculateMA(candles, period);
      ser.current.maLines[idx]?.setData(safeLineData(maData));
      return buildTimeMap(maData);
    });

    // 거래량
    const volData = candles
      .map((d, i) => {
        const currentVolume = +d.volume;
        const previousVolume = candles[i - 1]?.volume;
        if (!Number.isFinite(currentVolume)) return { time: d.time };
        return {
          time: d.time,
          value: currentVolume,
          color: volumeColorByChange(currentVolume, previousVolume),
        };
      });
    mainVolumeRef.current = volData;
    ser.current.vol.setData(volData);
    crosshairValueMapsRef.current.volume = new Map(volData.filter(d => Number.isFinite(d.value)).map(d => [timeKey(d.time), d.value]));

    // MACD
    const macd = calculateMACD(candles);
    macdDataRef.current = macd;
    const macdHistData = macd.map(d => (
      Number.isFinite(d.histogram)
        ? {
          time: d.time,
          value: d.histogram,
          color: d.histogram >= 0 ? '#ef5350' : '#1565c0',
        }
        : { time: d.time }
    ));
    const macdLineData = macd.map(d => (
      Number.isFinite(d.macd) ? { time: d.time, value: d.macd } : { time: d.time }
    ));
    const signalData = macd.map(d => (
      Number.isFinite(d.signal) ? { time: d.time, value: d.signal } : { time: d.time }
    ));
    ser.current.macdHist.setData(macdHistData);
    crosshairValueMapsRef.current.macd = new Map(macdHistData.filter(d => Number.isFinite(d.value)).map(d => [timeKey(d.time), d.value]));
    ser.current.macdLine.setData(macdLineData);
    ser.current.signal.setData(signalData);

    // ③ MACD 배경 그리기 (약간 지연 → 차트 렌더 후)
    requestAnimationFrame(() => {
      if (mainViewKeyRef.current !== viewKey || followLatest) {
        const visibleBars = Math.min(lim, candles.length);
        const range = {
          from: Math.max(0, candles.length - visibleBars),
          to: Math.max(0, candles.length - 1),
        };
        [charts.current.price, charts.current.volume, charts.current.macd].forEach(chart => {
          try { chart?.timeScale().setVisibleLogicalRange(range); } catch (e) { console.warn('setVisibleLogicalRange skipped:', e); }
        });
        mainViewKeyRef.current = viewKey;
      }
      drawMacdBackground();
    });
  }, [drawMacdBackground]);

  const fetchIchi = useCallback(async (sym, tf, lim) => {
    if (!sym || !ser.current.ichiCandle) return;
    const r    = await fetch(`/api/ohlcv?symbol=${encodeURIComponent(sym)}&interval=${tf.interval}&limit=${ichimokuRequestLimit(tf, lim)}`);
    const contentType = r.headers.get('content-type') || '';
    if (!r.ok) {
      const body = contentType.includes('application/json') ? await r.json().catch(() => null) : await r.text();
      throw new Error(body?.error || body || `시세 조회 실패 (${r.status})`);
    }
    if (!contentType.includes('application/json')) {
      throw new Error('시세 API가 JSON 대신 HTML을 반환했습니다. 배포 API 연결을 확인하세요.');
    }
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) {
      ser.current.ichiCandle.setData([]);
      ser.current.tenkan.setData([]);
      ser.current.kijun.setData([]);
      ser.current.chikou.setData([]);
      ser.current.spanA.setData([]);
      ser.current.spanB.setData([]);
      ichiValueMapsRef.current = {
        candle: new Map(),
        kijun: new Map(),
        tenkan: new Map(),
        chikou: new Map(),
        spanA: new Map(),
        spanB: new Map(),
      };
      return;
    }

    const candles = filterDailyTradingCandles(
      filterKoreanRegularIntraday(normalizeCandleData(data), sym, tf),
      sym,
      tf
    );
    if (!candles.length) throw new Error('일목균형표 데이터가 비어 있습니다.');
    const ichi = calculateIchimoku(candles);
    const visibleCount = Math.min(Math.max(Number(lim) || ichiLimit, 1), candles.length);
    const projectedTimes = buildProjectedTimes(candles, tf, sym, ICHIMOKU_DISPLACEMENT + 2);
    const projectedTimeAt = (idx, bars = ICHIMOKU_DISPLACEMENT) => projectedTimes[idx + bars] ?? null;
    const futureWhitespace = projectedTimes
      .slice(candles.length, candles.length + ICHIMOKU_DISPLACEMENT + 2)
      .map(time => ({ time }));
    ser.current.ichiCandle.setData([...candles, ...futureWhitespace]);

    const spanAData = ichi
      .map((d, i) => d.tenkan != null && d.kijun != null ? ({
        time: projectedTimeAt(i),
        value: (d.tenkan + d.kijun) / 2,
      }) : null)
      .filter(d => d?.time != null);
    const spanBData = candles
      .map((d, i) => ({
        time: projectedTimeAt(i),
        value: ichimokuSpanBValue(candles, i),
      }))
      .filter(d => d?.time != null);

    const tenkanData = safeLineData(ichi.map((d, i) => ({ time: candles[i]?.time, value: d.tenkan })).filter(d => d.time != null));
    const kijunData = safeLineData(ichi.map((d, i) => ({ time: candles[i]?.time, value: d.kijun })).filter(d => d.time != null));
    const chikouData = safeLineData(ichi.map((d, i) => ({ time: candles[i]?.time, value: d.chikou })).filter(d => d.time != null));
    const safeSpanAData = safeLineData(spanAData);
    const safeSpanBData = safeLineData(spanBData);

    ser.current.tenkan.setData(tenkanData);
    ser.current.kijun.setData(kijunData);
    ser.current.chikou.setData(chikouData);
    ser.current.spanA.setData(safeSpanAData);
    ser.current.spanB.setData(safeSpanBData);
    ichiValueMapsRef.current = {
      candle: new Map(candles.map(candle => [timeKey(candle.time), candle])),
      kijun: buildValueMap(kijunData),
      tenkan: buildValueMap(tenkanData),
      chikou: buildValueMap(chikouData),
      spanA: buildValueMap(safeSpanAData),
      spanB: buildValueMap(safeSpanBData),
    };

    const viewKey = `${sym}:${tf.interval}:${visibleCount}`;
    requestAnimationFrame(() => {
      if (ichiViewKeyRef.current !== viewKey) {
        try {
          charts.current.ichi?.timeScale().setVisibleLogicalRange({
            from: Math.max(0, candles.length - visibleCount),
            to: candles.length - 1 + ICHIMOKU_DISPLACEMENT + 1,
          });
        } catch (e) {
          console.warn('Ichi visible range sync skipped:', e);
        }
        ichiViewKeyRef.current = viewKey;
      }
      drawCloud(spanAData, spanBData);
    });
  }, [drawCloud, ichiLimit]);

  // 메인 캔들/거래량/MACD는 위쪽 봉 버튼과 기간만 바뀔 때 다시 로드
  useEffect(() => {
    if (!symbol) return;
    const timer = setTimeout(() => {
      setError('');
      setLoading(true);
    }, 0);
    fetchMain(symbol, mainTf, limit)
      .catch(e => {
        if (!String(e.message || '').includes('Value is null')) setError(e.message);
      })
      .finally(() => {
        clearTimeout(timer);
        setLoading(false);
      });
    return () => clearTimeout(timer);
  }, [symbol, mainTf, limit, loadVersion, fetchMain]);

  // 일목균형표는 아래쪽 일목 봉 버튼과 기간이 바뀔 때만 다시 로드
  useEffect(() => {
    if (!symbol) return;
    fetchIchi(symbol, ichiTf, ichiLimit).catch(() => {});
  }, [symbol, ichiTf, ichiLimit, loadVersion, fetchIchi]);

  useEffect(() => {
    if (!charts.current.price) return;
    const intraMain = isIntradayTf(mainTf);
    const intraIchi = isIntradayTf(ichiTf);
    charts.current.price.applyOptions({ timeScale: { timeVisible: intraMain } });
    charts.current.volume.applyOptions({ timeScale: { timeVisible: intraMain } });
    charts.current.macd.applyOptions({ timeScale: { timeVisible: intraMain } });
    charts.current.ichi.applyOptions({ timeScale: { timeVisible: intraIchi } });
  }, [mainTf, ichiTf]);

  useEffect(() => {
    if (!symbol || !chartsReady) return;
    const controller = new AbortController();
    const updateQuote = () => fetchQuote(symbol, controller.signal).catch(() => {});
    updateQuote();
    let timer = null;

    if (isMarketUpdateWindow(symbol)) {
      timer = setInterval(() => {
        if (!isMarketUpdateWindow(symbol)) {
          clearInterval(timer);
          timer = null;
          return;
        }
        updateQuote();
      }, isKoreanSymbol(symbol) ? 700 : 3000);
    }

    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [symbol, chartsReady, fetchQuote]);

  useEffect(() => {
    if (!symbol || !chartsReady || !supportsKisRealtimeStream(symbol)) return undefined;
    const stream = new EventSource(`/api/stream/quote?symbol=${encodeURIComponent(symbol)}`);

    const handleQuote = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload?.quote) applyRealtimeQuote(payload.quote);
      } catch (e) {
        console.warn('Realtime quote parse failed:', e);
      }
    };

    stream.addEventListener('quote', handleQuote);
    stream.onerror = () => {
      // EventSource reconnects automatically; REST polling remains as fallback.
    };

    return () => {
      stream.removeEventListener('quote', handleQuote);
      stream.close();
    };
  }, [symbol, chartsReady, applyRealtimeQuote]);

  // ⑧ 실시간 업데이트: 최신 캔들을 3초마다 따라가게 갱신
  useEffect(() => {
    if (!symbol || !chartsReady) return;
    const isIntra = INTRA_INTERVALS.includes(mainTf.interval);
    const ms = isIntra ? (isKoreanSymbol(symbol) ? 1000 : 3000) : 5000;
    const t = setInterval(() => {
      if (isMarketUpdateWindow(symbol)) fetchMain(symbol, mainTf, limit, { followLatest: isIntra }).catch(() => {});
    }, ms);
    return () => clearInterval(t);
  }, [symbol, mainTf, limit, chartsReady, fetchMain]);

  useEffect(() => {
    if (!symbol || !chartsReady) return;
    const isIntra = INTRA_INTERVALS.includes(ichiTf.interval);
    const ms = isIntra ? (isKoreanSymbol(symbol) ? 1000 : 3000) : 5000;
    const t = setInterval(() => {
      if (isMarketUpdateWindow(symbol)) fetchIchi(symbol, ichiTf, ichiLimit).catch(() => {});
    }, ms);
    return () => clearInterval(t);
  }, [symbol, ichiTf, ichiLimit, chartsReady, fetchIchi]);

  const applyLimit = () => {
    const n = parseInt(limitInput, 10);
    if (n > 0 && n <= 2000) {
      setLimit(n);
      setLimitInput(String(n));
    }
  };

  const changeMainTf = (tf) => {
    mainViewKeyRef.current = '';
    setError('');
    setLoading(true);
    setMainTf(tf);
  };

  const applyIchiLimit = () => {
    const n = parseInt(ichiLimitInput, 10);
    if (n > 0 && n <= 2000) {
      setIchiLimit(n);
      setIchiLimitInput(String(n));
    }
  };

  const captureChartSet = async () => Promise.all([
    captureChartSection(priceSectionRef.current, '캔들차트'),
    captureChartSection(volumeSectionRef.current, '거래량차트'),
    captureChartSection(macdSectionRef.current, 'MACD'),
    captureChartSection(ichiSectionRef.current, '일목균형표'),
  ]);

  const handleCopyChartSet = async () => {
    setCopyStatus('copying');
    try {
      const images = await captureChartSet();
      const blob = await buildChartSetPng(images, {
        symbolName,
        symbol,
        mainTf,
        limit,
        ichiTf,
        ichiLimit,
      });
      await copyPngToClipboard(blob);
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus(''), 1800);
    } catch (e) {
      console.error('Chart set copy failed:', e);
      setCopyStatus('failed');
      setTimeout(() => setCopyStatus(''), 2600);
    }
  };

  const handleAnalyze = async () => {
    setAnalysisOpen(true);
    setAnalysisLoading(true);
    setAnalysisError('');
    setAnalysisResult('');

    try {
      const images = await captureChartSet();

      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          symbolName,
          mainTf: mainTf.label,
          limit,
          ichiTf: ichiTf.label,
          ichiLimit,
          images,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || `분석 요청 실패 (${response.status})`);
      setAnalysisResult(payload?.result || '분석 결과가 비어 있습니다.');
    } catch (e) {
      setAnalysisError(e.message || '분석 중 오류가 발생했습니다.');
    } finally {
      setAnalysisLoading(false);
    }
  };

  // ─── Render ──────────────────────────────────────────
  return (
    <div className="chart-column">
      {/* Header */}
      <div className="column-header">
        <StockSearch onSelect={handleSelect} placeholder="종목/지수 검색 (예: 하이닉스, KOSPI, AAPL, S&P500)..." />

        {symbolName && (
          <div className="symbol-row">
            <span className="symbol-name">{symbolName}</span>
            <span className="symbol-code">{symbol}</span>
            {quote?.symbol === symbol && (
              <span className={`quote-chip ${quoteTone(quote)}`}>
                <span className="quote-price">{formatHeaderPrice(quote.price, symbol)}</span>
                {Number.isFinite(quote.changePct) && Number.isFinite(quote.change) && (
                  <span className="quote-change">
                    ({formatSignedPercent(quote.changePct)}, {formatSignedValue(quote.change, '', quoteValueDigits(symbol))})
                  </span>
                )}
                <span className="quote-state">{marketStateLabel(symbol)}</span>
              </span>
            )}
            {loading && <span className="loading-dot">●</span>}
          </div>
        )}
        {error && <div className="error-bar">{error}</div>}

        <div className="controls-row">
          <div className="tf-group">
            <span className="tf-label">봉</span>
            <div className="tf-btns">
              {MAIN_TFS.map(tf => (
                <button key={tf.label}
                  className={`tf-btn${mainTf.label === tf.label ? ' active' : ''}`}
                  onClick={() => changeMainTf(tf)}>
                  {tf.label}
                </button>
              ))}
            </div>
          </div>
          <div className="period-group">
            <button
              type="button"
              className={`copy-chart-btn${copyStatus === 'copied' ? ' copied' : ''}${copyStatus === 'failed' ? ' failed' : ''}`}
              onClick={handleCopyChartSet}
              disabled={copyStatus === 'copying' || !chartsReady}
              title="현재 차트 1세트를 PNG로 클립보드에 복사"
            >
              {copyStatus === 'copying' ? '복사중' : copyStatus === 'copied' ? '복사됨' : copyStatus === 'failed' ? '복사실패' : '복사'}
            </button>
            <button
              type="button"
              className="analysis-btn"
              onClick={handleAnalyze}
              disabled={analysisLoading || !chartsReady}
            >
              {analysisLoading ? '분석중' : '분석'}
            </button>
            <label className="tf-label" htmlFor={`period-${id}`}>기간</label>
            <input id={`period-${id}`} className="period-input"
              type="number" min="10" max="2000"
              value={limitInput}
              onChange={e => setLimitInput(e.target.value)}
              onBlur={applyLimit}
              onKeyDown={e => e.key === 'Enter' && applyLimit()}
            />
          </div>
        </div>
      </div>

      <div className="ma-legend">
        <button
          type="button"
          className={`legend-btn${mainVisible.candle ? '' : ' muted'}`}
          onClick={() => toggleMainVisible('candle')}
        >
          <span className="legend-swatch candle" />캔들
        </button>
        {MA_PERIODS.map((p, i) => (
          <button
            key={p}
            type="button"
            className={`legend-btn${mainVisible[`ma${p}`] ? '' : ' muted'}`}
            onClick={() => toggleMainVisible(`ma${p}`)}
            style={{ color: MA_COLORS[i] }}
          >
            <span className="legend-swatch" style={{ backgroundColor: MA_COLORS[i] }} />{p}
          </button>
        ))}
      </div>

      {/* 차트 영역 */}
      <div className="charts-area">
        <div ref={priceSectionRef} className="chart-section" style={{ position: 'relative' }}>
          <div className="chart-label">캔들차트</div>
          <div ref={priceRef} />
          {/* ③ MACD 배경 캔버스는 priceRef 안에 동적 삽입 */}
          {/* ⑤⑨ OHLC + MA 팝업 */}
          <div ref={tooltipRef} className="price-tooltip" />
        </div>

        <div ref={volumeSectionRef} className="chart-section">
          <div className="chart-label">거래량</div>
          <div ref={volumeRef} />
        </div>

        <div ref={macdSectionRef} className="chart-section">
          <div className="chart-label">MACD (12, 26, 9)</div>
          <div ref={macdRef} />
        </div>

        {/* ⑥ 두 세트 사이 구분선 */}
        <div className="charts-divider" />

        <div className="ichi-header">
          <span className="tf-label">일목균형표 봉</span>
          <div className="tf-btns">
            {ICHI_TFS.map(tf => (
              <button key={tf.label}
                className={`tf-btn${ichiTf.label === tf.label ? ' active' : ''}`}
                onClick={() => setIchiTf(tf)}>
                {tf.label}
              </button>
            ))}
          </div>
          <div className="period-group">
            <label className="tf-label" htmlFor={`ichi-period-${id}`}>기간</label>
            <input
              id={`ichi-period-${id}`}
              className="period-input"
              type="number"
              min="10"
              max="2000"
              value={ichiLimitInput}
              onChange={e => setIchiLimitInput(e.target.value)}
              onBlur={applyIchiLimit}
              onKeyDown={e => e.key === 'Enter' && applyIchiLimit()}
            />
          </div>
        </div>

        <div className="ma-legend ichi-legend">
          {[
            ['candle', '캔들', '#ef5350'],
            ['kijun', '기준선', '#1565c0'],
            ['tenkan', '전환선', '#e53935'],
            ['chikou', '후행선', '#9c27b0'],
            ['spanA', '선행1', '#43a047'],
            ['spanB', '선행2', '#e53935'],
          ].map(([key, label, color]) => (
            <button
              key={key}
              type="button"
              className={`legend-btn${ichiVisible[key] ? '' : ' muted'}`}
              onClick={() => toggleIchiVisible(key)}
              style={{ color }}
            >
              <span className="legend-swatch" style={{ backgroundColor: color }} />{label}
            </button>
          ))}
        </div>

        <div ref={ichiSectionRef} className="chart-section last" style={{ position: 'relative' }}>
          <div className="chart-label">일목균형표</div>
          <div ref={ichiRef} />
          <div ref={ichiTooltipRef} className="ichi-tooltip" />
        </div>
      </div>

      {analysisOpen && (
        <div className="analysis-modal-backdrop" role="presentation">
          <div className="analysis-modal" role="dialog" aria-modal="true" aria-labelledby={`analysis-title-${id}`}>
            <div className="analysis-modal-header">
              <div>
                <h2 id={`analysis-title-${id}`}>Gemini 차트 분석</h2>
                <p>{symbolName || symbol} · {mainTf.label} · 기간 {limit}</p>
              </div>
              <div className="analysis-modal-actions">
                <div className="analysis-font-controls" aria-label="분석 결과 글자 크기 조절">
                  <button
                    type="button"
                    className="analysis-font-btn"
                    onClick={() => setAnalysisFontSize(size => Math.max(11, size - 1))}
                    aria-label="글자 작게"
                  >
                    -
                  </button>
                  <span>{analysisFontSize}px</span>
                  <button
                    type="button"
                    className="analysis-font-btn"
                    onClick={() => setAnalysisFontSize(size => Math.min(24, size + 1))}
                    aria-label="글자 크게"
                  >
                    +
                  </button>
                </div>
                <button type="button" className="analysis-close-btn" onClick={() => setAnalysisOpen(false)}>
                  닫기
                </button>
              </div>
            </div>
            <div className="analysis-modal-body">
              {analysisLoading && <div className="analysis-loading">차트 이미지를 분석하고 있습니다...</div>}
              {analysisError && <div className="analysis-error">{analysisError}</div>}
              {analysisResult && (
                <div className="analysis-result" style={{ '--analysis-font-size': `${analysisFontSize}px` }}>
                  {renderMarkdown(analysisResult)}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
