create table if not exists public.hunting_district_services (
  id uuid primary key default gen_random_uuid(),
  ags varchar(8),
  ags_codes text[] default '{}',
  bundesland varchar(100),
  landkreis varchar(200),
  diensttyp varchar(50) not null,
  layername varchar(255) not null,
  service_url text not null,
  feature_type varchar(255),
  geometry_type varchar(80),
  crs varchar(80),
  licence varchar(255),
  last_update timestamptz,
  catalogue_source varchar(100) not null,
  catalogue_record_id text not null,
  resource_id text not null,
  catalogue_url text,
  is_open_data boolean not null default false,
  discovered_at timestamptz not null default now(),
  review_status text not null default 'candidate'
    check (review_status in ('candidate', 'verified', 'rejected', 'active')),
  metadata jsonb not null default '{}'::jsonb,
  unique (catalogue_source, catalogue_record_id, resource_id)
);

create index if not exists hunting_district_services_ags_idx
  on public.hunting_district_services (ags);
create index if not exists hunting_district_services_status_idx
  on public.hunting_district_services (review_status);
create index if not exists hunting_district_services_service_type_idx
  on public.hunting_district_services (diensttyp);

alter table public.hunting_district_services enable row level security;
alter table public.hunting_district_services alter column ags_codes drop not null;
revoke all on public.hunting_district_services from anon, authenticated;
grant all on public.hunting_district_services to service_role;