// Public referral click tracking. Called by each product's checkout page
// (e.g. NEXORA's checkout.html) with ?code=<affiliate code>&product=<slug>.
// Records a click + sets a first-party partner cookie for checkout attribution.
import { getDb, json } from './_db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = getDb();
  if (!db) return json(res, 500, { error: 'Database not configured.' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = url.searchParams.get('code') || '';
  const slug = url.searchParams.get('product') || url.searchParams.get('offer') || '';
  if (!code) return json(res, 400, { error: 'code required.' });

  const { data: partner } = await db.from('partners')
    .select('id').eq('code', code).eq('status', 'active').maybeSingle();
  if (!partner) return json(res, 200, { ok: true, tracked: false });

  let productId = null;
  if (slug) {
    const { data: product } = await db.from('products')
      .select('id').eq('slug', slug).eq('status', 'active').maybeSingle();
    if (product) productId = product.id;
  }

  const ip = req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : '';
  const ua = req.headers['user-agent'] || '';

  await db.from('referrals').insert({
    partner_id: partner.id,
    product_id: productId,
    ip_address: ip,
    user_agent: ua,
  });

  return json(res, 200, { ok: true, tracked: true });
}
