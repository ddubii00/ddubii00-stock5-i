import React, { useState, useEffect, useRef, useCallback } from 'react';
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

/** Format time for axis & tooltip: 2026.03.02 (no time) */
function fmtTime(time) {
  if (typeof time === 'string') {
    // "2026-03-02" or "2026-03-02T..." → "2026.03.02"
    return time.slice(0, 10).replace(/-/g, '.');
  }
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
  return typeof time === 'string' ? time.slice(0, 10) : String(time);
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (m >= 0 && m <= 390) || (m >= 870 && m <= 1260);
}

const BASE_OPTS = {
  layout: {
    background: { type: 'solid', color: 'transparent' },
    textColor: '#374151',
    attributionLogo: false,
  },
  grid: { vertLines: { color: '#f0f2f5' }, horzLines: { color: '#f0f2f5' } },
  // ③ Disable mouse-wheel zoom; allow horizontal drag pan only
  handleScale: { mouseWheel: false, pinch: false },
  handleScroll: { pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false, mouseWheel: false },
  rightPriceScale: { borderColor: '#e2e5ec', minimumWidth: 70 },
  timeScale: {
    borderColor: '#e2e5ec',
    timeVisible: false,   // ④ date only, no time
    secondsVisible: false,
    tickMarkFormatter: fmtTime,
  },
  localization: { timeFormatter: fmtTime },
};

export default function ChartColumn({ id, defaultSymbol, defaultName }) {
  const [symbol,     setSymbol]     = useState(null);
  const [symbolName, setSymbolName] = useState('');
  const [mainTf,     setMainTf]     = useState(MAIN_TFS[6]); // ① 일봉 default
  const [ichiTf,     setIchiTf]     = useState(ICHI_TFS[5]); // 일봉 default
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

  // Runtime refs (not state – avoid re-render)
  const charts      = useRef({});
  const ser         = useRef({});
  const maMaps      = useRef([]);      // ⑨ MA lookup maps for tooltip
  const cloudCanvas = useRef(null);
  const syncLock    = useRef(false);
  const xhairLock   = useRef(false);
  const inited      = useRef(false);

  // ─── Auto-load default symbol ─────────────────────────
  useEffect(() => {
    if (defaultSymbol) {
      setSymbol(defaultSymbol);
      setSymbolName(defaultName || defaultSymbol);
    }
  }, [defaultSymbol, defaultName]);

  // ─── Create charts once ───────────────────────────────
  useEffect(() => {
    if (inited.current) return;
    if (!priceRef.current || !volumeRef.current || !macdRef.current || !ichiRef.current) return;
    inited.current = true;

    const w = (ref) => ref.current.clientWidth;

    // Price chart – full crosshair
    const pc = createChart(priceRef.current, {
      ...BASE_OPTS,
      crosshair: { mode: CrosshairMode.Normal },
      height: 300, width: w(priceRef),
    });
    // Volume & MACD – vertical crosshair line only (no horizontal)
    const vc = createChart(volumeRef.current, {
      ...BASE_OPTS,
      crosshair: {
        mode: CrosshairMode.Normal,
        horzLine: { visible: false, labelVisible: false },
      },
      height: 90, width: w(volumeRef),
    });
    const mc = createChart(macdRef.current, {
      ...BASE_OPTS,
      crosshair: {
        mode: CrosshairMode.Normal,
        horzLine: { visible: false, labelVisible: false },
      },
      height: 130, width: w(macdRef),
    });
    const ic = createChart(ichiRef.current, {
      ...BASE_OPTS,
      crosshair: { mode: CrosshairMode.Normal },
      height: 240, width: w(ichiRef),
    });

    charts.current = { price: pc, volume: vc, macd: mc, ichi: ic };

    // ── Series ─────────────────────────────────────────
    // ② 음봉=파란색, 양봉=빨간색 (Korean convention)
    ser.current.candle = pc.addSeries(CandlestickSeries, {
      upColor: '#ef5350', downColor: '#1565c0',
      borderVisible: false,
      wickUpColor: '#ef5350', wickDownColor: '#1565c0',
    });

    // ⑨ MA lines on price chart
    ser.current.maLines = MA_PERIODS.map((_, idx) =>
      pc.addSeries(LineSeries, {
        color: MA_COLORS[idx], lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false,
      })
    );

    ser.current.vol = vc.addSeries(HistogramSeries, {
      color: '#ef5350', priceFormat: { type: 'volume' }, priceScaleId: 'vol',
    });
    vc.priceScale('vol').applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });

    ser.current.macdHist = mc.addSeries(HistogramSeries, { color: '#26a69a' });
    ser.current.macdLine = mc.addSeries(LineSeries, {
      color: '#2962ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });
    ser.current.signal = mc.addSeries(LineSeries, {
      color: '#ff6d00', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });

    ser.current.ichiCandle = ic.addSeries(CandlestickSeries, {
      upColor: '#ef5350', downColor: '#1565c0',
      borderVisible: false,
      wickUpColor: '#ef5350', wickDownColor: '#1565c0',
    });
    ser.current.tenkan = ic.addSeries(LineSeries, { color: '#e53935', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ser.current.kijun  = ic.addSeries(LineSeries, { color: '#1565c0', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ser.current.chikou = ic.addSeries(LineSeries, { color: '#9c27b0', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ser.current.spanA  = ic.addSeries(LineSeries, { color: '#43a047', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
    ser.current.spanB  = ic.addSeries(LineSeries, { color: '#e53935', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });

    // ⑧ Timescale sync: bidirectional among price/volume/macd
    const triCharts = [pc, vc, mc];
    triCharts.forEach((chart, i) => {
      chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
        if (syncLock.current || !range) return;
        syncLock.current = true;
        triCharts.forEach((other, j) => { if (j !== i) other.timeScale().setVisibleRange(range); });
        syncLock.current = false;
      });
    });

    // ⑦ Crosshair sync: all 3 top charts (price, volume, macd)
    const mainTrio = [
      { c: pc, s: () => ser.current.candle },
      { c: vc, s: () => ser.current.vol },
      { c: mc, s: () => ser.current.macdHist },
    ];

    mainTrio.forEach(({ c: chart }, i) => {
      chart.subscribeCrosshairMove((param) => {
        // ⑤⑨ Tooltip on price chart
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

                // Build MA rows for tooltip ⑨
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

        // ⑦ Sync crosshair on the other two top charts
        if (xhairLock.current) return;
        xhairLock.current = true;
        mainTrio.forEach(({ c: other, s }, j) => {
          if (j === i) return;
          const series = s();
          if (!series) return;
          param.time
            ? other.setCrosshairPosition(0, param.time, series)
            : other.clearCrosshairPosition();
        });
        xhairLock.current = false;
      });
    });

    // Resize
    const onResize = () => {
      [[pc, priceRef], [vc, volumeRef], [mc, macdRef], [ic, ichiRef]].forEach(([chart, ref]) => {
        if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
      });
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      inited.current = false;
      Object.values(charts.current).forEach(c => { try { c.remove(); } catch {} });
      charts.current = {};
      ser.current = {};
      maMaps.current = [];
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Ichimoku cloud canvas ────────────────────────────
  const drawCloud = useCallback((spanAData, spanBData) => {
    const container = ichiRef.current;
    const chart = charts.current.ichi;
    if (!container || !chart) return;
    if (cloudCanvas.current) { try { cloudCanvas.current.remove(); } catch {} }
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

  // ─── Fetch main 3 charts ──────────────────────────────
  const fetchMain = useCallback(async (sym, tf, lim) => {
    if (!sym || !ser.current.candle) return;
    const r    = await fetch(`/api/ohlcv?symbol=${encodeURIComponent(sym)}&interval=${tf.interval}&limit=${lim}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return;

    ser.current.candle.setData(data);

    // ⑨ Compute MA lines and store lookup maps
    maMaps.current = MA_PERIODS.map((period, idx) => {
      const maData = calculateMA(data, period);
      const validMa = maData.filter(d => d.value != null);
      ser.current.maLines[idx]?.setData(validMa);
      return buildTimeMap(maData);
    });

    ser.current.vol.setData(
      data
        .filter(d => d.volume != null && Number.isFinite(+d.volume))
        .map(d => ({ time: d.time, value: +d.volume, color: d.close >= d.open ? '#ef5350' : '#1565c0' }))
    );

    const macd = calculateMACD(data);
    ser.current.macdHist.setData(macd.filter(d => Number.isFinite(d.histogram)).map(d => ({ time: d.time, value: d.histogram, color: d.color })));
    ser.current.macdLine.setData(macd.filter(d => Number.isFinite(d.macd   )).map(d => ({ time: d.time, value: d.macd    })));
    ser.current.signal.setData(  macd.filter(d => Number.isFinite(d.signal )).map(d => ({ time: d.time, value: d.signal  })));
  }, []);

  const fetchIchi = useCallback(async (sym, tf, lim) => {
    if (!sym || !ser.current.ichiCandle) return;
    const r    = await fetch(`/api/ohlcv?symbol=${encodeURIComponent(sym)}&interval=${tf.interval}&limit=${lim}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return;

    ser.current.ichiCandle.setData(data);
    const ichi = calculateIchimoku(data);
    const ok   = arr => arr.filter(d => Number.isFinite(d.value));

    const spanAData = ichi.map((d, i) => ({ time: data[i].time, value: d.senkouA }));
    const spanBData = ichi.map((d, i) => ({ time: data[i].time, value: d.senkouB }));

    ser.current.tenkan.setData(ok(ichi.map((d, i) => ({ time: data[i].time, value: d.tenkan }))));
    ser.current.kijun.setData( ok(ichi.map((d, i) => ({ time: data[i].time, value: d.kijun  }))));
    ser.current.chikou.setData(ok(ichi.map((d, i) => ({ time: data[i].time, value: d.chikou }))));
    ser.current.spanA.setData( ok(spanAData));
    ser.current.spanB.setData( ok(spanBData));
    drawCloud(spanAData, spanBData);
  }, [drawCloud]);

  // Reload when symbol / tf / limit changes
  useEffect(() => {
    if (!symbol) return;
    setLoading(true);
    setError('');
    Promise.all([
      fetchMain(symbol, mainTf, limit).catch(e => setError(e.message)),
      fetchIchi(symbol, ichiTf, limit + 80).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [symbol, mainTf, ichiTf, limit, fetchMain, fetchIchi]);

  // Real-time refresh during market hours
  useEffect(() => {
    if (!symbol) return;
    const INTRA = ['1m','3m','5m','15m','30m','60m'];
    const ms = INTRA.includes(mainTf.interval) ? 15000 : 60000;
    const t = setInterval(() => { if (isMarketOpen()) fetchMain(symbol, mainTf, limit).catch(() => {}); }, ms);
    return () => clearInterval(t);
  }, [symbol, mainTf, limit, fetchMain]);

  useEffect(() => {
    if (!symbol) return;
    const INTRA = ['1m','3m','5m','15m','30m','60m'];
    const ms = INTRA.includes(ichiTf.interval) ? 15000 : 60000;
    const t = setInterval(() => { if (isMarketOpen()) fetchIchi(symbol, ichiTf, limit + 80).catch(() => {}); }, ms);
    return () => clearInterval(t);
  }, [symbol, ichiTf, limit, fetchIchi]);

  const applyLimit = () => {
    const n = parseInt(limitInput, 10);
    if (n > 0 && n <= 2000) setLimit(n);
  };

  const handleSelect = useCallback(({ symbol: sym, name }) => {
    setSymbol(sym);
    setSymbolName(name);
    setError('');
  }, []);

  // ─────────────────────────────────────────────────────
  return (
    <div className="chart-column">
      {/* Header */}
      <div className="column-header">
        <StockSearch onSelect={handleSelect} placeholder="종목 검색 (예: 하이닉스, AAPL)..." />

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

      {/* ⑨ MA legend */}
      <div className="ma-legend">
        {MA_PERIODS.map((p, i) => (
          <span key={p} className="ma-legend-item" style={{ color: MA_COLORS[i] }}>
            MA{p}
          </span>
        ))}
      </div>

      {/* Charts */}
      <div className="charts-area">
        <div className="chart-section" style={{ position: 'relative' }}>
          <div className="chart-label">캔들차트</div>
          <div ref={priceRef} />
          {/* ⑤⑨ OHLC + MA tooltip popup */}
          <div ref={tooltipRef} className="price-tooltip" />
        </div>

        {/* ⑥ spacer between top trio and ichimoku */}
        <div className="chart-section">
          <div className="chart-label">거래량</div>
          <div ref={volumeRef} />
        </div>

        <div className="chart-section">
          <div className="chart-label">MACD (12, 26, 9)</div>
          <div ref={macdRef} />
        </div>

        {/* ⑥ visual gap between two sets */}
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
