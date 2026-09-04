// Paystack Webhook — verifies payment signatures and records orders + commissions.
// Paystack POSTs to /api/paystack-webhook.
//
// Security model (works even though the serverless runtime may consume the raw
// stream when parsing JSON bodies):
//   1. If the raw stream is available, verify the x-paystack-signature HMAC-SHA512
//      against the product's Paystack secret key.
//   2. ALWAYS re-verify the transaction with Paystack's own API using the
//      product's secret key. This is the authoritative confirmation that the
//      webhook genuinely came from Paystack and the payment actually succeeded.
// Commissions are only recorded after Paystack confirms success.
//
// The product is identified by the Paystack reference prefix (e.g. "NEXORA-...").
import crypto from 'crypto';
import { getDb, json } from './_db.js';
import { commissionFor, productPrefixFromReference } from './_helpers.js';

const PAYSTACK_VERIFY = 'https://api.paystack.co/transaction/verify/';

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(''));
    // Safety: some runtimes already consumed the stream.
    setTimeout(() => finish(chunks.length ? Buffer.concat(chunks).toString('utf8') : ''), 50);
  });
}

function hmacSha512(secret, data) {
  return crypto.createHmac('sha512', secret).update(data, 'utf8').digest('hex');
}

async function verifyWithPaystack(secretKey, reference) {
  try {
    const r = await fetch(PAYSTACK_VERIFY + encodeURIComponent(reference), {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const data = await r.json();
    return data;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  const rawBody = await readRawBody(req);

  const db = getDb();
  if (!db) return json(res, 500, { error: 'Database not configured.' });

  const signature = req.headers['x-paystack-signature'] || '';

  let payload;
  try {
    const bodyText = rawBody || (req.body ? JSON.stringify(req.body) : '');
    payload = JSON.parse(bodyText || '{}');
  } catch (e) {
    return json(res, 400, { error: 'Invalid JSON.' });
  }

  const event = payload.event || '';
  const data = payload.data || {};
  const reference = data.reference || '';

  if (!reference) return json(res, 400, { error: 'Missing reference.' });

  // Identify product by reference prefix
  const prefix = productPrefixFromReference(reference);
  const { data: product } = await db.from('products')
    .select('id, slug, name, price_kobo, commission_type, commission_value, paystack_secret_key, reference_prefix')
    .eq('reference_prefix', prefix).eq('status', 'active').maybeSingle();

  if (!product || !product.paystack_secret_key) {
    return json(res, 200, { ok: true, ignored: 'product_not_found_or_no_secret' });
  }

  // 1) Signature check (only when raw stream available)
  if (rawBody && signature) {
    const expected = hmacSha512(product.paystack_secret_key, rawBody);
    if (expected !== signature) {
      return json(res, 401, { error: 'Invalid signature.' });
    }
  }

  // 2) Authoritative re-verification with Paystack API — always required.
  const verified = await verifyWithPaystack(product.paystack_secret_key, reference);
  const vStatus = verified && verified.data && verified.data.status;
  const vAmount = verified && verified.data ? parseInt(verified.data.amount, 10) : 0;
  const verifiedCustomer = verified && verified.data && verified.data.customer;

  // Only act once Paystack confirms the transaction is successful.
  if (!verified || verified.status !== true || vStatus !== 'success') {
    return json(res, 200, { ok: true, ignored: 'not_success_confirmed' });
  }

  if (!vAmount || vAmount <= 0) {
    return json(res, 200, { ok: true, ignored: 'invalid_amount' });
  }
  // Relaxed price policy: NEXORA (and future products) may sell at a range of
  // prices — e.g. pre-orders, promos and different tiers are all below the
  // stored base price. So we accept any paid amount that does NOT exceed the
  // product's stored price_kobo. Overpaying relative to the stored price is
  // treated as a mismatch (likely a different product or tampered charge).
  // Commission is always computed from the amount actually paid (vAmount).
  if (product.price_kobo && vAmount > product.price_kobo) {
    return json(res, 200, { ok: true, ignored: 'amount_mismatch' });
  }

  const customerEmail = (verifiedCustomer && verifiedCustomer.email || '').toLowerCase();
  const customerName = (verifiedCustomer && verifiedCustomer.first_name ? verifiedCustomer.first_name + ' ' : '') +
    (verifiedCustomer && verifiedCustomer.last_name || '');

  // ---- Dedup: order by unique reference ----
  const { data: existingOrder } = await db.from('orders')
    .select('id').eq('paystack_reference', reference).maybeSingle();
  if (!existingOrder) {
    const { error: orderErr } = await db.from('orders').insert({
      product_id: product.id,
      customer_email: customerEmail,
      customer_name: customerName.trim() || null,
      paystack_reference: reference,
      amount_kobo: vAmount,
      status: 'verified',
      webhook_event: event,
    });
    if (orderErr) return json(res, 500, { error: 'Failed to record order.' });
  }

  // ---- Find & attribute affiliate ----
  const partnerCode = extractPartnerCode(data, verified);
  if (!partnerCode) return json(res, 200, { ok: true, order: 'recorded', commission: 'no_partner' });

  const { data: partner } = await db.from('partners')
    .select('id').eq('code', partnerCode).eq('status', 'active').maybeSingle();
  if (!partner) return json(res, 200, { ok: true, order: 'recorded', commission: 'partner_not_found' });

  // Affiliate must actively promote this product
  const { data: rel } = await db.from('affiliate_products')
    .select('id').eq('partner_id', partner.id).eq('product_id', product.id).eq('status', 'active').maybeSingle();
  if (!rel) return json(res, 200, { ok: true, order: 'recorded', commission: 'not_promoting' });

  const commissionKobo = commissionFor(product, vAmount);

  // ---- Dedup: commission by unique reference ----
  const { data: existingComm } = await db.from('commissions')
    .select('id').eq('paystack_reference', reference).maybeSingle();
  if (existingComm) return json(res, 200, { ok: true, order: 'recorded', commission: 'already_exists' });

  const { data: orderRow } = await db.from('orders').select('id').eq('paystack_reference', reference).maybeSingle();

  const { error: commErr } = await db.from('commissions').insert({
    affiliate_id: partner.id,
    product_id: product.id,
    order_id: orderRow ? orderRow.id : null,
    customer_email: customerEmail,
    paystack_reference: reference,
    amount_kobo: vAmount,
    commission_kobo: commissionKobo,
    status: 'pending',
  });
  if (commErr) return json(res, 500, { error: 'Failed to record commission.' });

  await notifySale(db, partner, product, reference, vAmount, commissionKobo);

  return json(res, 200, { ok: true, order: 'recorded', commission: 'created' });
}

function extractPartnerCode(webhookData, verifiedData) {
  // Prefer webhook metadata (set at checkout start)
  const meta = (webhookData && webhookData.metadata) || {};
  const customFields = meta.custom_fields || [];
  for (const f of customFields) {
    if (f.variable_name && String(f.variable_name).toLowerCase() === 'partner') {
      const v = String(f.value || '');
      if (v) return v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    }
  }
  // Fall back to verified metadata
  const vMeta = (verifiedData && verifiedData.data && verifiedData.data.metadata) || {};
  const vCustom = vMeta.custom_fields || [];
  for (const f of vCustom) {
    if (f.variable_name && String(f.variable_name).toLowerCase() === 'partner') {
      const v = String(f.value || '');
      if (v) return v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    }
  }
  return '';
}

async function notifySale(db, partner, product, reference, amountKobo, commissionKobo) {
  const webhook = process.env.SALE_WEBHOOK_URL || '';
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'commission_created',
        subject: 'New Sale Commission',
        to: process.env.WITHDRAWAL_EMAIL || 'sodunketomide@gmail.com',
        partner_name: partner.name,
        partner_email: partner.email,
        partner_code: partner.code,
        product_name: product.name,
        paystack_reference: reference,
        amount_naira: (amountKobo / 100).toFixed(2),
        commission_naira: (commissionKobo / 100).toFixed(2),
      }),
    });
  } catch (e) { /* non-blocking */ }
}
