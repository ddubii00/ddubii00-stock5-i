import { Buffer } from 'node:buffer';
import { analyzeCharts } from './_analyze.js';

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST method required' });
  }

  try {
    const body = await readBody(req);
    const result = await analyzeCharts(body);
    return res.json({ result });
  } catch (e) {
    console.error('Analyze error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
