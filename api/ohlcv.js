import { fetchKoreanOhlcv, fetchUsOhlcv } from './_shared.js';

export default async function handler(req, res) {
  try {
    const { symbol, interval = 'day', limit = 300 } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });

    const lim = Math.min(Number(limit) || 300, 2000);
    let data;

    const isKorean = /^\d{6}$/.test(symbol) || symbol.endsWith('.KS') || symbol.endsWith('.KQ');
    const isIndex = symbol.startsWith('^');
    const code = symbol.replace(/\.(KS|KQ)$/, '');

    if (isIndex) {
      data = await fetchUsOhlcv(symbol, interval, lim);
    } else if (isKorean && interval === 'day') {
      data = await fetchKoreanOhlcv(code, interval, lim);
      data = data.map(x => ({
        ...x,
        time: x.date ? x.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : x.time,
      }));
    } else if (isKorean) {
      data = await fetchUsOhlcv(code + '.KS', interval, lim);
    } else {
      data = await fetchUsOhlcv(symbol, interval, lim);
    }

    const seen = new Set();
    data = data
      .filter(d => {
        if (seen.has(d.time)) return false;
        seen.add(d.time);
        return true;
      })
      .sort((a, b) => (a.time > b.time ? 1 : -1));

    return res.json(data);
  } catch (e) {
    console.error(`OHLCV error [${req.query.symbol}]:`, e.message);
    return res.status(500).json({ error: e.message });
  }
}

