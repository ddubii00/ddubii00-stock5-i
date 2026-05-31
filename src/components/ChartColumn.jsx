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
];

const MA_PERIODS = [5, 20, 60];
const MA_COLORS  = ['#f59e0b', '#a855f7', '#06b6d4'];
const INTRA_INTERVALS = ['1m','3m','5m','15m','30m','60m'];

// ④ 마지막 종가 수평 점선 제거를 위한 헬퍼
const NO_PRICE_LINE = { priceLineVisible: false, lastValueVisible: false };

/** 날짜 포맷: 2026.03.02 (시간 없음) */
function fmtTime(time) {
  if (typeof time === 'string') return time.slice(0, 10).replace(/-/g, '.');
  if (typeof time === 'number') {
    const d = new Date(time * 1000);
    return [
      d.getUTCFullYear(),
      String(d.getUTCMonth() + 1).padStart(2, '0'),
      String(d.getUTCDate()).padStart(2, '0'),
    ].join('.');
  }
  return String(time);
}

function timeKey(time) {
  if (typeof time === 'string') return time.slice(0, 10);
  return String(time);
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  // KRX 00:00-06:30 UTC / NYSE 14:30-21:00 UTC
  return (m >= 0 && m <= 390) || (m >= 870 && m <= 1260);
}

/** ② "Value is null" 방지: lightweight-charts에 null 전달 금지 */
function safeCandleData(arr) {
  return arr.filter(d =>
    d != null &&
    Number.isFinite(d.open) &&
    Number.isFinite(d.high) &&
    Number.isFinite(d.low) &&
    Number.isFinite(d.close)
  );
}
function safeLineData(arr) {
  return arr.filter(d => d != null && Number.isFinite(d.value));
}
function safeHistData(arr) {
  return arr.filter(d => d != null && Number.isFinite(d.value));
}

const BASE_OPTS = {
  layout: {
    background: { type: 'solid', color: 'transparent' },
    textColor: '#374151',
    attributionLogo: false,
  },
  grid: { vertLines: { color: '#f0f2f5' }, horzLines: { color: '#f0f2f5' } },
  // ③ 마우스 휠 스크롤 줌 비활성화, 좌우 드래그만 허용
  handleScale: { mouseWheel: false, pinch: false },
  handleScroll: { pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false, mouseWheel: false },
  rightPriceScale: { borderColor: '#e2e5ec', minimumWidth: 70 },
  timeScale: {
    borderColor: '#e2e5ec',
    timeVisible: false,   // ④ 날짜만, 시간 없음
    secondsVisible: false,
    tickMarkFormatter: fmtTime,
  },
  localization: { timeFormatter: fmtTime },
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
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');

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

    // MACD 히스토그램의 부호에 따라 배경 칠하기
    const ts = chart.timeScale();
    let prevX = null, prevSign = null;

    for (let i = 0; i < macdData.length; i++) {
      const d = macdData[i];
      if (!Number.isFinite(d.histogram)) continue;
      const sign = d.histogram >= 0 ? 1 : -1;
      const x = ts.timeToCoordinate(d.time);
      if (x == null) { prevX = null; prevSign = null; continue; }

      if (prevX !== null && prevSign === sign) {
        ctx.fillStyle = sign > 0
          ? 'rgba(239,83,80,0.08)'   // 양수: 투명 빨강
          : 'rgba(21,101,192,0.08)'; // 음수: 투명 파랑
        ctx.fillRect(prevX, 0, x - prevX, rect.height);
      }
      prevX = x;
      prevSign = sign;
    }
  }, []);

  // ─── 차트 초기화 (once) ──────────────────────────────
  useEffect(() => {
    if (inited.current) return;
    if (!priceRef.current || !volumeRef.current || !macdRef.current || !ichiRef.current) return;
    inited.current = true;

    const w = (ref) => ref.current?.clientWidth || 400;

    const pc = createChart(priceRef.current, {
      ...BASE_OPTS,
      crosshair: { mode: CrosshairMode.Normal },
      height: 300, width: w(priceRef),
    });
    const vc = createChart(volumeRef.current, {
      ...BASE_OPTS,
      crosshair: { mode: CrosshairMode.Normal, horzLine: { visible: false, labelVisible: false } },
      height: 90, width: w(volumeRef),
    });
    const mc = createChart(macdRef.current, {
      ...BASE_OPTS,
      crosshair: { mode: CrosshairMode.Normal, horzLine: { visible: false, labelVisible: false } },
      height: 130, width: w(macdRef),
    });
    const ic = createChart(ichiRef.current, {
      ...BASE_OPTS,
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
      ...NO_PRICE_LINE,
    });

    // MA 라인들
    ser.current.maLines = MA_PERIODS.map((_, idx) =>
      pc.addSeries(LineSeries, {
        color: MA_COLORS[idx], lineWidth: 1,
        crosshairMarkerVisible: false,
        ...NO_PRICE_LINE,
      })
    );

    ser.current.vol = vc.addSeries(HistogramSeries, {
      color: '#ef5350', priceFormat: { type: 'volume' }, priceScaleId: 'vol',
    });
    vc.priceScale('vol').applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });

    ser.current.macdHist = mc.addSeries(HistogramSeries, { color: '#26a69a', ...NO_PRICE_LINE });
    ser.current.macdLine = mc.addSeries(LineSeries, { color: '#2962ff', lineWidth: 1, ...NO_PRICE_LINE });
    ser.current.signal   = mc.addSeries(LineSeries, { color: '#ff6d00', lineWidth: 1, ...NO_PRICE_LINE });

    ser.current.ichiCandle = ic.addSeries(CandlestickSeries, {
      upColor: '#ef5350', downColor: '#1565c0',
      borderVisible: false,
      wickUpColor: '#ef5350', wickDownColor: '#1565c0',
      ...NO_PRICE_LINE,
    });
    ser.current.tenkan = ic.addSeries(LineSeries, { color: '#e53935', lineWidth: 1, ...NO_PRICE_LINE });
    ser.current.kijun  = ic.addSeries(LineSeries, { color: '#1565c0', lineWidth: 1, ...NO_PRICE_LINE });
    ser.current.chikou = ic.addSeries(LineSeries, { color: '#9c27b0', lineWidth: 1, ...NO_PRICE_LINE });
    ser.current.spanA  = ic.addSeries(LineSeries, { color: '#43a047', lineWidth: 1, lineStyle: 2, ...NO_PRICE_LINE });
    ser.current.spanB  = ic.addSeries(LineSeries, { color: '#e53935', lineWidth: 1, lineStyle: 2, ...NO_PRICE_LINE });

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
      { c: pc, s: () => ser.current.candle },
      { c: vc, s: () => ser.current.vol },
      { c: mc, s: () => ser.current.macdHist },
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
                    ? `<span class="tt-ma" style="color:${MA_COLORS[idx]}">MA${p} <b>${Number(val).toLocaleString('ko-KR')}</b></span>`
                    : '';
                }).join('');

                tip.innerHTML =
                  `<div class="tt-date">${fmtTime(param.time)}</div>` +
                  `<div class="tt-row" style="color:${color}">` +
                  `<span>시가 <b>${Number(data.open).toLocaleString('ko-KR')}</b></span>` +
                  `<span>종가 <b>${Number(data.close).toLocaleString('ko-KR')}</b></span>` +
                  `</div>` +
                  `<div class="tt-row tt-gray">` +
                  `<span>고가 ${Number(data.high).toLocaleString('ko-KR')}</span>` +
                  `<span>저가 ${Number(data.low).toLocaleString('ko-KR')}</span>` +
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
        mainTrio.forEach(({ c: other, s }, j) => {
          if (j === i) return;
          const series = s();
          if (!series) return;
          try {
            if (param.time) {
              other.setCrosshairPosition(0, param.time, series);
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
    const r    = await fetch(`/api/ohlcv?symbol=${encodeURIComponent(sym)}&interval=${tf.interval}&limit=${lim}`);
    const contentType = r.headers.get('content-type') || '';
    if (!r.ok) {
      const body = contentType.includes('application/json') ? await r.json().catch(() => null) : await r.text();
      throw new Error(body?.error || body || `시세 조회 실패 (${r.status})`);
    }
    if (!contentType.includes('application/json')) {
      throw new Error('시세 API가 JSON 대신 HTML을 반환했습니다. 배포 API 연결을 확인하세요.');
    }
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return;

    // ② null 값 필터링
    const candles = safeCandleData(data);
    ser.current.candle.setData(candles);

    // MA 계산 및 팝업용 맵 저장
    maMaps.current = MA_PERIODS.map((period, idx) => {
      const maData = calculateMA(candles, period);
      ser.current.maLines[idx]?.setData(safeLineData(maData));
      return buildTimeMap(maData);
    });

    // 거래량
    const volData = candles
      .filter(d => d.volume != null && Number.isFinite(+d.volume))
      .map(d => ({ time: d.time, value: +d.volume, color: d.close >= d.open ? '#ef5350' : '#1565c0' }));
    ser.current.vol.setData(volData);

    // MACD
    const macd = calculateMACD(candles);
    macdDataRef.current = macd;
    ser.current.macdHist.setData(safeHistData(macd.filter(d => Number.isFinite(d.histogram)).map(d => ({ time: d.time, value: d.histogram, color: d.color }))));
    ser.current.macdLine.setData(safeLineData(macd.filter(d => Number.isFinite(d.macd   )).map(d => ({ time: d.time, value: d.macd    }))));
    ser.current.signal.setData(  safeLineData(macd.filter(d => Number.isFinite(d.signal )).map(d => ({ time: d.time, value: d.signal  }))));

    // ③ MACD 배경 그리기 (약간 지연 → 차트 렌더 후)
    requestAnimationFrame(() => drawMacdBackground());
  }, [drawMacdBackground]);

  const fetchIchi = useCallback(async (sym, tf, lim) => {
    if (!sym || !ser.current.ichiCandle) return;
    const r    = await fetch(`/api/ohlcv?symbol=${encodeURIComponent(sym)}&interval=${tf.interval}&limit=${lim}`);
    const contentType = r.headers.get('content-type') || '';
    if (!r.ok) {
      const body = contentType.includes('application/json') ? await r.json().catch(() => null) : await r.text();
      throw new Error(body?.error || body || `시세 조회 실패 (${r.status})`);
    }
    if (!contentType.includes('application/json')) {
      throw new Error('시세 API가 JSON 대신 HTML을 반환했습니다. 배포 API 연결을 확인하세요.');
    }
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return;

    const candles = safeCandleData(data);
    ser.current.ichiCandle.setData(candles);
    const ichi = calculateIchimoku(candles);

    const spanAData = ichi.map((d, i) => ({ time: candles[i].time, value: d.senkouA }));
    const spanBData = ichi.map((d, i) => ({ time: candles[i].time, value: d.senkouB }));

    ser.current.tenkan.setData(safeLineData(ichi.map((d, i) => ({ time: candles[i].time, value: d.tenkan }))));
    ser.current.kijun.setData( safeLineData(ichi.map((d, i) => ({ time: candles[i].time, value: d.kijun  }))));
    ser.current.chikou.setData(safeLineData(ichi.map((d, i) => ({ time: candles[i].time, value: d.chikou }))));
    ser.current.spanA.setData( safeLineData(spanAData));
    ser.current.spanB.setData( safeLineData(spanBData));
    drawCloud(spanAData, spanBData);
  }, [drawCloud]);

  // symbol/tf/limit 변경 시 로드
  useEffect(() => {
    if (!symbol) return;
    const timer = setTimeout(() => {
      setError('');
      setLoading(true);
    }, 0);
    Promise.all([
      fetchMain(symbol, mainTf, limit).catch(e => setError(e.message)),
      fetchIchi(symbol, ichiTf, limit + 80).catch(() => {}),
    ]).finally(() => {
      clearTimeout(timer);
      setLoading(false);
    });
    return () => clearTimeout(timer);
  }, [symbol, mainTf, ichiTf, limit, fetchMain, fetchIchi]);

  // ⑧ 실시간 업데이트: 분봉 1초, 일봉 5초
  useEffect(() => {
    if (!symbol) return;
    const isIntra = INTRA_INTERVALS.includes(mainTf.interval);
    const ms = isIntra ? 1000 : 5000;
    const t = setInterval(() => {
      if (isMarketOpen()) fetchMain(symbol, mainTf, limit).catch(() => {});
    }, ms);
    return () => clearInterval(t);
  }, [symbol, mainTf, limit, fetchMain]);

  useEffect(() => {
    if (!symbol) return;
    const isIntra = INTRA_INTERVALS.includes(ichiTf.interval);
    const ms = isIntra ? 1000 : 5000;
    const t = setInterval(() => {
      if (isMarketOpen()) fetchIchi(symbol, ichiTf, limit + 80).catch(() => {});
    }, ms);
    return () => clearInterval(t);
  }, [symbol, ichiTf, limit, fetchIchi]);

  const applyLimit = () => {
    const n = parseInt(limitInput, 10);
    if (n > 0 && n <= 2000) setLimit(n);
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

      {/* MA 범례 */}
      <div className="ma-legend">
        {MA_PERIODS.map((p, i) => (
          <span key={p} className="ma-legend-item" style={{ color: MA_COLORS[i] }}>MA{p}</span>
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
        </div>

        <div className="chart-section last">
          <div className="chart-label">일목균형표</div>
          <div ref={ichiRef} />
        </div>
      </div>
    </div>
  );
}
