import { fetchRealtimeQuote } from './_shared.js';

export default async function handler(req, res) {
  try {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });

    const quote = await fetchRealtimeQuote(symbol);
    if (!quote) return res.status(404).json({ error: 'quote not found' });
    return res.json(quote);
  } catch (e) {
    console.error(`Quote error [${req.query.symbol}]:`, e.message);
    return res.status(500).json({ error: e.message });
  }
}
