// Referral Redirect Handler (/p/:code or /p/:code/:slug)
// Tracks the referral click and seamlessly redirects the visitor to the product's checkout page with ?pp=<code>
import { getDb } from './_db.js';

export default async function handler(req, res) {
  const db = getDb();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = (url.searchParams.get('code') || '').trim();
  const slug = (url.searchParams.get('slug') || url.searchParams.get('product') || '').trim().toLowerCase();

  // Default fallback if no partner code
  const fallbackUrl = 'https://nexora.tomidewilliams.store/checkout';

  if (!code || !db) {
    return res.writeHead(302, { Location: fallbackUrl }).end();
  }

  try {
    // 1. Look up partner
    const { data: partner } = await db.from('partners')
      .select('id, code, status').eq('code', code).maybeSingle();

    // 2. Look up product (by slug, or first active product)
    let product = null;
    if (slug) {
      const { data: prod } = await db.from('products')
        .select('id, slug, checkout_url, status')
        .ilike('slug', slug)
        .eq('status', 'active')
        .maybeSingle();
      product = prod;
    }

    if (!product) {
      // Find NEXORA or first active product
      const { data: defProd } = await db.from('products')
        .select('id, slug, checkout_url, status')
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      product = defProd;
    }

    // 3. Record referral click if partner is valid
    if (partner && partner.status === 'active') {
      const ip = req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : '';
      const ua = req.headers['user-agent'] || '';

      await db.from('referrals').insert({
        partner_id: partner.id,
        product_id: product ? product.id : null,
        ip_address: ip,
        user_agent: ua
      });
    }

    // 4. Construct target destination
    let dest = (product && product.checkout_url) ? product.checkout_url.trim() : fallbackUrl;
    const sep = dest.includes('?') ? '&' : '?';
    dest = `${dest}${sep}pp=${encodeURIComponent(code)}`;

    // Set partner attribution cookie (30 days) and redirect
    res.setHeader('Set-Cookie', `tw_partner_code=${encodeURIComponent(code)}; Path=/; Max-Age=2592000; SameSite=Lax`);
    return res.writeHead(302, { Location: dest }).end();
  } catch (e) {
    return res.writeHead(302, { Location: `${fallbackUrl}?pp=${encodeURIComponent(code)}` }).end();
  }
}
