// Shared helpers for the Partners multi-product affiliate platform.
import crypto from 'crypto';

// Build a referral link for a product + partner code.
// Spec: {checkout_url}{sep}pp={code}. If checkout_url already has a query
// string, use &pp= instead of ?pp=. No offer slug — the checkout_url identifies
// the product. Returns null if checkout_url is not a valid absolute URL.
export function buildReferralLink(product, partnerCode) {
  const raw = (product && product.checkout_url || '').trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  const sep = raw.includes('?') ? '&' : '?';
  return raw + sep + 'pp=' + encodeURIComponent(partnerCode || '');
}

// Compute the commission earned (kobo) for an order given the product config.
export function commissionFor(product, orderAmountKobo) {
  if (!product) return 0;
  if (product.commission_type === 'fixed') {
    // commission_value is in Naira for fixed — convert to kobo
    return Math.round(parseFloat(product.commission_value || 0) * 100);
  }
  const percent = parseFloat(product.commission_value || 0) / 100;
  return Math.round(orderAmountKobo * percent);
}

// Derive the product by parsing the Paystack reference prefix, e.g. "NEXORA-..."
export function productPrefixFromReference(reference) {
  if (!reference) return '';
  return reference.split('-')[0].toUpperCase();
}

// Sign / verify style (shared by partner + admin)
export function signToken(payload, secret) {
  if (!secret) return null;
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}

export function verifyToken(token, secret) {
  try {
    if (!secret) return null;
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (expected !== sig) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

export function generateCode(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const rand = Math.random().toString(36).slice(2, 6);
  return (base + rand).slice(0, 12);
}

export function koboToNaira(kobo) {
  return ((kobo || 0) / 100).toFixed(2);
}
