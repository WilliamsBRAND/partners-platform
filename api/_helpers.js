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

// Clean unique partner ID, e.g. TW000123. Used as both account ID and referral
// code in links (pp=TW000123). Guarantees a 6-digit zero-padded numeric suffix.
export function generatePartnerId(existingCodes) {
  const used = new Set(existingCodes || []);
  for (let i = 0; i < 100; i++) {
    const n = 1 + Math.floor(Math.random() * 999999); // avoid leading and last weirdness
    const id = 'TW' + String(n).padStart(6, '0');
    if (!used.has(id)) return id;
  }
  // Extremely unlikely fallback — append a random alpha suffix
  return 'TW' + String(1 + Math.floor(Math.random() * 999999)).padStart(6, '0') + Math.random().toString(36).slice(2, 5).toUpperCase();
}

// ---- Password hashing (Node built-in crypto.scryptSync — no extra dependency) ----
// Format: "scrypt$<salt>$<hash>" where salt and hash are base64.
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return 'scrypt$' + salt.toString('base64') + '$' + hash.toString('base64');
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const hash = crypto.scryptSync(String(password), salt, 64);
  const a = Buffer.from(parts[2], 'base64');
  const b = hash;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function koboToNaira(kobo) {
  return ((kobo || 0) / 100).toFixed(2);
}
