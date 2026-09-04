-- Tomide Williams Partners — Multi-Product Affiliate Platform (v2)
-- Consolidated marketplace: products (NEXORA, Agentic AI, ...), affiliate product
-- selection, per-product + multi-product dashboards, referral tracking, Paystack
-- webhook commission recording, full commission lifecycle, payouts, notifications.
--
-- Run this in your Supabase SQL Editor. It is SAFE to re-run (idempotent ADD COLUMN
-- IF NOT EXISTS / CREATE ... IF NOT EXISTS / DO $$ blocks). Existing data is preserved.

-- ============================================================================
-- 1. PRODUCTS (replaces the single-purpose `offers` table; keeps offers intact)
--    Every product is added by the admin. It carries its own checkout URL,
--    price, commission, image, marketing materials, and Paystack secret key.
-- ============================================================================
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  tagline text,
  description text,
  image_url text,
  price_kobo integer not null default 0,
  commission_type text not null default 'percent' check (commission_type in ('percent', 'fixed')),
  commission_value numeric(10,2) not null default 30.00,
  checkout_url text not null,
  paystack_secret_key text,
  reference_prefix text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Marketing materials (per product, shown on the affiliate dashboard)
create table if not exists marketing_materials (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete cascade,
  type text not null default 'asset' check (type in ('image', 'video', 'file', 'link', 'asset')),
  title text,
  url text,
  created_at timestamptz default now()
);

-- ============================================================================
-- 2. PARTNERS (affiliates) — keep existing `partners` table, add any missing cols
-- ============================================================================
alter table partners add column if not exists phone text;
alter table partners add column if not exists status text default 'active';

-- ============================================================================
-- 3. AFFILIATE PRODUCTS — which products an affiliate has chosen to promote
-- ============================================================================
create table if not exists affiliate_products (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid references partners(id) on delete cascade,
  product_id uuid references products(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz default now(),
  unique (partner_id, product_id)
);

-- ============================================================================
-- 4. REFERRAL CLICKS — keep existing `referrals`, add product_id if missing
--    (we now reference products; offer_id is retained for backward compat)
-- ============================================================================
alter table referrals add column if not exists product_id uuid;
alter table referrals add column if not exists reference_id text;

-- ============================================================================
-- 5. ORDERS — a successful Paystack payment, independent of affiliate attribution.
--    Commissions are derived from orders. Reference is unique (prevents dupes).
-- ============================================================================
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete set null,
  customer_email text,
  customer_name text,
  paystack_reference text unique not null,
  amount_kobo integer not null,
  status text not null default 'verified' check (status in ('verified', 'refunded', 'disputed')),
  webhook_event text,
  created_at timestamptz default now()
);

-- ============================================================================
-- 6. COMMISSIONS — replaces/augments `conversions`. A commission is created when a
--    verified order belongs to an affiliate's referral. Statuses per spec:
--    pending -> approved -> processing -> paid ; reversed (for refunds/disputes).
--    We keep the existing `conversions` table for backward compatibility.
-- ============================================================================
create table if not exists commissions (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid references partners(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  order_id uuid references orders(id) on delete set null,
  customer_email text,
  paystack_reference text unique,
  amount_kobo integer not null default 0,
  commission_kobo integer not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'processing', 'paid', 'reversed')),
  created_at timestamptz default now(),
  approved_at timestamptz,
  paid_at timestamptz,
  reversed_at timestamptz
);

-- ============================================================================
-- 7. PAYOUTS — keep existing `payouts`, add product-scope + notification cols
-- ============================================================================
alter table payouts add column if not exists product_id uuid;

-- ============================================================================
-- 8. INDEXES
-- ============================================================================
create index if not exists idx_products_slug on products(slug);
create index if not exists idx_products_status on products(status);
create index if not exists idx_affprod_partner on affiliate_products(partner_id);
create index if not exists idx_affprod_product on affiliate_products(product_id);
create index if not exists idx_referrals_product on referrals(product_id);
create index if not exists idx_orders_product on orders(product_id);
create index if not exists idx_orders_reference on orders(paystack_reference);
create index if not exists idx_commissions_affiliate on commissions(affiliate_id);
create index if not exists idx_commissions_product on commissions(product_id);
create index if not exists idx_commissions_status on commissions(status);
create index if not exists idx_commissions_reference on commissions(paystack_reference);

-- ============================================================================
-- 9. ROW LEVEL SECURITY (service role full access, matching existing pattern)
-- ============================================================================
alter table products enable row level security;
alter table marketing_materials enable row level security;
alter table affiliate_products enable row level security;
alter table orders enable row level security;
alter table commissions enable row level security;

drop policy if exists "service full products" on products;
create policy "service full products" on products for all using (true) with check (true);
drop policy if exists "service full marketing" on marketing_materials;
create policy "service full marketing" on marketing_materials for all using (true) with check (true);
drop policy if exists "service full affiliate_products" on affiliate_products;
create policy "service full affiliate_products" on affiliate_products for all using (true) with check (true);
drop policy if exists "service full orders" on orders;
create policy "service full orders" on orders for all using (true) with check (true);
drop policy if exists "service full commissions" on commissions;
create policy "service full commissions" on commissions for all using (true) with check (true);

-- ============================================================================
-- 10. SEED — migrate the existing NEXORA offer into a proper product record
-- ============================================================================
insert into products (slug, name, tagline, description, price_kobo, commission_type, commission_value, checkout_url, reference_prefix, status)
select
  coalesce(o.slug, 'nexora'),
  coalesce(o.name, 'NEXORA'),
  null,
  o.description,
  coalesce(o.price_kobo, 749000),
  'percent',
  coalesce(o.commission_rate, 0.30) * 100,
  'https://nexora.tomidewilliams.com/checkout',
  'NEXORA',
  'active'
from offers o
where o.slug = 'nexora'
on conflict (slug) do nothing;

-- If there is no offers row (fresh DB), still create NEXORA
insert into products (slug, name, tagline, description, price_kobo, commission_type, commission_value, checkout_url, reference_prefix, status)
values (
  'nexora', 'NEXORA',
  'Birthday pre-order — practical lessons on money, career, AI, and personal growth.',
  'Birthday pre-order — practical lessons on money, career, AI, and personal growth.',
  749000, 'percent', 30.00,
  'https://nexora.tomidewilliams.com/checkout',
  'NEXORA', 'active'
)
on conflict (slug) do nothing;

-- Backfill: link every existing active partner to NEXORA so current partners
-- keep a working product (and their historical referrals/conversions stay linked).
insert into affiliate_products (partner_id, product_id)
select p.id, pr.id
from partners p
join products pr on pr.slug = 'nexora'
where p.status = 'active'
on conflict (partner_id, product_id) do nothing;

-- ============================================================================
-- 11. PASSWORD AUTH + CLEAN PARTNER IDS (v2.1)
--     Partners sign up with name/email/phone/password (NO bank details at signup).
--     Bank/payout details are added from the Profile and required before the
--     first withdrawal. Every partner gets a clean unique ID (TWXXXXXX) that
--     doubles as their referral code (pp=TWXXXXXX).
-- ============================================================================
alter table partners add column if not exists password_hash text;

-- Normalise existing referral codes into clean unique IDs (TW + 6 digits).
-- Only touches codes that aren't already in TWxxxxxx form.
do $$
declare
  r record;
  n int;
  newid text;
begin
  for r in select id, code from partners where status = 'active' and (code is null or code !~ '^TW[0-9]{6}$') loop
    loop
      n := 1 + floor(random() * 999999);
      newid := 'TW' || lpad(n::text, 6, '0');
      exit when not exists (select 1 from partners where code = newid);
    end loop;
    update partners set code = newid where id = r.id;
  end loop;
end $$;

-- ============================================================================
-- 12. ADMINS — email + password admin accounts (v2.2)
--     The admin dashboard now logs in with an admin email + password, mirroring
--     partner auth. Seed the admin account with a scrypt hash (done by the
--     migration runner, not SQL, because scrypt is unavailable in plain SQL).
-- ============================================================================
create table if not exists admins (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text,
  password_hash text,
  created_at timestamptz default now()
);
