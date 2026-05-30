import React from 'react';
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

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">📈 Stock Dashboard</h1>
        <p className="app-subtitle">한국·미국 주식 및 지수 차트 | 종목을 검색해보세요</p>
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
