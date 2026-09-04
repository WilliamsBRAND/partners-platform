import { getDb, json } from './_db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = getDb();
  if (!db) return json(res, 500, { error: 'Database not configured.' });

  const { data, error } = await db
    .from('offers')
    .select('id, slug, name, description, price_kobo, commission_rate, checkout_url, status')
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) return json(res, 500, { error: 'Failed to load offers.' });

  return json(res, 200, { ok: true, offers: data || [] });
}
