// Public product catalog (marketplace view). Reads active products.
import { getDb, json } from './_db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = getDb();
  if (!db) return json(res, 500, { error: 'Database not configured.' });

  const { data, error } = await db
    .from('products')
    .select('id, slug, name, tagline, description, image_url, price_kobo, commission_type, commission_value, checkout_url, status')
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) return json(res, 500, { error: 'Failed to load products.' });

  const products = (data || []).map(p => ({
    id: p.id, slug: p.slug, name: p.name, tagline: p.tagline, description: p.description,
    image_url: p.image_url, price_kobo: p.price_kobo, checkout_url: p.checkout_url, status: p.status,
    commission_type: p.commission_type,
    commission_value: p.commission_value,
    // Back-compat field used by the legacy homepage
    commission_rate: p.commission_type === 'fixed' ? 0 : (parseFloat(p.commission_value || 0) / 100),
    commission_label: p.commission_type === 'fixed' ? '₦' + (+p.commission_value).toLocaleString() : Math.round(+p.commission_value) + '%',
  }));

  return json(res, 200, { ok: true, products, offers: products });
}
