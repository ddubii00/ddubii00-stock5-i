import React from 'react';
import ChartColumn from './components/ChartColumn';
import './index.css';

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">📈 Stock Dashboard</h1>
        <p className="app-subtitle">종목을 선택하면 차트가 표시됩니다</p>
      </header>
      <div className="dashboard-grid">
        <ChartColumn id="col-1" defaultSymbol="000660.KS" defaultName="SK하이닉스" />
        <ChartColumn id="col-2" defaultSymbol="005930.KS" defaultName="삼성전자" />
      </div>
    </div>
  );
}

export default App;
