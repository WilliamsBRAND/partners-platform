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

async function isAuthed(req) {
  const tokenStr = getToken(req);
  if (!tokenStr) return false;
  const payload = verifyToken(tokenStr, adminSecret());
  if (!payload || !payload.sub) return false;
  return true;
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
      case 'overview': return await overview(req, res, db);
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
      case 'upload': return await uploadMaterialFile(req, res, db);
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

  const token = signToken({ sub: data.email, exp: Date.now() + 14 * 24 * 60 * 60 * 1000 }, adminSecret());
  return json(res, 200, { ok: true, token, name: data.name || 'Admin', email: data.email });
}

// ---------------------------------------------------------------------------
// OVERVIEW — Fast server-side aggregation for instant dashboard metrics & queues
// ---------------------------------------------------------------------------
async function overview(req, res, db) {
  const [
    { count: activeProductsCount, error: errProd },
    { count: partnersCount, error: errPart },
    { data: comms, error: errComm },
    { data: pays, error: errPay },
    { data: pendingPayoutRows },
    { data: pendingCommRows },
    { data: recentCommRows },
    { data: recentPartners }
  ] = await Promise.all([
    db.from('products').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    db.from('partners').select('id', { count: 'exact', head: true }),
    db.from('commissions').select('affiliate_id, commission_kobo, status'),
    db.from('payouts').select('amount_kobo, status'),
    db.from('payouts').select('id, partner_id, amount_kobo, status, created_at').eq('status', 'pending').order('created_at', { ascending: true }),
    db.from('commissions').select('id, affiliate_id, product_id, customer_email, amount_kobo, commission_kobo, status, created_at').eq('status', 'pending').order('created_at', { ascending: false }).limit(20),
    db.from('commissions').select('id, affiliate_id, product_id, customer_email, amount_kobo, commission_kobo, status, created_at').order('created_at', { ascending: false }).limit(10),
    db.from('partners').select('id, name, code, email, phone, created_at').order('created_at', { ascending: false }).limit(6)
  ]);

  if (errProd || errPart || errComm || errPay) {
    return json(res, 500, { error: 'Failed to compute metrics.' });
  }

  const allComms = comms || [];
  const allPays = pays || [];

  const validComms = allComms.filter(c => c.status === 'pending' || c.status === 'approved' || c.status === 'processing' || c.status === 'paid');
  const totalSales = validComms.length;
  const totalCommKobo = allComms.reduce((sum, c) => sum + (c.commission_kobo || 0), 0);
  const pendingCommKobo = allComms
    .filter(c => c.status === 'pending')
    .reduce((sum, c) => sum + (c.commission_kobo || 0), 0);
  const paidKobo = allPays
    .filter(p => p.status === 'completed')
    .reduce((sum, p) => sum + (p.amount_kobo || 0), 0);
  const pendingPayoutsKobo = allPays
    .filter(p => p.status === 'pending')
    .reduce((sum, p) => sum + (p.amount_kobo || 0), 0);

  // Collect IDs for partner & product name joins
  const needPartnerIds = new Set();
  const needProductIds = new Set();

  (pendingPayoutRows || []).forEach(p => { if (p.partner_id) needPartnerIds.add(p.partner_id); });
  (pendingCommRows || []).forEach(c => {
    if (c.affiliate_id) needPartnerIds.add(c.affiliate_id);
    if (c.product_id) needProductIds.add(c.product_id);
  });
  (recentCommRows || []).forEach(c => {
    if (c.affiliate_id) needPartnerIds.add(c.affiliate_id);
    if (c.product_id) needProductIds.add(c.product_id);
  });

  // Calculate top affiliates from allComms
  const affStats = {};
  allComms.forEach(c => {
    if (c.affiliate_id) {
      if (!affStats[c.affiliate_id]) affStats[c.affiliate_id] = { sales: 0, earned: 0 };
      if (c.status === 'pending' || c.status === 'approved' || c.status === 'processing' || c.status === 'paid') {
        affStats[c.affiliate_id].sales++;
      }
      if (c.status === 'approved' || c.status === 'processing' || c.status === 'paid') {
        affStats[c.affiliate_id].earned += c.commission_kobo || 0;
      }
    }
  });

  const sortedAffIds = Object.keys(affStats)
    .sort((a, b) => affStats[b].sales !== affStats[a].sales ? affStats[b].sales - affStats[a].sales : affStats[b].earned - affStats[a].earned)
    .slice(0, 6);

  sortedAffIds.forEach(id => needPartnerIds.add(id));

  // Fetch partners & products map in single query
  let partnerMap = {};
  let productMap = {};

  const partnerIdArr = Array.from(needPartnerIds);
  const productIdArr = Array.from(needProductIds);

  const [partnersRes, productsRes] = await Promise.all([
    partnerIdArr.length ? db.from('partners').select('id, name, code, email, phone, bank_name, account_number, account_name').in('id', partnerIdArr) : { data: [] },
    productIdArr.length ? db.from('products').select('id, name').in('id', productIdArr) : { data: [] }
  ]);

  (partnersRes.data || []).forEach(p => { partnerMap[p.id] = p; });
  (productsRes.data || []).forEach(p => { productMap[p.id] = p.name; });

  const pendingPayouts = (pendingPayoutRows || []).map(p => ({
    ...p,
    partner: partnerMap[p.partner_id] || { name: 'Partner', code: '-', email: '-' }
  }));

  const pendingCommissions = (pendingCommRows || []).map(c => ({
    ...c,
    partner: partnerMap[c.affiliate_id] || { name: 'Partner', code: '-' },
    product_name: productMap[c.product_id] || '-'
  }));

  const recentSales = (recentCommRows || []).map(c => ({
    ...c,
    partner: partnerMap[c.affiliate_id] || { name: 'Partner', code: '-' },
    product_name: productMap[c.product_id] || '-'
  }));

  const topPartners = sortedAffIds.map(id => ({
    id,
    ...(partnerMap[id] || { name: 'Partner', code: '-', email: '-' }),
    sales: affStats[id].sales,
    earned_kobo: affStats[id].earned
  }));

  return json(res, 200, {
    ok: true,
    metrics: {
      active_products: activeProductsCount || 0,
      partners_count: partnersCount || 0,
      total_sales: totalSales,
      total_commissions_kobo: totalCommKobo,
      pending_commissions_kobo: pendingCommKobo,
      total_paid_kobo: paidKobo,
      pending_payouts_count: (pendingPayoutRows || []).length,
      pending_payouts_kobo: pendingPayoutsKobo,
      pending_commissions_count: (pendingCommRows || []).length
    },
    // Backwards compatibility keys
    active_products: activeProductsCount || 0,
    partners_count: partnersCount || 0,
    total_sales: totalSales,
    total_commissions_kobo: totalCommKobo,
    pending_commissions_kobo: pendingCommKobo,
    total_paid_kobo: paidKobo,
    // Rich Data Sets for Command Center Overview
    pending_payouts: pendingPayouts,
    pending_commissions: pendingCommissions,
    recent_sales: recentSales,
    top_partners: topPartners,
    recent_partners: recentPartners || [],
    timestamp: Date.now()
  });
}

// ---------------------------------------------------------------------------
// PRODUCTS — list / create / update
// ---------------------------------------------------------------------------
async function products(req, res, db) {
  if (req.method === 'GET') {
    const { data, error } = await db.from('products')
      .select('id, slug, name, tagline, description, image_url, price_kobo, commission_type, commission_value, checkout_url, reference_prefix, status, created_at, updated_at')
      .order('created_at', { ascending: true });
    if (error) return json(res, 500, { error: 'Failed to load products.' });

    const productIds = (data || []).map(p => p.id);
    let matsCountMap = {}, affCountMap = {};

    if (productIds.length) {
      const [{ data: mats }, { data: affs }] = await Promise.all([
        db.from('marketing_materials').select('product_id').in('product_id', productIds),
        db.from('affiliate_products').select('product_id').in('product_id', productIds)
      ]);
      (mats || []).forEach(m => { matsCountMap[m.product_id] = (matsCountMap[m.product_id] || 0) + 1; });
      (affs || []).forEach(a => { affCountMap[a.product_id] = (affCountMap[a.product_id] || 0) + 1; });
    }

    const enriched = (data || []).map(p => ({
      ...p,
      material_count: matsCountMap[p.id] || 0,
      affiliate_count: affCountMap[p.id] || 0
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
// ---------------------------------------------------------------------------
// MATERIALS — list / add / edit / remove marketing materials, swipe copy & drive links
// ---------------------------------------------------------------------------
function packMaterialRecord(body) {
  const category = body.category || (body.type === 'copy' || body.content ? 'dm' : (body.type === 'image' ? 'creative' : 'general'));
  let type = body.type || (category === 'creative' ? 'image' : (category === 'drive_link' ? 'link' : (body.content ? 'copy' : 'asset')));
  const title = String(body.title || '').trim() || (type === 'copy' ? 'Swipe Copy' : 'Marketing Asset');
  const content = String(body.content || '').trim();
  const url = String(body.url || '').trim();
  const drive_url = String(body.drive_url || '').trim();

  // Pack into structured metadata
  const meta = {
    category,
    content,
    url: url || drive_url,
    drive_url: drive_url || (url.includes('drive.google.com') ? url : '')
  };

  const packedUrl = 'meta:' + encodeURIComponent(JSON.stringify(meta));
  return {
    product_id: body.product_id,
    type: type === 'copy' ? 'asset' : type,
    title,
    url: packedUrl
  };
}

function unpackMaterialRecord(row) {
  if (!row) return null;
  let category = 'general';
  let content = '';
  let url = row.url || '';
  let drive_url = '';
  let type = row.type || 'asset';

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
  } else if (url.startsWith('review:')) {
    category = 'review';
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

  return {
    id: row.id,
    product_id: row.product_id,
    category,
    type,
    title: row.title || 'Marketing Asset',
    content: content || (type === 'copy' ? url : ''),
    url: type === 'copy' ? '' : url,
    drive_url,
    created_at: row.created_at
  };
}

async function materials(req, res, db) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const productId = urlObj.searchParams.get('product_id') || (req.body && req.body.product_id) || '';
  const categoryFilter = urlObj.searchParams.get('category') || '';

  if (req.method === 'GET') {
    let query = db.from('marketing_materials').select('id, product_id, type, title, url, created_at');
    if (productId && productId !== 'all') {
      query = query.eq('product_id', productId);
    }
    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) return json(res, 500, { error: 'Failed to load materials.' });

    // Exclude internal feedback reviews stored in marketing_materials
    const validData = (data || []).filter(m => !m.url || !m.url.startsWith('review:'));
    let formatted = validData.map(unpackMaterialRecord);

    if (categoryFilter && categoryFilter !== 'all') {
      formatted = formatted.filter(m => m.category === categoryFilter);
    }

    return json(res, 200, { ok: true, materials: formatted });
  }

  // CREATE OR UPDATE (POST or PATCH)
  if (req.method === 'POST' || req.method === 'PATCH') {
    const body = req.body || {};
    const { id, items } = body;

    // Batch create support
    if (Array.isArray(items) && items.length > 0) {
      const recordsToInsert = items.map(packMaterialRecord);
      const { data, error } = await db.from('marketing_materials').insert(recordsToInsert).select('*');
      if (error) return json(res, 500, { error: 'Failed to add materials: ' + (error.message || '') });
      return json(res, 200, { ok: true, materials: data.map(unpackMaterialRecord) });
    }

    const pid = body.product_id || productId;
    if (!id && !pid) return json(res, 400, { error: 'product_id is required.' });

    const packed = packMaterialRecord({ ...body, product_id: pid });

    if (id) {
      // UPDATE existing
      const { data, error } = await db.from('marketing_materials')
        .update({
          type: packed.type,
          title: packed.title,
          url: packed.url
        })
        .eq('id', id)
        .select('*')
        .single();

      if (error) return json(res, 500, { error: 'Failed to update material: ' + (error.message || '') });
      return json(res, 200, { ok: true, material: unpackMaterialRecord(data) });
    }

    // INSERT new single
    const { data, error } = await db.from('marketing_materials').insert(packed).select('*').single();
    if (error) return json(res, 500, { error: 'Failed to add material: ' + (error.message || '') });

    return json(res, 200, { ok: true, material: unpackMaterialRecord(data) });
  }

  if (req.method === 'DELETE') {
    const id = urlObj.searchParams.get('id') || (req.body && req.body.id) || '';
    if (!id) return json(res, 400, { error: 'id required.' });
    const { error } = await db.from('marketing_materials').delete().eq('id', id);
    if (error) return json(res, 500, { error: 'Failed to delete material.' });
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
    if (c.status === 'pending' || c.status === 'approved' || c.status === 'processing' || c.status === 'paid') {
      commByAff[c.affiliate_id].sales++;
    }
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

// ---------------------------------------------------------------------------
// UPLOAD — Direct device photo / image upload to Supabase Storage
// ---------------------------------------------------------------------------
async function uploadMaterialFile(req, res, db) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  const { filename, contentType, base64Data } = req.body || {};
  if (!base64Data) return json(res, 400, { error: 'No image file data provided.' });

  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const ext = (filename && filename.includes('.'))
      ? filename.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '')
      : 'png';
    const cleanName = 'promo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.' + ext;
    const mimeType = contentType || (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : (ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'application/octet-stream')));

    const { data, error } = await db.storage
      .from('materials')
      .upload(cleanName, buffer, {
        contentType: mimeType,
        upsert: true
      });

    if (error) {
      return json(res, 500, { error: 'Storage upload failed: ' + (error.message || '') });
    }

    const { data: publicUrlData } = db.storage.from('materials').getPublicUrl(cleanName);
    return json(res, 200, {
      ok: true,
      url: publicUrlData.publicUrl,
      filename: cleanName,
      size: buffer.length
    });
  } catch (err) {
    return json(res, 500, { error: 'Upload failed: ' + (err.message || '') });
  }
}
