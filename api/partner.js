import { getDb, json } from './_db.js';

function generateCode(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const rand = Math.random().toString(36).slice(2, 6);
  return (base + rand).slice(0, 12);
}

function koboToNaira(kobo) {
  return (kobo / 100).toFixed(2);
}

async function notifyWithdrawal(db, partner, payoutRow) {
  const webhook = process.env.WITHDRAWAL_WEBHOOK_URL || '';
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'withdrawal_requested',
        subject: 'New Withdrawal Request',
        to: process.env.WITHDRAWAL_EMAIL || 'sodunketomide@gmail.com',
        partner_name: partner.name,
        partner_email: partner.email,
        partner_code: partner.code,
        bank_name: partner.bank_name || '-',
        account_number: partner.account_number || '-',
        account_name: partner.account_name || '-',
        amount_naira: koboToNaira(payoutRow.amount_kobo),
        requested_at: payoutRow.created_at,
      }),
    });
  } catch (e) {
    // notification failure must not break the withdrawal request
  }
}

export default async function handler(req, res) {
  const db = getDb();
  if (!db) return json(res, 500, { error: 'Database not configured.' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action') || '';

  try {
    switch (action) {
      case 'register':
        return await register(req, res, db, url);
      case 'login':
        return await login(req, res, db, url);
      case 'dashboard':
        return await dashboard(req, res, db, url);
      case 'stats':
        return await stats(req, res, db, url);
      case 'commissions':
        return await commissions(req, res, db, url);
      case 'withdraw':
        return await withdraw(req, res, db, url);
      case 'payouts':
        return await payouts(req, res, db, url);
      case 'products':
        return await products(req, res, db, url);
      default:
        return json(res, 400, { error: 'Unknown action. Valid: register, login, dashboard, stats, commissions, withdraw, payouts, products.' });
    }
  } catch (e) {
    return json(res, 500, { error: 'Server error: ' + (e.message || '') });
  }
}

async function register(req, res, db, url) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { name, email, phone, bank_name, account_number, account_name } = req.body || {};
  if (!name || !email) return json(res, 400, { error: 'Name and email are required.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'Invalid email.' });
  if (!bank_name || !account_number || !account_name) {
    return json(res, 400, { error: 'Bank name, account number, and account name are required.' });
  }

  const { data: existing } = await db.from('partners').select('id').eq('email', email.toLowerCase()).maybeSingle();
  if (existing) return json(res, 409, { error: 'An account with this email already exists.' });

  let code = generateCode(name);
  for (let i = 0; i < 10; i++) {
    const { data: dup } = await db.from('partners').select('id').eq('code', code).maybeSingle();
    if (!dup) break;
    code = generateCode(name);
  }

  const { data, error } = await db.from('partners').insert({
    code,
    name: name.trim(),
    email: email.toLowerCase().trim(),
    phone: phone || null,
    bank_name: bank_name.trim(),
    account_number: account_number.trim(),
    account_name: account_name.trim(),
  }).select('id, code, name, email, bank_name, account_number, account_name').single();

  if (error) return json(res, 500, { error: 'Failed to create account.' });
  const siteUrl = process.env.SITE_URL || 'https://nexora.tomidewilliams.com';
  return json(res, 200, { ok: true, ...data, siteUrl });
}

async function login(req, res, db, url) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { email } = req.body || {};
  if (!email) return json(res, 400, { error: 'Email is required.' });

  const { data } = await db.from('partners')
    .select('id, code, name, email, bank_name, account_number, account_name')
    .eq('email', email.toLowerCase().trim()).eq('status', 'active').maybeSingle();

  if (!data) return json(res, 404, { error: 'No active partner account found with that email.' });
  const siteUrl = process.env.SITE_URL || 'https://nexora.tomidewilliams.com';
  return json(res, 200, { ok: true, ...data, siteUrl });
}

async function dashboard(req, res, db, url) {
  const partnerId = url.searchParams.get('partner_id');
  if (!partnerId) return json(res, 400, { error: 'partner_id required.' });

  const [clicksRes, convRes, payoutsRes, partnerRes, offersRes] = await Promise.all([
    db.from('referrals').select('id', { count: 'exact', head: true }).eq('partner_id', partnerId),
    db.from('conversions').select('id, offer_id, customer_email, amount_kobo, commission_kobo, status, created_at')
      .eq('partner_id', partnerId).order('created_at', { ascending: false }).limit(20),
    db.from('payouts').select('amount_kobo, status').eq('partner_id', partnerId),
    db.from('partners').select('id, code, name, email').eq('id', partnerId).maybeSingle(),
    db.from('offers').select('*').eq('status', 'active').order('created_at', { ascending: true })
  ]);

  const clicks = clicksRes.count || 0;
  const recentConversions = convRes.data || [];

  const { data: allConvs } = await db.from('conversions').select('commission_kobo, status').eq('partner_id', partnerId);
  const convList = allConvs || recentConversions;

  const earned = convList.filter(c => c.status === 'approved' || c.status === 'paid').reduce((s, c) => s + c.commission_kobo, 0);
  const pending = convList.filter(c => c.status === 'pending').reduce((s, c) => s + c.commission_kobo, 0);

  const payoutRows = payoutsRes.data || [];
  const paidPayouts = payoutRows.filter(p => p.status === 'processing' || p.status === 'completed')
    .reduce((s, p) => s + p.amount_kobo, 0);
  const requestedWithdrawals = payoutRows.filter(p => p.status === 'pending')
    .reduce((s, p) => s + p.amount_kobo, 0);

  const available = Math.max(0, earned - paidPayouts - requestedWithdrawals);

  const offers = offersRes.data || [];
  const offerMap = {};
  offers.forEach(o => { offerMap[o.id] = o.name; });

  const commissionsList = recentConversions.map(c => ({
    ...c,
    offer_name: offerMap[c.offer_id] || '-'
  }));

  const siteUrl = process.env.SITE_URL || 'https://nexora.tomidewilliams.com';

  return json(res, 200, {
    ok: true,
    stats: {
      clicks,
      conversions: convList.length,
      earned_kobo: earned,
      pending_kobo: pending,
      available_kobo: available,
      requested_withdrawals_kobo: requestedWithdrawals,
    },
    partner: partnerRes.data || null,
    offers,
    commissions: commissionsList,
    siteUrl
  }, { 'Cache-Control': 'no-store' });
}

async function stats(req, res, db, url) {
  const partnerId = url.searchParams.get('partner_id');
  if (!partnerId) return json(res, 400, { error: 'partner_id required.' });

  const [clicksRes, convRes, payoutsRes, partnerRes] = await Promise.all([
    db.from('referrals').select('id', { count: 'exact', head: true }).eq('partner_id', partnerId),
    db.from('conversions').select('commission_kobo, status').eq('partner_id', partnerId),
    db.from('payouts').select('amount_kobo, status').eq('partner_id', partnerId),
    db.from('partners').select('code').eq('id', partnerId).maybeSingle(),
  ]);

  const clicks = clicksRes.count || 0;
  const conversions = convRes.data || [];
  const earned = conversions.filter(c => c.status === 'approved' || c.status === 'paid').reduce((s, c) => s + c.commission_kobo, 0);
  const pending = conversions.filter(c => c.status === 'pending').reduce((s, c) => s + c.commission_kobo, 0);

  const payoutRows = payoutsRes.data || [];
  const paidPayouts = payoutRows.filter(p => p.status === 'processing' || p.status === 'completed')
    .reduce((s, p) => s + p.amount_kobo, 0);
  const requestedWithdrawals = payoutRows.filter(p => p.status === 'pending')
    .reduce((s, p) => s + p.amount_kobo, 0);

  const available = Math.max(0, earned - paidPayouts - requestedWithdrawals);

  return json(res, 200, {
    ok: true,
    clicks,
    conversions: conversions.length,
    earned_kobo: earned,
    pending_kobo: pending,
    available_kobo: available,
    requested_withdrawals_kobo: requestedWithdrawals,
    code: partnerRes.data ? partnerRes.data.code : null,
  }, { 'Cache-Control': 'no-store' });
}

async function commissions(req, res, db, url) {
  const partnerId = url.searchParams.get('partner_id');
  if (!partnerId) return json(res, 400, { error: 'partner_id required.' });

  const { data } = await db.from('conversions')
    .select('id, offer_id, customer_email, amount_kobo, commission_kobo, status, created_at')
    .eq('partner_id', partnerId).order('created_at', { ascending: false }).limit(50);

  const offerIds = [...new Set((data || []).map(c => c.offer_id).filter(Boolean))];
  let offerMap = {};
  if (offerIds.length) {
    const { data: offers } = await db.from('offers').select('id, name').in('id', offerIds);
    (offers || []).forEach(o => { offerMap[o.id] = o.name; });
  }
  const commissionsList = (data || []).map(c => ({ ...c, offer_name: offerMap[c.offer_id] || '-' }));
  return json(res, 200, { ok: true, commissions: commissionsList }, { 'Cache-Control': 'no-store' });
}

async function withdraw(req, res, db, url) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { partner_id, amount_kobo } = req.body || {};
  if (!partner_id || !amount_kobo) return json(res, 400, { error: 'partner_id and amount_kobo required.' });
  const amt = parseInt(amount_kobo, 10);
  if (!amt || amt <= 0) return json(res, 400, { error: 'Invalid amount.' });

  const [convRes, payoutsRes, partnerRes] = await Promise.all([
    db.from('conversions').select('commission_kobo, status').eq('partner_id', partner_id),
    db.from('payouts').select('amount_kobo, status').eq('partner_id', partner_id),
    db.from('partners').select('id, code, name, email, bank_name, account_number, account_name')
      .eq('id', partner_id).eq('status', 'active').maybeSingle(),
  ]);

  if (!partnerRes.data) return json(res, 404, { error: 'Partner not found.' });

  const earned = (convRes.data || []).filter(c => c.status === 'approved' || c.status === 'paid')
    .reduce((s, c) => s + c.commission_kobo, 0);
  const paidPayouts = (payoutsRes.data || []).filter(p => p.status === 'processing' || p.status === 'completed')
    .reduce((s, p) => s + p.amount_kobo, 0);
  const pendingWithdrawals = (payoutsRes.data || []).filter(p => p.status === 'pending')
    .reduce((s, p) => s + p.amount_kobo, 0);
  const available = Math.max(0, earned - paidPayouts - pendingWithdrawals);

  if (amt > available) return json(res, 400, { error: 'Amount exceeds your available balance.' });

  const { data: payoutRow, error } = await db.from('payouts').insert({
    partner_id,
    amount_kobo: amt,
    status: 'pending',
  }).select('id, amount_kobo, status, created_at').single();

  if (error) return json(res, 500, { error: 'Failed to create withdrawal request.' });

  await notifyWithdrawal(db, partnerRes.data, payoutRow);

  return json(res, 200, { ok: true, payout: payoutRow });
}

async function payouts(req, res, db, url) {
  const partnerId = url.searchParams.get('partner_id');
  if (!partnerId) return json(res, 400, { error: 'partner_id required.' });

  const { data } = await db.from('payouts')
    .select('id, amount_kobo, status, created_at')
    .eq('partner_id', partnerId).order('created_at', { ascending: false }).limit(50);
  return json(res, 200, { ok: true, payouts: data || [] }, { 'Cache-Control': 'no-store' });
}

async function products(req, res, db, url) {
  const partnerId = url.searchParams.get('partner_id');
  if (!partnerId) return json(res, 400, { error: 'partner_id required.' });

  const [partnerRes, offersRes, referralsRes, convsRes] = await Promise.all([
    db.from('partners').select('id, code').eq('id', partnerId).eq('status', 'active').maybeSingle(),
    db.from('offers').select('*').eq('status', 'active').order('created_at', { ascending: true }),
    db.from('referrals').select('offer_id').eq('partner_id', partnerId),
    db.from('conversions').select('offer_id, commission_kobo, status').eq('partner_id', partnerId),
  ]);

  const partner = partnerRes.data;
  if (!partner) return json(res, 404, { error: 'Partner not found.' });

  const offers = offersRes.data || [];
  const referrals = referralsRes.data || [];
  const conversions = convsRes.data || [];

  const clicksByOffer = {};
  referrals.forEach(r => {
    if (r.offer_id) clicksByOffer[r.offer_id] = (clicksByOffer[r.offer_id] || 0) + 1;
  });

  const convsByOffer = {};
  const earnedByOffer = {};
  conversions.forEach(c => {
    if (c.offer_id) {
      convsByOffer[c.offer_id] = (convsByOffer[c.offer_id] || 0) + 1;
      if (c.status === 'approved' || c.status === 'paid') {
        earnedByOffer[c.offer_id] = (earnedByOffer[c.offer_id] || 0) + c.commission_kobo;
      }
    }
  });

  const siteUrl = process.env.SITE_URL || 'https://nexora.tomidewilliams.com';

  const productList = offers.map(o => {
    const checkout = o.checkout_url || (siteUrl + '/checkout');
    const link = checkout + '?pp=' + partner.code;
    return {
      id: o.id,
      slug: o.slug,
      name: o.name,
      description: o.description,
      price_kobo: o.price_kobo,
      commission_rate: o.commission_rate,
      link,
      clicks: clicksByOffer[o.id] || 0,
      conversions: convsByOffer[o.id] || 0,
      earned_kobo: earnedByOffer[o.id] || 0,
    };
  });

  return json(res, 200, { ok: true, products: productList }, { 'Cache-Control': 'no-store' });
}
