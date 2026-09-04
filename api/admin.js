// Partners Admin API — product management, affiliate management, commissions,
// payouts, and notifications. Admin auth via HMAC token (ADMIN_TOKEN_SECRET).
import { getDb, json } from './_db.js';
import { signToken, verifyToken, koboToNaira, verifyPassword } from './_helpers.js';

function adminSecret() {
  return process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_PASSWORD || '';
}

function slugify(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function getToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const url = new URL(req.url, `http://${req.headers.host}`);
  return url.searchParams.get('token') || '';
}

// Cache which emails are valid admins. The admins table is tiny and rarely
// changes, so a short-lived in-memory cache avoids a DB round-trip on every
// API call — this was the main cause of the slow dashboard load.
const adminEmailCache = new Map();
const ADMIN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
async function isAdminEmail(email) {
  const norm = String(email).toLowerCase().trim();
  const hit = adminEmailCache.get(norm);
  if (hit && Date.now() - hit.t < ADMIN_CACHE_TTL) return hit.ok;
  const { data } = await getDb().from('admins').select('id').eq('email', norm).maybeSingle();
  const ok = !!data;
  adminEmailCache.set(norm, { ok, t: Date.now() });
  return ok;
}

async function isAuthed(req) {
  const payload = verifyToken(getToken(req), adminSecret());
  if (!payload || !payload.sub) return false;
  // Validate the token subject is a real admin account (defence in depth).
  return await isAdminEmail(payload.sub);
}

export default async function handler(req, res) {
  const db = getDb();
  if (!db) return json(res, 500, { error: 'Database not configured.' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action') || '';

  try {
    if (action === 'auth') return await auth(req, res, db);

    if (!(await isAuthed(req))) return json(res, 401, { error: 'Unauthorized.' });

    switch (action) {
      case 'products': return await products(req, res, db);
      case 'product': return await product(req, res, db);
      case 'materials': return await materials(req, res, db);
      case 'affiliates': return await affiliates(req, res, db);
      case 'affiliate-products': return await affiliateProducts(req, res, db);
      case 'commissions': return await commissions(req, res, db);
      case 'commission-status': return await commissionStatus(req, res, db);
      case 'payouts': return await payouts(req, res, db);
      case 'payout-status': return await payoutStatus(req, res, db);
      case 'notifications': return await notifications(req, res, db);
      default:
        return json(res, 400, { error: 'Unknown action.' });
    }
  } catch (e) {
    return json(res, 500, { error: 'Server error: ' + (e.message || '') });
  }
}

async function auth(req, res, db) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { email, password } = req.body || {};
  if (!email || !password) return json(res, 400, { error: 'Email and password are required.' });

  const norm = String(email).toLowerCase().trim();
  const { data } = await db.from('admins')
    .select('id, email, name, password_hash')
    .eq('email', norm).maybeSingle();

  if (!data) return json(res, 401, { error: 'Invalid email or password.' });
  if (!data.password_hash || !verifyPassword(password, data.password_hash)) {
    return json(res, 401, { error: 'Invalid email or password.' });
  }

  const token = signToken({ sub: data.email, exp: Date.now() + 12 * 60 * 60 * 1000 }, adminSecret());
  return json(res, 200, { ok: true, token, name: data.name || 'Admin', email: data.email });
}

// ---------------------------------------------------------------------------
// PRODUCTS — list / create / update
// ---------------------------------------------------------------------------
async function products(req, res, db) {
  if (req.method === 'GET') {
    const { data, error } = await db.from('products').select('*').order('created_at', { ascending: true });
    if (error) return json(res, 500, { error: 'Failed to load products.' });

    const enriched = await Promise.all((data || []).map(async (p) => {
      const [{ data: mats }, matCount, affCount] = await Promise.all([
        db.from('marketing_materials').select('id').eq('product_id', p.id),
        db.from('marketing_materials').select('id', { count: 'exact', head: true }).eq('product_id', p.id),
        db.from('affiliate_products').select('id', { count: 'exact', head: true }).eq('product_id', p.id),
      ]);
      // Never expose the Paystack secret key to the browser.
      const publicProduct = { ...p };
      delete publicProduct.paystack_secret_key;
      return { ...publicProduct, material_count: (mats || []).length, affiliate_count: (affCount && affCount.count) || 0 };
    }));
    return json(res, 200, { ok: true, products: enriched });
  }
  return json(res, 405, { error: 'Method not allowed.' });
}

async function product(req, res, db) {
  if (req.method === 'POST') return await productCreate(req, res, db);
  if (req.method === 'PATCH') return await productUpdate(req, res, db);
  if (req.method === 'DELETE') return await productDelete(req, res, db);
  return json(res, 405, { error: 'Method not allowed.' });
}

async function productDelete(req, res, db) {
  const { id } = req.body || {};
  if (!id) return json(res, 400, { error: 'id required.' });
  const { error: mmErr } = await db.from('marketing_materials').delete().eq('product_id', id);
  if (mmErr) return json(res, 500, { error: 'Failed to remove materials: ' + (mmErr.message || '') });
  const { error: apErr } = await db.from('affiliate_products').delete().eq('product_id', id);
  if (apErr) return json(res, 500, { error: 'Failed to detach affiliates: ' + (apErr.message || '') });
  const { error } = await db.from('products').delete().eq('id', id);
  if (error) return json(res, 500, { error: 'Failed to delete product: ' + (error.message || '') });
  return json(res, 200, { ok: true });
}

async function productCreate(req, res, db) {
  const { name, tagline, description, image_url, price_kobo, commission_type, commission_value, checkout_url, paystack_secret_key, reference_prefix, status } = req.body || {};
  if (!name || !checkout_url) return json(res, 400, { error: 'Product name and checkout URL are required.' });
  if (!/^https?:\/\//i.test(String(checkout_url).trim())) {
    return json(res, 400, { error: 'Checkout URL must be a full absolute URL (https://...).' });
  }

  const dupName = String(name || '').trim().toLowerCase();
  const dupUrl = String(checkout_url || '').trim().toLowerCase();
  const { data: all } = await db.from('products').select('name, checkout_url');
  if (all && all.some((p) => (p.name || '').toLowerCase() === dupName || (p.checkout_url || '').toLowerCase() === dupUrl)) {
    return json(res, 400, { error: 'A product with the same name or checkout URL already exists.' });
  }

  const slug = slugify(name) || 'product';
  let finalSlug = slug;
  const { data: dup } = await db.from('products').select('id').eq('slug', finalSlug).maybeSingle();
  if (dup) finalSlug = slug + '-' + Math.random().toString(36).slice(2, 5);

  const prefix = (reference_prefix || slugify(name)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'PROD';

  const commissionType = commission_type === 'fixed' ? 'fixed' : 'percent';
  let commissionValue = parseFloat(commission_value);
  if (isNaN(commissionValue)) commissionValue = commissionType === 'fixed' ? 0 : 30;

  const { data, error } = await db.from('products').insert({
    slug: finalSlug,
    name: name.trim(),
    tagline: tagline || null,
    description: description || null,
    image_url: image_url || null,
    price_kobo: parseInt(price_kobo, 10) || 0,
    commission_type: commissionType,
    commission_value: commissionValue,
    checkout_url: checkout_url.trim(),
    paystack_secret_key: paystack_secret_key || null,
    reference_prefix: prefix,
    status: status === 'inactive' ? 'inactive' : 'active',
  }).select('*').single();

  if (error) return json(res, 500, { error: 'Failed to create product: ' + (error.message || '') });
  const out = { ...data }; delete out.paystack_secret_key;
  return json(res, 200, { ok: true, product: out });
}

async function productUpdate(req, res, db) {
  const { id, name, tagline, description, image_url, price_kobo, commission_type, commission_value, checkout_url, paystack_secret_key, reference_prefix, status } = req.body || {};
  if (!id) return json(res, 400, { error: 'id required.' });

  const u = {};
  if (name !== undefined) u.name = name.trim();
  if (tagline !== undefined) u.tagline = tagline;
  if (description !== undefined) u.description = description;
  if (image_url !== undefined) u.image_url = image_url;
  if (price_kobo !== undefined) u.price_kobo = parseInt(price_kobo, 10) || 0;
  if (commission_type !== undefined) u.commission_type = commission_type === 'fixed' ? 'fixed' : 'percent';
  if (commission_value !== undefined) u.commission_value = parseFloat(commission_value);
  if (checkout_url !== undefined) {
    const cu = String(checkout_url).trim();
    if (!/^https?:\/\//i.test(cu)) return json(res, 400, { error: 'Checkout URL must be a full absolute URL.' });
    u.checkout_url = cu;
  }
  if (paystack_secret_key !== undefined) u.paystack_secret_key = paystack_secret_key || null;
  if (reference_prefix !== undefined) u.reference_prefix = String(reference_prefix).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (status !== undefined) u.status = status === 'inactive' ? 'inactive' : 'active';
  u.updated_at = new Date().toISOString();

  const { data, error } = await db.from('products').update(u).eq('id', id).select('*').single();
  if (error) return json(res, 500, { error: 'Failed to update product.' });
  const out = { ...data }; delete out.paystack_secret_key;
  return json(res, 200, { ok: true, product: out });
}

// ---------------------------------------------------------------------------
// MATERIALS — add / remove marketing materials for a product
// ---------------------------------------------------------------------------
async function materials(req, res, db) {
  if (req.method === 'POST') {
    const { product_id, type, title, url } = req.body || {};
    if (!product_id || !url) return json(res, 400, { error: 'product_id and url required.' });
    const { data, error } = await db.from('marketing_materials').insert({
      product_id, type: type || 'asset', title: title || null, url,
    }).select('*').single();
    if (error) return json(res, 500, { error: 'Failed to add material.' });
    return json(res, 200, { ok: true, material: data });
  }
  if (req.method === 'DELETE') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('id') || '';
    if (!id) return json(res, 400, { error: 'id required.' });
    await db.from('marketing_materials').delete().eq('id', id);
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { error: 'Method not allowed.' });
}

// ---------------------------------------------------------------------------
// AFFILIATES — list with products they promote + per-affiliate performance
// ---------------------------------------------------------------------------
async function affiliates(req, res, db) {
  const { data: partners, error } = await db.from('partners')
    .select('id, code, name, email, phone, status, bank_name, account_number, account_name, created_at')
    .order('created_at', { ascending: false });
  if (error) return json(res, 500, { error: 'Failed to load affiliates.' });

  const ids = (partners || []).map(p => p.id);
  const affRows = ids.length
    ? (await db.from('affiliate_products').select('partner_id, product_id, status').in('partner_id', ids)).data || []
    : [];
  const prodIds = [...new Set(affRows.map(a => a.product_id).filter(Boolean))];
  let prodMap = {};
  if (prodIds.length) {
    const { data: prods } = await db.from('products').select('id, name').in('id', prodIds);
    (prods || []).forEach(p => { prodMap[p.id] = p.name; });
  }
  const selectedIds = new Set(affRows.filter(a => a.status === 'active').map(a => a.partner_id + ':' + a.product_id));

  const byAffiliate = {};
  affRows.forEach(a => {
    if (!byAffiliate[a.partner_id]) byAffiliate[a.partner_id] = [];
    byAffiliate[a.partner_id].push({ product_id: a.product_id, name: prodMap[a.product_id] || '-', active: selectedIds.has(a.partner_id + ':' + a.product_id) });
  });

  const commissions = ids.length
    ? (await db.from('commissions').select('affiliate_id, commission_kobo, status').in('affiliate_id', ids)).data || []
    : [];
  const commByAff = {};
  commissions.forEach(c => {
    if (!commByAff[c.affiliate_id]) commByAff[c.affiliate_id] = { sales: 0, earned: 0, pending: 0 };
    commByAff[c.affiliate_id].sales++;
    if (c.status === 'approved' || c.status === 'processing' || c.status === 'paid') commByAff[c.affiliate_id].earned += c.commission_kobo;
    if (c.status === 'pending') commByAff[c.affiliate_id].pending += c.commission_kobo;
  });

  const list = (partners || []).map(p => ({
    ...p,
    products: byAffiliate[p.id] || [],
    sales: commByAff[p.id] ? commByAff[p.id].sales : 0,
    earned_kobo: commByAff[p.id] ? commByAff[p.id].earned : 0,
    pending_kobo: commByAff[p.id] ? commByAff[p.id].pending : 0,
  }));

  return json(res, 200, { ok: true, affiliates: list });
}

// Manually set an affiliate's promoted products
async function affiliateProducts(req, res, db) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { partner_id, product_ids } = req.body || {};
  if (!partner_id || !Array.isArray(product_ids)) return json(res, 400, { error: 'partner_id and product_ids array required.' });

  // remove existing, then re-add active ones
  await db.from('affiliate_products').delete().eq('partner_id', partner_id);
  const rows = product_ids.filter(Boolean).map(pid => ({ partner_id, product_id: pid, status: 'active' }));
  if (rows.length) {
    const { error } = await db.from('affiliate_products').insert(rows);
    if (error) return json(res, 500, { error: 'Failed to update products.' });
  }
  return json(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// COMMISSIONS — list / approve / reverse
// ---------------------------------------------------------------------------
async function commissions(req, res, db) {
  const { data, error } = await db.from('commissions')
    .select('id, affiliate_id, product_id, customer_email, amount_kobo, commission_kobo, status, created_at, approved_at, paid_at')
    .order('created_at', { ascending: false }).limit(200);
  if (error) return json(res, 500, { error: 'Failed to load commissions.' });

  const rows = data || [];
  const affIds = [...new Set(rows.map(r => r.affiliate_id).filter(Boolean))];
  const prodIds = [...new Set(rows.map(r => r.product_id).filter(Boolean))];
  let affMap = {}, prodMap = {};
  if (affIds.length) {
    const { data: affs } = await db.from('partners').select('id, name, code').in('id', affIds);
    (affs || []).forEach(a => { affMap[a.id] = { name: a.name, code: a.code }; });
  }
  if (prodIds.length) {
    const { data: prods } = await db.from('products').select('id, name').in('id', prodIds);
    (prods || []).forEach(p => { prodMap[p.id] = p.name; });
  }

  const list = rows.map(r => ({
    ...r,
    affiliate_name: affMap[r.affiliate_id] ? affMap[r.affiliate_id].name : '-',
    affiliate_code: affMap[r.affiliate_id] ? affMap[r.affiliate_id].code : '-',
    product_name: prodMap[r.product_id] || '-',
  }));
  return json(res, 200, { ok: true, commissions: list });
}

async function commissionStatus(req, res, db) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { id, status } = req.body || {};
  if (!id || !status) return json(res, 400, { error: 'id and status required.' });
  const valid = ['pending', 'approved', 'processing', 'paid', 'reversed'];
  if (!valid.includes(status)) return json(res, 400, { error: 'Invalid status.' });

  const u = { status };
  if (status === 'approved') u.approved_at = new Date().toISOString();
  if (status === 'paid') u.paid_at = new Date().toISOString();
  if (status === 'reversed') u.reversed_at = new Date().toISOString();

  const { error } = await db.from('commissions').update(u).eq('id', id);
  if (error) return json(res, 500, { error: 'Failed to update commission.' });
  return json(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// PAYOUTS — list / mark status
// ---------------------------------------------------------------------------
async function payouts(req, res, db) {
  const { data, error } = await db.from('payouts')
    .select('id, partner_id, amount_kobo, status, created_at, completed_at')
    .order('created_at', { ascending: false }).limit(200);
  if (error) return json(res, 500, { error: 'Failed to load payouts.' });

  const rows = data || [];
  const affIds = [...new Set(rows.map(r => r.partner_id).filter(Boolean))];
  let affMap = {};
  if (affIds.length) {
    const { data: affs } = await db.from('partners').select('id, name, code, bank_name, account_number, account_name').in('id', affIds);
    (affs || []).forEach(a => { affMap[a.id] = a; });
  }
  const list = rows.map(r => ({ ...r, ...(affMap[r.partner_id] || {}), partner_name: affMap[r.partner_id] ? affMap[r.partner_id].name : '-' }));
  return json(res, 200, { ok: true, payouts: list });
}

async function payoutStatus(req, res, db) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { id, status } = req.body || {};
  if (!id || !status) return json(res, 400, { error: 'id and status required.' });
  const valid = ['pending', 'processing', 'completed', 'failed'];
  if (!valid.includes(status)) return json(res, 400, { error: 'Invalid status.' });
  const u = { status };
  if (status === 'completed') u.completed_at = new Date().toISOString();
  const { error } = await db.from('payouts').update(u).eq('id', id);
  if (error) return json(res, 500, { error: 'Failed to update payout.' });
  return json(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// NOTIFICATIONS — pending payout requests surfaced to the admin dashboard
// ---------------------------------------------------------------------------
async function notifications(req, res, db) {
  const { data: pendingPayouts, error } = await db.from('payouts')
    .select('id, partner_id, amount_kobo, status, created_at')
    .eq('status', 'pending').order('created_at', { ascending: false });
  if (error) return json(res, 500, { error: 'Failed to load notifications.' });

  const rows = pendingPayouts || [];
  const affIds = [...new Set(rows.map(r => r.partner_id).filter(Boolean))];
  let affMap = {};
  if (affIds.length) {
    const { data: affs } = await db.from('partners').select('id, name, code, email, bank_name, account_number, account_name').in('id', affIds);
    (affs || []).forEach(a => { affMap[a.id] = a; });
  }
  const pending = rows.map(r => ({
    id: r.id,
    partner_name: affMap[r.partner_id] ? affMap[r.partner_id].name : '-',
    partner_email: affMap[r.partner_id] ? affMap[r.partner_id].email : '-',
    partner_code: affMap[r.partner_id] ? affMap[r.partner_id].code : '-',
    bank_name: affMap[r.partner_id] ? affMap[r.partner_id].bank_name : '-',
    account_number: affMap[r.partner_id] ? affMap[r.partner_id].account_number : '-',
    account_name: affMap[r.partner_id] ? affMap[r.partner_id].account_name : '-',
    amount_kobo: r.amount_kobo,
    amount_naira: koboToNaira(r.amount_kobo),
    requested_at: r.created_at,
  }));

  return json(res, 200, { ok: true, count: pending.length, notifications: pending });
}
