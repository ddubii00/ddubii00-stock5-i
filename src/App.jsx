import { useCallback, useEffect, useState } from 'react';
import ChartColumn from './components/ChartColumn';
import './index.css';

// 7. 4개 차트 세트 (2×2 그리드)
// 1. 마지막 선택 종목 기억 → localStorage 키를 각 컬럼마다 부여
const COLUMNS = [
  { id: 'col-1', defaultSymbol: '000660.KS', defaultName: 'SK하이닉스' },
  { id: 'col-2', defaultSymbol: '005930.KS', defaultName: '삼성전자' },
  { id: 'col-3', defaultSymbol: '^GSPC',     defaultName: 'S&P 500' },
  { id: 'col-4', defaultSymbol: '^KS11',     defaultName: 'KOSPI 종합' },
];

function formatFixed(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatSignedFixed(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const sign = n > 0 ? '+' : '';
  return `${sign}${formatFixed(n, digits)}`;
}

function formatSignedPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function timeParts(timeZone) {
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

function isWeekday(weekday) {
  return weekday !== 'Sat' && weekday !== 'Sun';
}

function isKrxUpdateWindow() {
  const { weekday, minutes } = timeParts('Asia/Seoul');
  return isWeekday(weekday) && minutes >= 9 * 60 && minutes <= 15 * 60 + 31;
}

function isUsOpen() {
  const { weekday, minutes } = timeParts('America/New_York');
  return isWeekday(weekday) && minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

function App() {
  const [marketSummary, setMarketSummary] = useState({ kospi: null, kosdaq: null, nasdaq: null, usdKrw: null });

  const fetchQuote = useCallback(async (symbol, signal) => {
    const response = await fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}`, { signal });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('application/json')) return null;

    const data = await response.json();
    return data && Number.isFinite(Number(data.price)) ? data : null;
  }, []);

  const refreshMarketSummary = useCallback(async (signal) => {
    const [kospi, kosdaq, nasdaq, usdKrw] = await Promise.all([
      fetchQuote('^KS11', signal).catch(() => null),
      fetchQuote('^KQ11', signal).catch(() => null),
      fetchQuote('^IXIC', signal).catch(() => null),
      fetchQuote('KRW=X', signal).catch(() => null),
    ]);

    setMarketSummary((current) => ({
      kospi: kospi || current.kospi,
      kosdaq: kosdaq || current.kosdaq,
      nasdaq: nasdaq || current.nasdaq,
      usdKrw: usdKrw || current.usdKrw,
    }));
  }, [fetchQuote]);

  useEffect(() => {
    const controller = new AbortController();
    const update = () => refreshMarketSummary(controller.signal).catch(() => {});

    update();
    let timer = null;

    if (isKrxUpdateWindow() || isUsOpen()) {
      timer = setInterval(() => {
        if (!isKrxUpdateWindow() && !isUsOpen()) {
          clearInterval(timer);
          timer = null;
          return;
        }
        update();
      }, isKrxUpdateWindow() ? 1000 : 3000);
    }

    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [refreshMarketSummary]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="market-summary" aria-label="시장 요약">
          {marketSummary.usdKrw && (
            <span className={`market-item ${marketSummary.usdKrw.change >= 0 ? 'up' : 'down'}`}>
              달러/원<strong className="market-price">{formatFixed(marketSummary.usdKrw.price, 2)}</strong>
              {Number.isFinite(marketSummary.usdKrw.changePct) && Number.isFinite(marketSummary.usdKrw.change) && (
                <span className="market-change market-change-fixed">
                  ({formatSignedPercent(marketSummary.usdKrw.changePct)}, {formatSignedFixed(marketSummary.usdKrw.change, 2)})
                </span>
              )}
            </span>
          )}
          {marketSummary.kospi && (
            <span className={`market-item ${marketSummary.kospi.change >= 0 ? 'up' : 'down'}`}>
              KOSPI<strong className="market-price">{formatFixed(marketSummary.kospi.price, 2)}</strong>
              {Number.isFinite(marketSummary.kospi.changePct) && Number.isFinite(marketSummary.kospi.change) && (
                <span className="market-change market-change-fixed">
                  ({formatSignedPercent(marketSummary.kospi.changePct)}, {formatSignedFixed(marketSummary.kospi.change, 2)})
                </span>
              )}
            </span>
          )}
          {marketSummary.kosdaq && (
            <span className={`market-item ${marketSummary.kosdaq.change >= 0 ? 'up' : 'down'}`}>
              KOSDAQ<strong className="market-price">{formatFixed(marketSummary.kosdaq.price, 2)}</strong>
              {Number.isFinite(marketSummary.kosdaq.changePct) && Number.isFinite(marketSummary.kosdaq.change) && (
                <span className="market-change market-change-fixed">
                  ({formatSignedPercent(marketSummary.kosdaq.changePct)}, {formatSignedFixed(marketSummary.kosdaq.change, 2)})
                </span>
              )}
            </span>
          )}
          {marketSummary.nasdaq && (
            <span className={`market-item ${marketSummary.nasdaq.change >= 0 ? 'up' : 'down'}`}>
              나스닥<strong className="market-price">{formatFixed(marketSummary.nasdaq.price, 2)}</strong>
              {Number.isFinite(marketSummary.nasdaq.changePct) && Number.isFinite(marketSummary.nasdaq.change) && (
                <span className="market-change market-change-fixed">
                  ({formatSignedPercent(marketSummary.nasdaq.changePct)}, {formatSignedFixed(marketSummary.nasdaq.change, 2)})
                </span>
              )}
            </span>
          )}
        </div>
      </header>
      <div className="dashboard-grid">
        {COLUMNS.map(col => (
          <ChartColumn
            key={col.id}
            id={col.id}
            defaultSymbol={col.defaultSymbol}
            defaultName={col.defaultName}
          />
        ))}
      </div>
    </div>
  );
}

export default App;
