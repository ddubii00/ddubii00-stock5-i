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
  { label: '5분',  interval: '5m' },
  { label: '15분', interval: '15m' },
  { label: '30분', interval: '30m' },
  { label: '1시간',interval: '60m' },
  { label: '일',   interval: 'day' },
  { label: '주',   interval: 'week' },
  { label: '월',   interval: 'month' },
];

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
  if (!isIntradayTf(tf)) return Math.min(baseLimit + 120, 2000);
  return Math.min(Math.max(baseLimit + 360, 480), 2000);
}

function isKoreanSymbol(symbol) {
  return /^\d{6}(\.(KS|KQ))?$/.test(symbol || '') || /\.(KS|KQ)$/.test(symbol || '');
}

function isIndexSymbol(symbol) {
  return String(symbol || '').startsWith('^');
}

function symbolTimeZone(symbol) {
  return isKoreanSymbol(symbol) ? 'Asia/Seoul' : 'America/New_York';
}

function formatNumberNoDecimals(value) {
  return Math.round(Number(value) || 0).toLocaleString('ko-KR');
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

function formatTooltipTime(time, zone) {
  if (typeof time !== 'number') return formatAxisTime(time, zone);
  return new Date(time * 1000).toLocaleString('ko-KR', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).replace(/\. /g, '.').replace(/\.$/, '');
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

function projectTime(time, interval, bars) {
  if (typeof time === 'number') return time + barSeconds(interval) * bars;
  const base = String(time || '').includes('T') ? new Date(time) : new Date(`${time}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return time;
  const projected = new Date(base.getTime() + barSeconds(interval) * bars * 1000);
  return projected.toISOString().slice(0, 10);
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  // KRX 00:00-06:30 UTC / NYSE 14:30-21:00 UTC
  return (m >= 0 && m <= 390) || (m >= 870 && m <= 1260);
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
function safeHistData(arr) {
  return arr.filter(d => d != null && Number.isFinite(d.value));
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
  const [ichiTf,     setIchiTf]     = useState(ICHI_TFS[5]);   // 일봉 default
  const [limit,      setLimit]      = useState(120);
  const [limitInput, setLimitInput] = useState('120');
  const [ichiLimit,  setIchiLimit]  = useState(120);
  const [ichiLimitInput, setIchiLimitInput] = useState('120');
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');
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
  const priceRef   = useRef(null);
  const volumeRef  = useRef(null);
  const macdRef    = useRef(null);
  const ichiRef    = useRef(null);
  const tooltipRef = useRef(null);
  const bgCanvasRef= useRef(null);  // ③ MACD 배경색 캔버스

  // Runtime refs
  const charts      = useRef({});
  const ser         = useRef({});
  const maMaps      = useRef([]);
  const macdDataRef = useRef([]);   // ③ MACD 데이터 저장
  const crosshairValueMapsRef = useRef({ candle: new Map(), volume: new Map(), macd: new Map() });
  const symbolRef   = useRef(symbol);
  const timeZoneRef = useRef(symbolTimeZone(symbol));
  const mainViewKeyRef = useRef('');
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
    const chart = charts.current.price;
    const macdChart = charts.current.macd;
    const macdData  = macdDataRef.current;
    if (!container || !chart || !macdChart || !macdData.length) return;

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
    const ts = chart.timeScale();
    let prevX = null, prevFill = null;
    let firstX = null, firstFill = null;
    const plotRight = typeof ts.width === 'function'
      ? ts.width()
      : Math.max(0, rect.width - PRICE_SCALE_WIDTH);

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
      borderVisible: false,
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
      borderVisible: false,
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
      chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
        if (syncLock.current || !range) return;
        syncLock.current = true;
        triCharts.forEach((other, j) => { if (j !== i) other.timeScale().setVisibleRange(range); });
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
                const maRows = MA_PERIODS.map((p, idx) => {
                  const val = maMaps.current[idx]?.get(tk);
                  return val != null
                    ? `<span class="tt-ma" style="color:${MA_COLORS[idx]}">MA${p} <b>${formatPriceLabel(val, symbolRef.current)}</b></span>`
                    : '';
                }).join('');

                tip.innerHTML =
                  `<div class="tt-date">${formatTooltipTime(param.time, timeZoneRef.current)}</div>` +
                  `<div class="tt-row" style="color:${color}">` +
                  `<span>시가 <b>${formatPriceLabel(data.open, symbolRef.current)}</b></span>` +
                  `<span>종가 <b>${formatPriceLabel(data.close, symbolRef.current)}</b></span>` +
                  `</div>` +
                  `<div class="tt-row tt-gray">` +
                  `<span>고가 ${formatPriceLabel(data.high, symbolRef.current)}</span>` +
                  `<span>저가 ${formatPriceLabel(data.low, symbolRef.current)}</span>` +
                  `</div>` +
                  (maRows ? `<div class="tt-ma-row">${maRows}</div>` : '');

                const cw = priceRef.current?.clientWidth || 400;
                let lx = param.point.x + 12;
                if (lx + 200 > cw) lx = param.point.x - 205;
                tip.style.left = lx + 'px';
                tip.style.top  = Math.max(4, param.point.y - 70) + 'px';
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
      Object.values(charts.current).forEach(c => { try { c.remove(); } catch (e) { console.warn('Chart remove skipped:', e); } });
      charts.current = {};
      ser.current = {};
      maMaps.current = [];
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
      const draw = (cond, color) => {
        const tops = [], bots = [];
        for (let i = 0; i < spanAData.length; i++) {
          const a = spanAData[i]?.value, b = spanBData[i]?.value;
          if (!Number.isFinite(a) || !Number.isFinite(b) || !cond(a, b)) continue;
          const x  = chart.timeScale().timeToCoordinate(spanAData[i].time);
          const yA = ser.current.spanA?.priceToCoordinate(a);
          const yB = ser.current.spanB?.priceToCoordinate(b);
          if (x == null || yA == null || yB == null) continue;
          tops.push([x, Math.min(yA, yB)]);
          bots.push([x, Math.max(yA, yB)]);
        }
        if (tops.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(tops[0][0], tops[0][1]);
        tops.forEach(p => ctx.lineTo(p[0], p[1]));
        for (let i = bots.length - 1; i >= 0; i--) ctx.lineTo(bots[i][0], bots[i][1]);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };
      draw((a, b) => a > b, 'rgba(220,38,38,0.14)');
      draw((a, b) => a < b, 'rgba(21,101,192,0.14)');
    };
    paint();
    requestAnimationFrame(paint);
    chart.timeScale().subscribeVisibleTimeRangeChange(paint);
  }, []);

  // ─── 메인 3개 차트 데이터 로드 ───────────────────────
  const fetchMain = useCallback(async (sym, tf, lim) => {
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
      ser.current.candle.setData([]);
      ser.current.vol.setData([]);
      ser.current.macdHist.setData([]);
      ser.current.macdLine.setData([]);
      ser.current.signal.setData([]);
      crosshairValueMapsRef.current = { candle: new Map(), volume: new Map(), macd: new Map() };
      return;
    }

    // ② null 값 필터링
    const candles = normalizeCandleData(data);
    if (!candles.length) throw new Error('시세 데이터가 비어 있습니다.');
    const visibleCandles = candles.slice(-lim);
    ser.current.candle.setData(visibleCandles);
    crosshairValueMapsRef.current.candle = new Map(visibleCandles.map(d => [timeKey(d.time), d.close]));

    // MA 계산 및 팝업용 맵 저장
    maMaps.current = MA_PERIODS.map((period, idx) => {
      const maData = calculateMA(candles, period);
      ser.current.maLines[idx]?.setData(safeLineData(maData).slice(-lim));
      return buildTimeMap(maData);
    });

    // 거래량
    const volData = visibleCandles
      .filter(d => d.volume != null && Number.isFinite(+d.volume))
      .map(d => ({ time: d.time, value: +d.volume, color: d.close >= d.open ? '#ef5350' : '#1565c0' }));
    ser.current.vol.setData(volData.filter(d => Number.isFinite(d.value)));
    crosshairValueMapsRef.current.volume = new Map(volData.map(d => [timeKey(d.time), d.value]));

    // MACD
    const macd = calculateMACD(candles);
    const visibleMacd = macd.slice(-lim);
    macdDataRef.current = visibleMacd;
    const macdHistData = safeHistData(
      visibleMacd
        .filter(d => Number.isFinite(d.histogram))
        .map(d => ({
          time: d.time,
          value: d.histogram,
          color: d.histogram >= 0 ? '#ef5350' : '#1565c0',
        }))
    );
    ser.current.macdHist.setData(macdHistData);
    crosshairValueMapsRef.current.macd = new Map(macdHistData.map(d => [timeKey(d.time), d.value]));
    ser.current.macdLine.setData(safeLineData(visibleMacd.filter(d => Number.isFinite(d.macd   )).map(d => ({ time: d.time, value: d.macd    }))));
    ser.current.signal.setData(  safeLineData(visibleMacd.filter(d => Number.isFinite(d.signal )).map(d => ({ time: d.time, value: d.signal  }))));

    // ③ MACD 배경 그리기 (약간 지연 → 차트 렌더 후)
    requestAnimationFrame(() => {
      if (mainViewKeyRef.current !== viewKey) {
        [charts.current.price, charts.current.volume, charts.current.macd].forEach(chart => {
          try { chart?.timeScale().fitContent(); } catch (e) { console.warn('fitContent skipped:', e); }
        });
        mainViewKeyRef.current = viewKey;
      }
      drawMacdBackground();
    });
  }, [drawMacdBackground]);

  const fetchIchi = useCallback(async (sym, tf, lim) => {
    if (!sym || !ser.current.ichiCandle) return;
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
      ser.current.ichiCandle.setData([]);
      ser.current.tenkan.setData([]);
      ser.current.kijun.setData([]);
      ser.current.chikou.setData([]);
      ser.current.spanA.setData([]);
      ser.current.spanB.setData([]);
      return;
    }

    const candles = normalizeCandleData(data);
    if (!candles.length) throw new Error('일목균형표 데이터가 비어 있습니다.');
    const visibleCandles = candles.slice(-ichiLimit);
    ser.current.ichiCandle.setData(visibleCandles);
    const ichi = calculateIchimoku(candles);
    const visibleIchi = ichi.slice(-ichiLimit);

    const spanAData = visibleIchi
      .map((d, i) => d.senkouA != null ? ({
        time: projectTime(visibleCandles[i]?.time, tf.interval, ICHIMOKU_DISPLACEMENT),
        value: d.senkouA,
      }) : null)
      .filter(d => d?.time != null);
    const spanBData = visibleIchi
      .map((d, i) => d.senkouB != null ? ({
        time: projectTime(visibleCandles[i]?.time, tf.interval, ICHIMOKU_DISPLACEMENT),
        value: d.senkouB,
      }) : null)
      .filter(d => d?.time != null);

    ser.current.tenkan.setData(safeLineData(visibleIchi.map((d, i) => ({ time: visibleCandles[i]?.time, value: d.tenkan })).filter(d => d.time != null)));
    ser.current.kijun.setData( safeLineData(visibleIchi.map((d, i) => ({ time: visibleCandles[i]?.time, value: d.kijun  })).filter(d => d.time != null)));
    ser.current.chikou.setData(safeLineData(visibleIchi.map((d, i) => ({ time: visibleCandles[i]?.time, value: d.chikou })).filter(d => d.time != null)));
    ser.current.spanA.setData( safeLineData(spanAData));
    ser.current.spanB.setData( safeLineData(spanBData));
    drawCloud(spanAData, spanBData);
  }, [drawCloud, ichiLimit]);

  // symbol/tf/limit 변경 시 로드
  useEffect(() => {
    if (!symbol) return;
    const timer = setTimeout(() => {
      setError('');
      setLoading(true);
    }, 0);
    Promise.all([
      fetchMain(symbol, mainTf, limit).catch(e => {
        if (!String(e.message || '').includes('Value is null')) setError(e.message);
      }),
      fetchIchi(symbol, ichiTf, ichiLimit + ICHIMOKU_DISPLACEMENT).catch(() => {}),
    ]).finally(() => {
      clearTimeout(timer);
      setLoading(false);
    });
    return () => clearTimeout(timer);
  }, [symbol, mainTf, ichiTf, limit, ichiLimit, loadVersion, fetchMain, fetchIchi]);

  useEffect(() => {
    if (!charts.current.price) return;
    const intraMain = isIntradayTf(mainTf);
    const intraIchi = isIntradayTf(ichiTf);
    charts.current.price.applyOptions({ timeScale: { timeVisible: intraMain } });
    charts.current.volume.applyOptions({ timeScale: { timeVisible: intraMain } });
    charts.current.macd.applyOptions({ timeScale: { timeVisible: intraMain } });
    charts.current.ichi.applyOptions({ timeScale: { timeVisible: intraIchi } });
  }, [mainTf, ichiTf]);

  // ⑧ 실시간 업데이트: 분봉 1초, 일봉 5초
  useEffect(() => {
    if (!symbol || !chartsReady) return;
    const isIntra = INTRA_INTERVALS.includes(mainTf.interval);
    const ms = isIntra ? 1000 : 5000;
    const t = setInterval(() => {
      if (isMarketOpen()) fetchMain(symbol, mainTf, limit).catch(() => {});
    }, ms);
    return () => clearInterval(t);
  }, [symbol, mainTf, limit, chartsReady, fetchMain]);

  useEffect(() => {
    if (!symbol || !chartsReady) return;
    const isIntra = INTRA_INTERVALS.includes(ichiTf.interval);
    const ms = isIntra ? 1000 : 5000;
    const t = setInterval(() => {
      if (isMarketOpen()) fetchIchi(symbol, ichiTf, ichiLimit + ICHIMOKU_DISPLACEMENT).catch(() => {});
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

  const applyIchiLimit = () => {
    const n = parseInt(ichiLimitInput, 10);
    if (n > 0 && n <= 2000) {
      setIchiLimit(n);
      setIchiLimitInput(String(n));
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
                  onClick={() => setMainTf(tf)}>
                  {tf.label}
                </button>
              ))}
            </div>
          </div>
          <div className="period-group">
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
        <div className="chart-section" style={{ position: 'relative' }}>
          <div className="chart-label">캔들차트</div>
          <div ref={priceRef} />
          {/* ③ MACD 배경 캔버스는 priceRef 안에 동적 삽입 */}
          {/* ⑤⑨ OHLC + MA 팝업 */}
          <div ref={tooltipRef} className="price-tooltip" />
        </div>

        <div className="chart-section">
          <div className="chart-label">거래량</div>
          <div ref={volumeRef} />
        </div>

        <div className="chart-section">
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

        <div className="chart-section last">
          <div className="chart-label">일목균형표</div>
          <div ref={ichiRef} />
        </div>
      </div>
    </div>
  );
}
