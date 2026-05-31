import { useState, useEffect, useRef, useCallback } from 'react';

export default function StockSearch({ onSelect, placeholder }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      clearTimeout(timerRef.current);
    };
  }, []);

  const search = useCallback(async (q) => {
    if (!q || q.trim().length < 1) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok) {
        const body = contentType.includes('application/json') ? await res.json().catch(() => null) : await res.text();
        throw new Error(body?.error || body || `검색 실패 (${res.status})`);
      }
      if (!contentType.includes('application/json')) {
        throw new Error('서버가 JSON 대신 다른 응답을 반환했습니다.');
      }
      const data = await res.json();
      setResults(Array.isArray(data) ? data : []);
      setOpen(true);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(val), 400);
  };

  const handleSelect = (item) => {
    setQuery(item.name + (item.symbol ? ` (${item.symbol})` : ''));
    setOpen(false);
    onSelect({ symbol: item.symbol, name: item.name });
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && results.length > 0) {
      handleSelect(results[0]);
    }
  };

  return (
    <div className="search-wrapper" ref={wrapperRef}>
      <input
        type="text"
        className="search-input"
        placeholder={placeholder || '종목 검색...'}
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
        autoComplete="off"
      />
      {loading && <span className="search-spinner">⟳</span>}
      {open && results.length > 0 && (
        <div className="search-dropdown">
          {results.map((item) => (
            <div
              key={item.symbol}
              className="search-item"
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(item);
              }}
            >
              <span className="search-item-name">{item.name}</span>
              <span className="search-item-meta">
                {item.symbol} &middot; {item.exchange}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
