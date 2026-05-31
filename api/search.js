import { INDEX_MAP, loadKrxList, yahooFinance } from './_shared.js';

export default async function handler(req, res) {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 1) return res.json([]);
    const query = q.trim().toLowerCase();
    const upperQ = q.trim().toUpperCase().replace(/\s/g, '');

    const indexMatches = Object.entries(INDEX_MAP)
      .filter(([key]) => key.includes(upperQ) || upperQ.includes(key.slice(0, 3)))
      .map(([, v]) => ({ symbol: v.symbol, name: v.name, exchange: v.exchange, type: 'INDEX' }));

    const krxList = await loadKrxList();
    const krxMatches = krxList
      .filter(x => x.name.toLowerCase().includes(query) || x.code.includes(query))
      .slice(0, 15)
      .map(x => ({
        symbol: `${x.code}.KS`,
        name: x.name,
        exchange: x.marketType === '코스닥' ? 'KOSDAQ' : 'KOSPI',
        type: 'KR',
      }));

    let usMatches = [];
    try {
      const result = await yahooFinance.search(q, { quotesCount: 10 });
      usMatches = (result.quotes || [])
        .filter(x => ['EQUITY', 'ETF', 'INDEX', 'FUTURE'].includes(x.quoteType) && !x.symbol.match(/\.(KS|KQ|T|HK|AX)$/))
        .slice(0, 10)
        .map(x => ({
          symbol: x.symbol,
          name: x.shortname || x.longname || x.symbol,
          exchange: x.exchange || 'US',
          type: x.quoteType === 'INDEX' ? 'INDEX' : 'US',
        }));
    } catch (e) {
      console.error('Yahoo search error:', e.message);
    }

    return res.json([...indexMatches, ...krxMatches, ...usMatches]);
  } catch (e) {
    console.error('Search error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

