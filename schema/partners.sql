-- Tomide Williams Partners — Multi-Offer Affiliate Platform
-- Run this in your Supabase SQL Editor

-- Offers table (each product/campaign is an offer)
create table if not exists offers (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text,
  price_kobo integer not null default 749000,
  commission_rate numeric(3,2) not null default 0.30,
  checkout_url text,
  status text default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz default now()
);

-- Partners table
create table if not exists partners (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  email text unique not null,
  phone text,
  bank_name text,
  account_number text,
  account_name text,
  status text default 'active' check (status in ('active', 'inactive', 'suspended')),
  created_at timestamptz default now()
);

-- Referrals (clicks tracked per offer)
create table if not exists referrals (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid references partners(id) on delete cascade,
  offer_id uuid references offers(id) on delete set null,
  ip_address text,
  user_agent text,
  created_at timestamptz default now()
);

-- Conversions (successful payments attributed to a partner + offer)
create table if not exists conversions (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid references partners(id) on delete cascade,
  offer_id uuid references offers(id) on delete set null,
  customer_email text not null,
  customer_name text,
  paystack_reference text unique not null,
  amount_kobo integer not null,
  commission_kobo integer not null,
  status text default 'pending' check (status in ('pending', 'approved', 'rejected', 'paid')),
  created_at timestamptz default now(),
  approved_at timestamptz,
  paid_at timestamptz
);

-- Payouts
create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid references partners(id) on delete cascade,
  amount_kobo integer not null,
  paystack_transfer_ref text,
  status text default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  created_at timestamptz default now(),
  completed_at timestamptz
);

-- Indexes
create index if not exists idx_partners_code on partners(code);
create index if not exists idx_offers_slug on offers(slug);
create index if not exists idx_referrals_partner on referrals(partner_id);
create index if not exists idx_referrals_offer on referrals(offer_id);
create index if not exists idx_conversions_partner on conversions(partner_id);
create index if not exists idx_conversions_offer on conversions(offer_id);
create index if not exists idx_conversions_status on conversions(status);
create index if not exists idx_payouts_partner on payouts(partner_id);

-- Row Level Security
alter table offers enable row level security;
alter table partners enable row level security;
alter table referrals enable row level security;
alter table conversions enable row level security;
alter table payouts enable row level security;

-- Service role policies
create policy "Service role full access offers" on offers for all using (true) with check (true);
create policy "Service role full access partners" on partners for all using (true) with check (true);
create policy "Service role full access referrals" on referrals for all using (true) with check (true);
create policy "Service role full access conversions" on conversions for all using (true) with check (true);
create policy "Service role full access payouts" on payouts for all using (true) with check (true);

-- Seed the first offer
insert into offers (slug, name, description, price_kobo, commission_rate, checkout_url, status)
values ('nexora', 'NEXORA', 'Birthday pre-order — practical lessons on money, career, AI, and personal growth.', 749000, 0.30, '/checkout', 'active')
on conflict (slug) do nothing;

-- Reconcile existing NEXORA offer to the actual checkout price (₦7,490)
-- The partner platform previously showed ₦6,667 (666700) while the real Paystack
-- checkout price is ₦7,490 (749000, see nexora verify-payment expectedAmount).
-- Run once against the live DB to fix the displayed price and commission base.
update offers set price_kobo = 749000 where slug = 'nexora' and price_kobo <> 749000;
