// Partners public leaderboard — ranks partners by commissions (pending, approved, processing, paid)
import { getDb, json } from './_db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = getDb();
  if (!db) return json(res, 500, { error: 'Database not configured.' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const productId = url.searchParams.get('product_id') || url.searchParams.get('offer_id') || '';

  try {
    const { data: products } = await db.from('products')
      .select('id, name, slug').eq('status', 'active').order('created_at', { ascending: true });

    let commQuery = db.from('commissions')
      .select('affiliate_id, commission_kobo, status')
      .in('status', ['pending', 'approved', 'processing', 'paid']);
    if (productId) commQuery = commQuery.eq('product_id', productId);
    const { data: comms, error: commErr } = await commQuery;
    if (commErr) return json(res, 500, { error: 'Failed to load leaderboard data.' });

    const earnedByPartner = {};
    const countByPartner = {};
    (comms || []).forEach(c => {
      if (c.affiliate_id) {
        earnedByPartner[c.affiliate_id] = (earnedByPartner[c.affiliate_id] || 0) + (c.commission_kobo || 0);
        countByPartner[c.affiliate_id] = (countByPartner[c.affiliate_id] || 0) + 1;
      }
    });

    const partnerIds = Object.keys(earnedByPartner);
    let nameMap = {};
    if (partnerIds.length) {
      const { data: partners } = await db.from('partners')
        .select('id, name, code').eq('status', 'active').in('id', partnerIds);
      (partners || []).forEach(p => { nameMap[p.id] = { name: p.name, code: p.code }; });
    }

    const rows = partnerIds.map(id => ({
      partner_id: id,
      name: (nameMap[id] && nameMap[id].name) || 'Partner',
      code: (nameMap[id] && nameMap[id].code) || '-',
      earned_kobo: earnedByPartner[id] || 0,
      sales: countByPartner[id] || 0,
    }));
    rows.sort((a, b) => b.sales !== a.sales ? b.sales - a.sales : b.earned_kobo - a.earned_kobo);

    return json(res, 200, { ok: true, products: products || [], top: rows });
  } catch (e) {
    return json(res, 500, { error: 'Server error: ' + (e.message || '') });
  }
}
