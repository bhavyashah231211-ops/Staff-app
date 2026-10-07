-- CBSystem multi-tenant schema. Run once: Supabase > SQL Editor > New query > paste > Run.
-- "Success. No rows returned" is the correct result.
-- Safe to run again (everything is "if not exists").

create table if not exists cbs_biz (
  id           text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,37}$'),
  name         text not null,
  salt         text not null,
  key_hash     text not null,          -- staff key (hashed, never stored in plain text)
  owner_hash   text not null,          -- Owner PIN (hashed)
  mgr_hash     text not null,          -- Manager PIN (hashed)
  active       boolean not null default true,
  fails        int not null default 0, -- wrong-PIN counter
  locked_until timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists cbs_rows (
  biz        text not null references cbs_biz(id) on delete cascade,
  id         text not null,
  tbl        text not null,            -- staff, clk, hol, ot, slip, cfg
  data       jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (biz, id)
);
create index if not exists cbs_rows_biz_tbl on cbs_rows (biz, tbl);

-- Lock both tables completely. No policies = the public (anon) key can read or write nothing.
-- Only the edge function (cbs-biz, using the service role) can touch them.
alter table cbs_biz  enable row level security;
alter table cbs_rows enable row level security;
revoke all on cbs_biz, cbs_rows from anon, authenticated;
