// Partners public leaderboard — ranks partners by approved commissions, optionally per offer.
import { getDb, json } from './_db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = getDb();
  if (!db) return json(res, 500, { error: 'Database not configured.' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const offerId = url.searchParams.get('offer_id') || '';

  try {
    // Active offers (for the per-product tabs / filter validation)
    const { data: offers } = await db.from('offers')
      .select('id, name').eq('status', 'active').order('created_at', { ascending: true });

    let convQuery = db.from('conversions')
      .select('partner_id, commission_kobo')
      .in('status', ['approved', 'paid']);
    if (offerId) convQuery = convQuery.eq('offer_id', offerId);
    const { data: convs, error: convErr } = await convQuery;
    if (convErr) return json(res, 500, { error: 'Failed to load leaderboard data.' });

    const earnedByPartner = {};
    const countByPartner = {};
    (convs || []).forEach(c => {
      earnedByPartner[c.partner_id] = (earnedByPartner[c.partner_id] || 0) + c.commission_kobo;
      countByPartner[c.partner_id] = (countByPartner[c.partner_id] || 0) + 1;
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
      earned_kobo: earnedByPartner[id],
      sales: countByPartner[id],
    }));
    rows.sort((a, b) => b.earned_kobo - a.earned_kobo);

    return json(res, 200, { ok: true, offers: offers || [], top: rows });
  } catch (e) {
    return json(res, 500, { error: 'Server error: ' + (e.message || '') });
  }
}
