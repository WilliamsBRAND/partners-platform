import { getDb, json } from './_db.js';

function slugify(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export default async function handler(req, res) {
  const db = getDb();
  if (!db) return json(res, 500, { error: 'Database not configured.' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action') || '';

  try {
    switch (action) {
      case 'auth':
        return await auth(req, res);
      case 'all':
        return await all(req, res, db);
      case 'update':
        return await update(req, res, db);
      case 'offer':
        return await offer(req, res, db);
      default:
        return json(res, 400, { error: 'Unknown action. Valid: auth, all, update, offer.' });
    }
  } catch (e) {
    return json(res, 500, { error: 'Server error: ' + (e.message || '') });
  }
}

async function auth(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { password } = req.body || {};
  const adminPass = process.env.ADMIN_PASSWORD || '';
  if (!adminPass) return json(res, 500, { error: 'Admin password not configured.' });
  if (password !== adminPass) return json(res, 401, { error: 'Wrong password.' });
  return json(res, 200, { ok: true });
}

async function all(req, res, db) {
  const [partnersRes, clicksRes, convRes, pendingRes, payoutsRes, offersRes] = await Promise.all([
    db.from('partners').select('id, code, name, email, status, bank_name, account_number, account_name'),
    db.from('referrals').select('id', { count: 'exact', head: true }),
    db.from('conversions').select('id', { count: 'exact', head: true }),
    db.from('conversions').select('commission_kobo').eq('status', 'pending'),
    db.from('payouts').select('*').order('created_at', { ascending: false }).limit(100),
    db.from('offers').select('id, slug, name, status'),
  ]);

  const partnerIds = (partnersRes.data || []).map(p => p.id);
  let salesByPartner = {};
  let earnedByPartner = {};

  if (partnerIds.length) {
    const { data: allConv } = await db.from('conversions').select('partner_id, commission_kobo, status').in('partner_id', partnerIds);
    (allConv || []).forEach(c => {
      if (!salesByPartner[c.partner_id]) salesByPartner[c.partner_id] = 0;
      salesByPartner[c.partner_id]++;
      if (c.status === 'approved' || c.status === 'paid') {
        if (!earnedByPartner[c.partner_id]) earnedByPartner[c.partner_id] = 0;
        earnedByPartner[c.partner_id] += c.commission_kobo;
      }
    });
  }

  const partners = (partnersRes.data || []).map(p => ({ ...p, sale_count: salesByPartner[p.id] || 0, total_earned: earnedByPartner[p.id] || 0 }));
  const partnerMap = {};
  partners.forEach(p => { partnerMap[p.id] = p.code; });

  const commissions = [];
  if (partnerIds.length) {
    const { data: convData } = await db.from('conversions').select('*').in('partner_id', partnerIds).order('created_at', { ascending: false }).limit(100);
    const offerIds = [...new Set((convData || []).map(c => c.offer_id).filter(Boolean))];
    let offerMap = {};
    if (offerIds.length) {
      const { data: offers } = await db.from('offers').select('id, name').in('id', offerIds);
      (offers || []).forEach(o => { offerMap[o.id] = o.name; });
    }
    (convData || []).forEach(c => {
      commissions.push({ ...c, partner_code: partnerMap[c.partner_id] || '-', offer_name: offerMap[c.offer_id] || '-' });
    });
  }

  const payouts = [];
  (payoutsRes.data || []).forEach(p => { payouts.push({ ...p, partner_code: partnerMap[p.partner_id] || '-' }); });

  return json(res, 200, {
    ok: true,
    partners,
    offers: offersRes.data || [],
    totalClicks: clicksRes.count || 0,
    totalConversions: convRes.count || 0,
    pendingPayout: (pendingRes.data || []).reduce((s, c) => s + c.commission_kobo, 0),
    commissions,
    payouts,
  });
}

async function update(req, res, db) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { type, id, status } = req.body || {};
  if (!type || !id || !status) return json(res, 400, { error: 'type, id, and status required.' });

  const table = type === 'commission' ? 'conversions' : type === 'payout' ? 'payouts' : null;
  if (!table) return json(res, 400, { error: 'Invalid type.' });

  const validStatuses = {
    conversions: ['pending', 'approved', 'rejected', 'paid'],
    payouts: ['pending', 'processing', 'completed', 'failed'],
  };
  if (!validStatuses[table].includes(status)) return json(res, 400, { error: 'Invalid status.' });

  const updateObj = { status };
  if (table === 'conversions' && status === 'approved') updateObj.approved_at = new Date().toISOString();
  if (table === 'conversions' && status === 'paid') updateObj.paid_at = new Date().toISOString();
  if (table === 'payouts' && status === 'completed') updateObj.completed_at = new Date().toISOString();

  const { error } = await db.from(table).update(updateObj).eq('id', id);
  if (error) return json(res, 500, { error: 'Update failed.' });
  return json(res, 200, { ok: true });
}

async function offer(req, res, db) {
  if (req.method === 'GET') {
    const { data, error } = await db.from('offers').select('*').order('created_at', { ascending: true });
    if (error) return json(res, 500, { error: 'Failed to load offers.' });
    return json(res, 200, { ok: true, offers: data || [] });
  }

  if (req.method === 'POST') {
    const { name, description, price_kobo, commission_rate, checkout_url, status } = req.body || {};
    if (!name || !checkout_url) return json(res, 400, { error: 'Name and product URL are required.' });

    const slug = slugify(name);
    let finalSlug = slug || 'offer';
    const { data: dup } = await db.from('offers').select('id').eq('slug', finalSlug).maybeSingle();
    if (dup) finalSlug = slug + '-' + Math.random().toString(36).slice(2, 6);

    const { data, error } = await db.from('offers').insert({
      slug: finalSlug,
      name: name.trim(),
      description: description || null,
      price_kobo: parseInt(price_kobo, 10) || 0,
      commission_rate: commission_rate != null ? parseFloat(commission_rate) : 0.30,
      checkout_url: checkout_url.trim(),
      status: status === 'inactive' ? 'inactive' : 'active',
    }).select('*').single();

    if (error) return json(res, 500, { error: 'Failed to create offer.' });
    return json(res, 200, { ok: true, offer: data });
  }

  if (req.method === 'PATCH') {
    const { id, name, description, price_kobo, commission_rate, checkout_url, status } = req.body || {};
    if (!id) return json(res, 400, { error: 'id required.' });

    const u = {};
    if (name !== undefined) u.name = name.trim();
    if (description !== undefined) u.description = description;
    if (price_kobo !== undefined) u.price_kobo = parseInt(price_kobo, 10) || 0;
    if (commission_rate !== undefined) u.commission_rate = parseFloat(commission_rate);
    if (checkout_url !== undefined) u.checkout_url = checkout_url.trim();
    if (status !== undefined) u.status = status === 'inactive' ? 'inactive' : 'active';

    const { data, error } = await db.from('offers').update(u).eq('id', id).select('*').single();
    if (error) return json(res, 500, { error: 'Failed to update offer.' });
    return json(res, 200, { ok: true, offer: data });
  }

  return json(res, 405, { error: 'Method not allowed.' });
}
