// Partners — Affiliate API (multi-product marketplace)
// Endpoints: register, login, marketplace, select, dashboard, product, stats,
//            commissions, payouts, withdraw, profile, materials
import { getDb, json } from './_db.js';
import {
  buildReferralLink,
  commissionFor,
  generateCode,
  generatePartnerId,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  koboToNaira,
} from './_helpers.js';

function partnerSecret() {
  return process.env.PARTNER_TOKEN_SECRET || process.env.SUPABASE_SERVICE_KEY || '';
}

function getPartnerId(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    const payload = verifyToken(h.slice(7), partnerSecret());
    return payload ? payload.sub : null;
  }
  return null;
}

export default async function handler(req, res) {
  const db = getDb();
  if (!db) return json(res, 500, { error: 'Database not configured.' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action') || '';

  try {
    // Public
    if (action === 'register') return await register(req, res, db);
    if (action === 'login') return await login(req, res, db);
    if (action === 'marketplace') return await marketplace(req, res, db);
    if (action === 'leaderboard') return await leaderboardAction(req, res, db, url);

    // Everything else requires auth
    const partnerId = getPartnerId(req);
    if (!partnerId) return json(res, 401, { error: 'Unauthorized. Please log in.' });

    if (action === 'materials') return await materials(req, res, db, partnerId, url);
    if (action === 'select') return await select(req, res, db, partnerId);
    if (action === 'dashboard') return await dashboard(req, res, db, partnerId);
    if (action === 'product') return await productDetail(req, res, db, partnerId, url);
    if (action === 'stats') return await stats(req, res, db, partnerId);
    if (action === 'commissions') return await commissions(req, res, db, partnerId);
    if (action === 'payouts') return await payouts(req, res, db, partnerId);
    if (action === 'withdraw') return await withdraw(req, res, db, partnerId);
    if (action === 'profile') return await profile(req, res, db, partnerId);
    if (action === 'update') return await updateProfile(req, res, db, partnerId);
    if (action === 'change-password') return await changePassword(req, res, db, partnerId);

    return json(res, 400, { error: 'Unknown action.' });
  } catch (e) {
    return json(res, 500, { error: 'Server error: ' + (e.message || '') });
  }
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------
async function register(req, res, db) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { name, email, phone, password } = req.body || {};
  if (!name || !email) return json(res, 400, { error: 'Name and email are required.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'Invalid email.' });
  if (!password || String(password).length < 6) {
    return json(res, 400, { error: 'Password must be at least 6 characters.' });
  }

  const emailNorm = email.toLowerCase().trim();
  const { data: existing } = await db.from('partners').select('id').eq('email', emailNorm).maybeSingle();
  if (existing) return json(res, 409, { error: 'An account with this email already exists.' });

  const { data: allCodes } = await db.from('partners').select('code');
  const code = generatePartnerId((allCodes || []).map(r => r.code));
  const password_hash = hashPassword(password);

  const { data, error } = await db.from('partners').insert({
    code,
    name: name.trim(),
    email: emailNorm,
    phone: phone || null,
    password_hash,
    status: 'active',
  }).select('id, code, name, email, phone, bank_name, account_number, account_name').single();

  if (error) return json(res, 500, { error: 'Failed to create account.' });

  // Auto-enroll new active partner into all active products
  try {
    const { data: activeProducts } = await db.from('products').select('id').eq('status', 'active');
    if (activeProducts && activeProducts.length > 0) {
      const affRows = activeProducts.map(p => ({ partner_id: data.id, product_id: p.id, status: 'active' }));
      await db.from('affiliate_products').upsert(affRows, { onConflict: 'partner_id,product_id' });
    }
  } catch (e) {}

  const token = signToken({ sub: data.id, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }, partnerSecret());
  return json(res, 200, { ok: true, ...data, token });
}

async function login(req, res, db) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { email, password } = req.body || {};
  if (!email || !password) return json(res, 400, { error: 'Email and password are required.' });

  const { data } = await db.from('partners')
    .select('id, code, name, email, bank_name, account_number, account_name, password_hash')
    .eq('email', email.toLowerCase().trim()).eq('status', 'active').maybeSingle();

  if (!data) return json(res, 404, { error: 'No active partner account found with that email.' });

  if (!data.password_hash) return json(res, 403, { error: 'Set a password to continue.' });
  if (!verifyPassword(password, data.password_hash)) {
    return json(res, 401, { error: 'Incorrect password.' });
  }

  const safe = { id: data.id, code: data.code, name: data.name, email: data.email, bank_name: data.bank_name, account_number: data.account_number, account_name: data.account_name };
  const token = signToken({ sub: data.id, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }, partnerSecret());
  return json(res, 200, { ok: true, ...safe, token });
}

// ---------------------------------------------------------------------------
// MARKETPLACE — all active products
// ---------------------------------------------------------------------------
async function marketplace(req, res, db) {
  const { data: products, error } = await db
    .from('products').select('id, slug, name, tagline, description, image_url, price_kobo, commission_type, commission_value, checkout_url, status')
    .eq('status', 'active').order('created_at', { ascending: true });

  if (error) return json(res, 500, { error: 'Failed to load products.' });

  const list = (products || []).map(p => ({
    id: p.id, slug: p.slug, name: p.name, tagline: p.tagline, description: p.description,
    image_url: p.image_url, price_kobo: p.price_kobo,
    commission_type: p.commission_type, commission_value: p.commission_value,
    commission_label: p.commission_type === 'fixed'
      ? '₦' + (+p.commission_value).toLocaleString()
      : Math.round(+p.commission_value) + '%',
  }));

  const partnerId = getPartnerId(req);
  if (partnerId) {
    const { data: mine } = await db.from('affiliate_products')
      .select('product_id').eq('partner_id', partnerId).eq('status', 'active');
    const promoted = new Set((mine || []).map(r => r.product_id));
    list.forEach(p => { p.selected = promoted.has(p.id); });
  }

  return json(res, 200, { ok: true, products: list });
}

// ---------------------------------------------------------------------------
// SELECT — add/remove a product the affiliate promotes
// ---------------------------------------------------------------------------
async function select(req, res, db, partnerId) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { product_id, action } = req.body || {};
  if (!product_id) return json(res, 400, { error: 'product_id required.' });
  const mode = action === 'remove' ? 'remove' : 'add';

  const { data: product } = await db.from('products')
    .select('id, slug, status').eq('id', product_id).eq('status', 'active').maybeSingle();
  if (!product) return json(res, 404, { error: 'Product not found or inactive.' });

  if (mode === 'remove') {
    await db.from('affiliate_products').delete().eq('partner_id', partnerId).eq('product_id', product_id);
    return json(res, 200, { ok: true, selected: false });
  }

  const { error } = await db.from('affiliate_products').upsert(
    { partner_id: partnerId, product_id: product_id, status: 'active' },
    { onConflict: 'partner_id,product_id' }
  );
  if (error) return json(res, 500, { error: 'Failed to select product.' });
  return json(res, 200, { ok: true, selected: true });
}

// ---------------------------------------------------------------------------
// DASHBOARD — auto single or multi product view
// ---------------------------------------------------------------------------
async function dashboard(req, res, db, partnerId) {
  const { data: partner } = await db.from('partners')
    .select('id, code, name, email').eq('id', partnerId).maybeSingle();
  if (!partner) return json(res, 404, { error: 'Partner not found.' });

  // Affiliate's active products
  const { data: affRows } = await db.from('affiliate_products')
    .select('product_id').eq('partner_id', partnerId).eq('status', 'active');
  const productIds = (affRows || []).map(r => r.product_id);
  let products = [];
  if (productIds.length) {
    const { data: prods } = await db.from('products')
      .select('id, slug, name, tagline, description, image_url, price_kobo, commission_type, commission_value, checkout_url')
      .in('id', productIds).eq('status', 'active');
    products = prods || [];
  }

  // Per-product clicks
  const { data: referrals } = productIds.length
    ? await db.from('referrals').select('id, product_id').eq('partner_id', partnerId).in('product_id', productIds)
    : { data: [] };
  const clicksByProduct = {};
  (referrals || []).forEach(r => { if (r.product_id) clicksByProduct[r.product_id] = (clicksByProduct[r.product_id] || 0) + 1; });

  // Per-product commissions
  const { data: comms } = productIds.length
    ? await db.from('commissions').select('id, product_id, commission_kobo, amount_kobo, status, created_at, customer_email').eq('affiliate_id', partnerId).in('product_id', productIds)
    : { data: [] };

  // Materials counts
  let matsMap = {};
  if (productIds.length) {
    const { data: allMats } = await db.from('marketing_materials').select('product_id').in('product_id', productIds);
    (allMats || []).forEach(m => { matsMap[m.product_id] = (matsMap[m.product_id] || 0) + 1; });
  }

  const perProduct = products.map(p => {
    const pc = comms.filter(c => c.product_id === p.id);
    const validPc = pc.filter(c => c.status === 'pending' || c.status === 'approved' || c.status === 'processing' || c.status === 'paid');
    const sales = validPc.length;
    const pendingK = pc.filter(c => c.status === 'pending').reduce((s, c) => s + c.commission_kobo, 0);
    const earnedK = pc.filter(c => c.status === 'approved' || c.status === 'processing' || c.status === 'paid').reduce((s, c) => s + c.commission_kobo, 0);
    return {
      id: p.id, slug: p.slug, name: p.name, tagline: p.tagline, description: p.description,
      image_url: p.image_url, price_kobo: p.price_kobo,
      commission_type: p.commission_type, commission_value: p.commission_value,
      commission_label: p.commission_type === 'fixed' ? '₦' + (+p.commission_value).toLocaleString() : Math.round(+p.commission_value) + '%',
      link: buildReferralLink(p, partner.code),
      clicks: clicksByProduct[p.id] || 0,
      sales, pending_kobo: pendingK, earned_kobo: earnedK,
      material_count: matsMap[p.id] || 0,
      has_marketing: (matsMap[p.id] || 0) > 0,
    };
  });

  const commissions = comms || [];
  const validCommissions = commissions.filter(c => c.status === 'pending' || c.status === 'approved' || c.status === 'processing' || c.status === 'paid');
  const totalClicks = (referrals || []).length;
  const totalSales = validCommissions.length;
  const earned = commissions.filter(c => c.status === 'approved' || c.status === 'processing' || c.status === 'paid')
    .reduce((s, c) => s + c.commission_kobo, 0);
  const pending = commissions.filter(c => c.status === 'pending').reduce((s, c) => s + c.commission_kobo, 0);

  const { data: payouts } = await db.from('payouts')
    .select('amount_kobo, status').eq('partner_id', partnerId);
  const payoutRows = payouts || [];
  const paidPayouts = payoutRows.filter(p => p.status === 'processing' || p.status === 'completed')
    .reduce((s, p) => s + p.amount_kobo, 0);
  const requestedWithdrawals = payoutRows.filter(p => p.status === 'pending')
    .reduce((s, p) => s + p.amount_kobo, 0);
  const available = Math.max(0, earned - paidPayouts - requestedWithdrawals);

  const recentSales = commissions
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10);

  return json(res, 200, {
    ok: true,
    partner,
    mode: perProduct.length === 1 ? 'single' : perProduct.length > 1 ? 'multi' : 'none',
    products: perProduct,
    totals: { clicks: totalClicks, sales: totalSales, earned_kobo: earned, pending_kobo: pending, available_kobo: available, requested_withdrawals_kobo: requestedWithdrawals },
    recentSales,
  }, { 'Cache-Control': 'no-store' });
}

// ---------------------------------------------------------------------------
// PRODUCT DETAIL — per-product dashboard with marketing materials & swipe copy
// ---------------------------------------------------------------------------
async function productDetail(req, res, db, partnerId, url) {
  const product_id = url.searchParams.get('product_id') || '';
  if (!product_id) return json(res, 400, { error: 'product_id required.' });

  const { data: partner } = await db.from('partners').select('id, code, name, email').eq('id', partnerId).maybeSingle();
  if (!partner) return json(res, 404, { error: 'Partner not found.' });

  const { data: product } = await db.from('products')
    .select('id, slug, name, tagline, description, image_url, price_kobo, commission_type, commission_value, checkout_url')
    .eq('id', product_id).eq('status', 'active').maybeSingle();
  if (!product) return json(res, 404, { error: 'Product not found or inactive.' });

  const { data: rel } = await db.from('affiliate_products')
    .select('id').eq('partner_id', partnerId).eq('product_id', product_id).eq('status', 'active').maybeSingle();
  if (!rel) return json(res, 403, { error: 'You are not promoting this product.' });

  const referralLink = buildReferralLink(product, partner.code);

  const [{ data: referrals }, { data: comms }, { data: mats }] = await Promise.all([
    db.from('referrals').select('id').eq('partner_id', partnerId).eq('product_id', product_id),
    db.from('commissions').select('id, customer_email, amount_kobo, commission_kobo, status, created_at')
      .eq('affiliate_id', partnerId).eq('product_id', product_id).order('created_at', { ascending: false }),
    db.from('marketing_materials').select('id, type, title, url, created_at').eq('product_id', product_id).order('created_at', { ascending: false }),
  ]);

  const sales = comms || [];
  const validSales = sales.filter(c => c.status === 'pending' || c.status === 'approved' || c.status === 'processing' || c.status === 'paid');
  const clicks = (referrals || []).length;
  const earned = sales.filter(c => c.status === 'approved' || c.status === 'processing' || c.status === 'paid')
    .reduce((s, c) => s + c.commission_kobo, 0);
  const pending = sales.filter(c => c.status === 'pending').reduce((s, c) => s + c.commission_kobo, 0);

  // Parse materials and auto-inject affiliate referral link
  const validMats = (mats || []).filter(m => !m.url || !m.url.startsWith('review:'));
  const formattedMats = validMats.map(m => {
    let category = 'general';
    let content = '';
    let url = m.url || '';
    let drive_url = '';
    let type = m.type || 'asset';

    if (url.startsWith('meta:')) {
      try {
        const parsed = JSON.parse(decodeURIComponent(url.slice(5)));
        category = parsed.category || 'general';
        content = parsed.content || '';
        url = parsed.url || '';
        drive_url = parsed.drive_url || '';
      } catch (e) {
        content = url.slice(5);
      }
    } else if (url.startsWith('copy:')) {
      category = 'dm';
      try { content = decodeURIComponent(url.slice(5)); } catch (e) { content = url.slice(5); }
      url = '';
    } else if (type === 'image' || url.match(/\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i)) {
      category = 'creative';
      type = 'image';
    } else if (url.includes('drive.google.com')) {
      category = 'drive_link';
      type = 'link';
      drive_url = url;
    }

    if (!type || type === 'asset') {
      if (content) type = 'copy';
      else if (category === 'creative') type = 'image';
      else if (category === 'drive_link') type = 'link';
      else type = 'link';
    }

    const isCopy = type === 'copy' || !!content;
    let injectedContent = content;

    // Replace placeholders with affiliate referral link
    if (referralLink && isCopy) {
      injectedContent = injectedContent
        .replace(/\{\{\s*AFFILIATE_LINK\s*\}\}/gi, referralLink)
        .replace(/\{\{\s*LINK\s*\}\}/gi, referralLink)
        .replace(/\{\{\s*REF_LINK\s*\}\}/gi, referralLink)
        .replace(/\{\s*LINK\s*\}/gi, referralLink)
        .replace(/\[AFFILIATE_LINK\]/gi, referralLink)
        .replace(/\[LINK\]/gi, referralLink)
        .replace(/\[YOUR LINK\]/gi, referralLink);
    }

    return {
      id: m.id,
      product_id: m.product_id,
      category,
      type,
      title: m.title || (isCopy ? 'Swipe Copy' : 'Promo Asset'),
      url: isCopy ? '' : url,
      drive_url,
      content: injectedContent || (isCopy ? '' : url),
      raw_content: content,
      is_copy: isCopy,
      created_at: m.created_at,
    };
  });

  return json(res, 200, {
    ok: true,
    product: {
      ...product,
      commission_label: product.commission_type === 'fixed' ? '₦' + (+product.commission_value).toLocaleString() : Math.round(+product.commission_value) + '%',
      link: referralLink,
      clicks, sales: validSales.length, earned_kobo: earned, pending_kobo: pending,
    },
    sales,
    materials: formattedMats,
  }, { 'Cache-Control': 'no-store' });
}

// ---------------------------------------------------------------------------
// STATS / COMMISSIONS / PAYOUTS / WITHDRAW / PROFILE / MATERIALS
// ---------------------------------------------------------------------------
async function stats(req, res, db, partnerId) {
  const [{ data: comms }, { data: payouts }] = await Promise.all([
    db.from('commissions').select('commission_kobo, status').eq('affiliate_id', partnerId),
    db.from('payouts').select('amount_kobo, status').eq('partner_id', partnerId),
  ]);
  const commissions = comms || [];
  const validCommissions = commissions.filter(c => c.status === 'pending' || c.status === 'approved' || c.status === 'processing' || c.status === 'paid');
  const payoutRows = payouts || [];
  const earned = commissions.filter(c => c.status === 'approved' || c.status === 'processing' || c.status === 'paid')
    .reduce((s, c) => s + c.commission_kobo, 0);
  const pending = commissions.filter(c => c.status === 'pending').reduce((s, c) => s + c.commission_kobo, 0);
  const paidPayouts = payoutRows.filter(p => p.status === 'processing' || p.status === 'completed').reduce((s, p) => s + p.amount_kobo, 0);
  const requestedWithdrawals = payoutRows.filter(p => p.status === 'pending').reduce((s, p) => s + p.amount_kobo, 0);
  const available = Math.max(0, earned - paidPayouts - requestedWithdrawals);
  const { data: partner } = await db.from('partners').select('code').eq('id', partnerId).maybeSingle();
  return json(res, 200, {
    ok: true, clicks: 0, conversions: validCommissions.length,
    earned_kobo: earned, pending_kobo: pending, available_kobo: available,
    requested_withdrawals_kobo: requestedWithdrawals, code: partner ? partner.code : null,
  }, { 'Cache-Control': 'no-store' });
}

async function commissions(req, res, db, partnerId) {
  const { data } = await db.from('commissions')
    .select('id, product_id, customer_email, amount_kobo, commission_kobo, status, created_at')
    .eq('affiliate_id', partnerId).order('created_at', { ascending: false }).limit(100);

  const rows = data || [];
  const productIds = [...new Set(rows.map(r => r.product_id).filter(Boolean))];
  let productMap = {};
  if (productIds.length) {
    const { data: prods } = await db.from('products').select('id, name').in('id', productIds);
    (prods || []).forEach(p => { productMap[p.id] = p.name; });
  }
  const list = rows.map(r => ({ ...r, product_name: productMap[r.product_id] || '-' }));
  return json(res, 200, { ok: true, commissions: list }, { 'Cache-Control': 'no-store' });
}

async function payouts(req, res, db, partnerId) {
  const { data } = await db.from('payouts')
    .select('id, amount_kobo, status, created_at, completed_at')
    .eq('partner_id', partnerId).order('created_at', { ascending: false }).limit(100);
  return json(res, 200, { ok: true, payouts: data || [] }, { 'Cache-Control': 'no-store' });
}

async function withdraw(req, res, db, partnerId) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { amount_kobo } = req.body || {};
  if (!amount_kobo) return json(res, 400, { error: 'amount_kobo required.' });
  const amt = parseInt(amount_kobo, 10);
  if (!amt || amt <= 0) return json(res, 400, { error: 'Invalid amount.' });
  const MIN = parseInt(process.env.MIN_WITHDRAWAL_KOBO || '200000', 10);
  if (amt < MIN) return json(res, 400, { error: 'Minimum withdrawal is ₦' + (MIN / 100).toLocaleString() + '.' });

  const [{ data: comms }, { data: payouts }, { data: partner }] = await Promise.all([
    db.from('commissions').select('commission_kobo, status').eq('affiliate_id', partnerId),
    db.from('payouts').select('amount_kobo, status').eq('partner_id', partnerId),
    db.from('partners').select('id, code, name, email, bank_name, account_number, account_name').eq('id', partnerId).eq('status', 'active').maybeSingle(),
  ]);

  if (!partner) return json(res, 404, { error: 'Partner not found.' });

  const hasBank = partner.bank_name && partner.account_number && partner.account_name;
  if (!hasBank) {
    return json(res, 400, { ok: false, need_bank: true, error: 'Add your bank details in your profile before making a withdrawal.' });
  }

  const earned = (comms || []).filter(c => c.status === 'approved' || c.status === 'processing' || c.status === 'paid')
    .reduce((s, c) => s + c.commission_kobo, 0);
  const paidPayouts = (payouts || []).filter(p => p.status === 'processing' || p.status === 'completed').reduce((s, p) => s + p.amount_kobo, 0);
  const requestedWithdrawals = (payouts || []).filter(p => p.status === 'pending').reduce((s, p) => s + p.amount_kobo, 0);
  const available = Math.max(0, earned - paidPayouts - requestedWithdrawals);

  if (amt > available) return json(res, 400, { error: 'Amount exceeds your available balance.' });

  const { data: payoutRow, error } = await db.from('payouts').insert({
    partner_id: partnerId, amount_kobo: amt, status: 'pending',
  }).select('id, amount_kobo, status, created_at').single();
  if (error) return json(res, 500, { error: 'Failed to create withdrawal request.' });

  await notifyWithdrawal(db, partner, payoutRow);

  return json(res, 200, { ok: true, payout: payoutRow });
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
  } catch (e) { /* non-blocking */ }
}

async function profile(req, res, db, partnerId) {
  const { data } = await db.from('partners')
    .select('id, code, name, email, phone, bank_name, account_number, account_name').eq('id', partnerId).maybeSingle();
  if (!data) return json(res, 404, { error: 'Partner not found.' });
  return json(res, 200, { ok: true, profile: data }, { 'Cache-Control': 'no-store' });
}

async function updateProfile(req, res, db, partnerId) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { name, phone, bank_name, account_number, account_name } = req.body || {};

  const u = {};
  if (name !== undefined) { if (!String(name).trim()) return json(res, 400, { error: 'Name cannot be empty.' }); u.name = name.trim(); }
  if (phone !== undefined) u.phone = phone;
  if (account_number !== undefined && String(account_number).replace(/\s/g, '') !== '') {
    if (!/^\d{10}$/.test(String(account_number).replace(/\s/g, ''))) {
      return json(res, 400, { error: 'Please enter a valid 10-digit account number.' });
    }
    u.account_number = String(account_number).replace(/\s/g, '');
  }
  if (bank_name !== undefined) u.bank_name = bank_name;
  if (account_name !== undefined) u.account_name = account_name;

  if (Object.keys(u).length === 0) return json(res, 400, { error: 'Nothing to update.' });

  const { data, error } = await db.from('partners').update(u).eq('id', partnerId)
    .select('id, code, name, email, phone, bank_name, account_number, account_name').single();
  if (error) return json(res, 500, { error: 'Failed to update profile.' });
  return json(res, 200, { ok: true, profile: data });
}

async function changePassword(req, res, db, partnerId) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return json(res, 400, { error: 'Current and new password are required.' });
  if (String(new_password).length < 6) return json(res, 400, { error: 'New password must be at least 6 characters.' });

  const { data } = await db.from('partners').select('password_hash').eq('id', partnerId).maybeSingle();
  if (!data) return json(res, 404, { error: 'Partner not found.' });
  if (data.password_hash && !verifyPassword(current_password, data.password_hash)) {
    return json(res, 401, { error: 'Current password is incorrect.' });
  }
  const { error } = await db.from('partners').update({ password_hash: hashPassword(new_password) }).eq('id', partnerId);
  if (error) return json(res, 500, { error: 'Failed to update password.' });
  return json(res, 200, { ok: true });
}

async function materials(req, res, db, partnerId, url) {
  const product_id = url.searchParams.get('product_id') || '';
  if (!product_id) return json(res, 400, { error: 'product_id required.' });

  const [{ data: partner }, { data: product }] = await Promise.all([
    db.from('partners').select('code').eq('id', partnerId).maybeSingle(),
    db.from('products').select('id, checkout_url').eq('id', product_id).maybeSingle(),
  ]);

  const referralLink = (product && partner) ? buildReferralLink(product, partner.code) : '';

  const { data: mats, error } = await db.from('marketing_materials')
    .select('id, type, title, url, created_at').eq('product_id', product_id).order('created_at', { ascending: false });

  if (error) return json(res, 500, { error: 'Failed to load materials.' });

  const validMats = (mats || []).filter(m => !m.url || !m.url.startsWith('review:'));
  const formatted = validMats.map(m => {
    let category = 'general';
    let content = '';
    let itemUrl = m.url || '';
    let drive_url = '';
    let type = m.type || 'asset';

    if (itemUrl.startsWith('meta:')) {
      try {
        const parsed = JSON.parse(decodeURIComponent(itemUrl.slice(5)));
        category = parsed.category || 'general';
        content = parsed.content || '';
        itemUrl = parsed.url || '';
        drive_url = parsed.drive_url || '';
      } catch (e) {
        content = itemUrl.slice(5);
      }
    } else if (itemUrl.startsWith('copy:')) {
      category = 'dm';
      try { content = decodeURIComponent(itemUrl.slice(5)); } catch (e) { content = itemUrl.slice(5); }
      itemUrl = '';
    } else if (type === 'image' || itemUrl.match(/\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i)) {
      category = 'creative';
      type = 'image';
    } else if (itemUrl.includes('drive.google.com')) {
      category = 'drive_link';
      type = 'link';
      drive_url = itemUrl;
    }

    if (!type || type === 'asset') {
      if (content) type = 'copy';
      else if (category === 'creative') type = 'image';
      else if (category === 'drive_link') type = 'link';
      else type = 'link';
    }

    const isCopy = type === 'copy' || !!content;
    let injectedContent = content;

    if (referralLink && isCopy) {
      injectedContent = injectedContent
        .replace(/\{\{\s*AFFILIATE_LINK\s*\}\}/gi, referralLink)
        .replace(/\{\{\s*LINK\s*\}\}/gi, referralLink)
        .replace(/\{\{\s*REF_LINK\s*\}\}/gi, referralLink)
        .replace(/\{\s*LINK\s*\}/gi, referralLink)
        .replace(/\[AFFILIATE_LINK\]/gi, referralLink)
        .replace(/\[LINK\]/gi, referralLink)
        .replace(/\[YOUR LINK\]/gi, referralLink);
    }

    return {
      id: m.id,
      product_id: m.product_id,
      category,
      type,
      title: m.title || (isCopy ? 'Swipe Copy' : 'Promo Asset'),
      url: isCopy ? '' : itemUrl,
      drive_url,
      content: injectedContent || (isCopy ? '' : itemUrl),
      raw_content: content,
      is_copy: isCopy,
      created_at: m.created_at,
    };
  });

  return json(res, 200, { ok: true, materials: formatted }, { 'Cache-Control': 'no-store' });
}

async function leaderboardAction(req, res, db, url) {
  const productId = url.searchParams.get('product_id') || url.searchParams.get('offer_id') || '';
  try {
    const { data: products } = await db.from('products')
      .select('id, name, slug').eq('status', 'active').order('created_at', { ascending: true });

    let commQuery = db.from('commissions')
      .select('affiliate_id, commission_kobo, status')
      .in('status', ['pending', 'approved', 'processing', 'paid']);
    if (productId) commQuery = commQuery.eq('product_id', productId);
    const { data: comms, error: commErr } = await commQuery;
    if (commErr) return json(res, 500, { error: 'Failed to load leaderboard.' });

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
