import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { createChart, CrosshairMode } from 'lightweight-charts';

const LightweightChart = forwardRef(({
  data,
  type = 'candlestick', // 'candlestick', 'histogram', 'line', 'macd', 'ichimoku'
  height = 200,
  title = '',
  syncGroup
}, ref) => {
  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRefs = useRef({});

  useImperativeHandle(ref, () => ({
    getChart: () => chartRef.current
  }));

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const handleResize = () => {
      if (chartRef.current) {
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: height,
      layout: {
        background: { color: 'transparent' },
        textColor: '#d1d4dc',
      },
      grid: {
        vertLines: { color: 'rgba(42, 46, 57, 0.5)' },
        horzLines: { color: 'rgba(42, 46, 57, 0.5)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
      },
    });

    chartRef.current = chart;

    if (type === 'candlestick') {
      const series = chart.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
      });
      seriesRefs.current.main = series;
    } else if (type === 'histogram') {
      const series = chart.addHistogramSeries({
        color: '#26a69a',
        priceFormat: { type: 'volume' },
        priceScaleId: '',
      });
      chart.priceScale('').applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
      });
      seriesRefs.current.main = series;
    } else if (type === 'macd') {
      seriesRefs.current.histogram = chart.addHistogramSeries({
        color: '#26a69a',
      });
      seriesRefs.current.macd = chart.addLineSeries({
        color: '#2962FF',
        lineWidth: 2,
      });
      seriesRefs.current.signal = chart.addLineSeries({
        color: '#FF6D00',
        lineWidth: 2,
      });
    } else if (type === 'ichimoku') {
      seriesRefs.current.candlestick = chart.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
      });
      seriesRefs.current.tenkan = chart.addLineSeries({ color: '#2962FF', lineWidth: 1 });
      seriesRefs.current.kijun = chart.addLineSeries({ color: '#b71c1c', lineWidth: 1 });
      seriesRefs.current.spanA = chart.addLineSeries({ color: '#26a69a', lineWidth: 1, lineStyle: 2 });
      seriesRefs.current.spanB = chart.addLineSeries({ color: '#ef5350', lineWidth: 1, lineStyle: 2 });
    }

    // Sync group logic
    if (syncGroup) {
      syncGroup.push(chart);
      chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
        syncGroup.forEach((otherChart) => {
          if (otherChart !== chart) {
            const currentRange = otherChart.timeScale().getVisibleRange();
            if (currentRange && range && (currentRange.from !== range.from || currentRange.to !== range.to)) {
              otherChart.timeScale().setVisibleRange(range);
            }
          }
        });
      });
    }

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (syncGroup) {
        const index = syncGroup.indexOf(chart);
        if (index !== -1) syncGroup.splice(index, 1);
      }
      chart.remove();
    };
  }, [type, height, syncGroup]);

  // Update data effect
  useEffect(() => {
    if (!data || data.length === 0 || !seriesRefs.current) return;

    if (type === 'candlestick') {
      seriesRefs.current.main.setData(data);
    } else if (type === 'histogram') {
      const volumeData = data.map(d => ({
        time: d.time,
        value: d.volume,
        color: d.close >= d.open ? '#26a69a' : '#ef5350'
      }));
      seriesRefs.current.main.setData(volumeData);
    } else if (type === 'macd') {
      const histData = data.map(d => ({ time: d.time, value: d.histogram, color: d.color }));
      const macdData = data.map(d => ({ time: d.time, value: d.macd })).filter(d => d.value !== null);
      const signalData = data.map(d => ({ time: d.time, value: d.signal })).filter(d => d.value !== null);
      
      seriesRefs.current.histogram.setData(histData);
      seriesRefs.current.macd.setData(macdData);
      seriesRefs.current.signal.setData(signalData);
    } else if (type === 'ichimoku') {
      if (data.ohlcv && data.ichimoku) {
        seriesRefs.current.candlestick.setData(data.ohlcv);
        
        const tenkanData = data.ichimoku.map(d => ({ time: d.time, value: d.tenkanSen })).filter(d => d.value !== null);
        const kijunData = data.ichimoku.map(d => ({ time: d.time, value: d.kijunSen })).filter(d => d.value !== null);
        const spanAData = data.ichimoku.map(d => ({ time: d.time, value: d.senkouSpanA })).filter(d => d.value !== null);
        const spanBData = data.ichimoku.map(d => ({ time: d.time, value: d.senkouSpanB })).filter(d => d.value !== null);

        seriesRefs.current.tenkan.setData(tenkanData);
        seriesRefs.current.kijun.setData(kijunData);
        seriesRefs.current.spanA.setData(spanAData);
        seriesRefs.current.spanB.setData(spanBData);
      }
    }
  }, [data, type]);

  return (
    <div className="chart-container">
      {title && <div className="chart-title">{title}</div>}
      <div ref={chartContainerRef} style={{ width: '100%', height: `${height}px` }} />
    </div>
  );
});

export default LightweightChart;
