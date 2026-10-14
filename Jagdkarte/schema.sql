create extension if not exists postgis with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create table if not exists public.hunting_profiles (
  id uuid primary key default gen_random_uuid(),
  source_id text not null check (length(source_id) between 1 and 80),
  feature_id text not null check (length(feature_id) between 1 and 160),
  district_name text not null check (length(district_name) between 1 and 200),
  owner_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now(),
  unique (owner_id, source_id, feature_id)
);

create table if not exists public.hunting_profile_members (
  profile_id uuid not null references public.hunting_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  invited_by uuid not null references auth.users(id) on delete cascade,
  role text not null default 'guest' check (role in ('guest', 'editor')),
  created_at timestamptz not null default now(),
  primary key (profile_id, user_id)
);
alter table public.hunting_profile_members
  add column if not exists role text not null default 'guest' check (role in ('guest', 'editor'));

create table if not exists public.hunting_profile_invitations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.hunting_profiles(id) on delete cascade,
  email text not null check (length(email) between 3 and 254),
  invited_by uuid not null references auth.users(id) on delete cascade default auth.uid(),
  role text not null default 'guest' check (role in ('guest', 'editor')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (profile_id, email)
);
alter table public.hunting_profile_invitations
  add column if not exists role text not null default 'guest' check (role in ('guest', 'editor'));

create table if not exists public.hunting_markers (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.hunting_profiles(id) on delete cascade,
  type_id text not null default 'sonstiges' check (type_id ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  title text not null check (length(title) between 1 and 80),
  notes text not null default '' check (length(notes) <= 300),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  created_by uuid not null references auth.users(id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.hunting_profile_locations (
  profile_id uuid not null references public.hunting_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy double precision not null check (accuracy >= 0),
  updated_at timestamptz not null default now(),
  primary key (profile_id, user_id)
);

create table if not exists public.hunting_user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (display_name is null or length(trim(display_name)) between 1 and 60),
  updated_at timestamptz not null default now()
);

create table if not exists public.hunting_temporary_marker_types (
  type_id text primary key check (type_id ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  requires_current_location boolean not null default true,
  editors_only boolean not null default false
);
insert into public.hunting_temporary_marker_types (type_id, requires_current_location, editors_only)
  values ('anschuss', true, false), ('wildsichtung', true, false), ('standplatz', false, true)
  on conflict (type_id) do nothing;
alter table public.hunting_temporary_marker_types enable row level security;
drop policy if exists "Marker rules are public" on public.hunting_temporary_marker_types;
create policy "Marker rules are public" on public.hunting_temporary_marker_types
  for select to anon, authenticated using (true);
revoke all on public.hunting_temporary_marker_types from public, anon, authenticated;
grant select on public.hunting_temporary_marker_types to anon, authenticated;

create or replace function public.is_temporary_hunting_marker(p_type_id text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.hunting_temporary_marker_types where type_id = p_type_id);
$$;
revoke all on function public.is_temporary_hunting_marker(text) from public, anon, authenticated;
grant execute on function public.is_temporary_hunting_marker(text) to authenticated;

alter table public.hunting_markers
  add column if not exists type_id text not null default 'sonstiges'
  check (type_id ~ '^[a-z0-9][a-z0-9_-]{0,39}$');

alter table public.hunting_profiles add column if not exists boundary_geojson jsonb;
alter table public.hunting_profiles add column if not exists hunting_mode boolean not null default false;
alter table public.hunting_markers add column if not exists expires_at timestamptz;
update public.hunting_markers set expires_at = created_at + interval '48 hours'
  where public.is_temporary_hunting_marker(type_id) and expires_at is null;

create index if not exists hunting_markers_expiry_idx on public.hunting_markers(expires_at)
  where expires_at is not null;
create index if not exists hunting_markers_profile_id_idx on public.hunting_markers(profile_id);
create index if not exists hunting_profile_members_user_id_idx on public.hunting_profile_members(user_id);

create or replace function public.can_view_hunting_profile(profile_uuid uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.hunting_profiles p
    where p.id = profile_uuid and p.owner_id = (select auth.uid())
  ) or exists (
    select 1 from public.hunting_profile_members m
    where m.profile_id = profile_uuid and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.owns_hunting_profile(profile_uuid uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.hunting_profiles p
    where p.id = profile_uuid and p.owner_id = (select auth.uid())
  );
$$;

create or replace function public.can_edit_hunting_profile(profile_uuid uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.owns_hunting_profile(profile_uuid) or exists (
    select 1 from public.hunting_profile_members m
    where m.profile_id = profile_uuid and m.user_id = (select auth.uid()) and m.role = 'editor'
  );
$$;

drop function if exists public.get_hunting_profile_participants(uuid);
create or replace function public.get_hunting_profile_participants(p_profile_id uuid)
returns table(participant_user_id uuid, participant_role text, display_name text, participant_email text)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.can_view_hunting_profile(p_profile_id) then
    raise exception 'Kein Zugriff auf dieses Revierprofil';
  end if;
  return query
    select p.owner_id, 'owner'::text, up.display_name, owner.email::text
    from public.hunting_profiles p
    left join public.hunting_user_profiles up on up.user_id = p.owner_id
    left join auth.users owner on owner.id = p.owner_id
    where p.id = p_profile_id
    union all
    select m.user_id, m.role, up.display_name, member.email::text
    from public.hunting_profile_members m
    left join public.hunting_user_profiles up on up.user_id = m.user_id
    left join auth.users member on member.id = m.user_id
    where m.profile_id = p_profile_id;
end;
$$;

create or replace function public.get_hunting_profile_owner_emails(p_profile_ids uuid[])
returns table(profile_id uuid, owner_email text)
language sql stable security definer
set search_path = ''
as $$
  select p.id, u.email
  from public.hunting_profiles p
  join auth.users u on u.id = p.owner_id
  where (select auth.uid()) is not null
    and p.id = any(coalesce(p_profile_ids, array[]::uuid[]))
    and public.can_view_hunting_profile(p.id);
$$;

create or replace function public.hunting_mode_is_enabled(profile_uuid uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.can_view_hunting_profile(profile_uuid) and coalesce(
    (select p.hunting_mode from public.hunting_profiles p where p.id = profile_uuid), false
  );
$$;

create or replace function public.require_hunting_mode_for_location()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare enabled boolean;
begin
  select p.hunting_mode into enabled from public.hunting_profiles p
    where p.id = new.profile_id for share;
  if not coalesce(enabled, false) then
    raise exception 'Standortfreigabe ist nur im Jagdmodus moeglich';
  end if;
  return new;
end;
$$;

drop trigger if exists hunting_mode_location_guard on public.hunting_profile_locations;
create trigger hunting_mode_location_guard before insert or update on public.hunting_profile_locations
  for each row execute function public.require_hunting_mode_for_location();

create or replace function public.set_hunting_mode(p_profile_id uuid, p_enabled boolean)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.can_edit_hunting_profile(p_profile_id) then
    raise exception 'Nur der Owner oder ein Bearbeiter kann den Jagdmodus aendern';
  end if;
  update public.hunting_profiles set hunting_mode = p_enabled where id = p_profile_id;
  if not p_enabled then
    delete from public.hunting_profile_locations where profile_id = p_profile_id;
  end if;
  return p_enabled;
end;
$$;

create or replace function public.create_hunting_profile(p_source_id text, p_feature_id text, p_district_name text)
returns public.hunting_profiles
language plpgsql security definer
set search_path = ''
as $$
declare created_profile public.hunting_profiles;
begin
  if auth.uid() is null then raise exception 'Anmeldung erforderlich'; end if;
  insert into public.hunting_profiles (source_id, feature_id, district_name, owner_id)
  values (p_source_id, p_feature_id, p_district_name, auth.uid())
  on conflict (owner_id, source_id, feature_id) do update set district_name = excluded.district_name
  returning * into created_profile;
  return created_profile;
end;
$$;

create or replace function public.set_hunting_profile_boundary(p_profile_id uuid, p_geometry jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare district_geometry extensions.geometry;
begin
  if auth.uid() is null or not public.can_edit_hunting_profile(p_profile_id) then
    raise exception 'Nur der Owner oder ein Bearbeiter kann die Grenze hinterlegen';
  end if;
  district_geometry := extensions.st_setsrid(extensions.st_geomfromgeojson(p_geometry::text), 4326);
  if district_geometry is null or extensions.st_isempty(district_geometry)
    or not extensions.st_isvalid(district_geometry)
    or extensions.st_geometrytype(district_geometry) not in ('ST_Polygon', 'ST_MultiPolygon') then
    raise exception 'Ungueltige Reviergrenze';
  end if;
  update public.hunting_profiles set boundary_geojson = p_geometry where id = p_profile_id;
end;
$$;

create or replace function public.import_hunting_profile(
  p_profile_id uuid, p_feature_id text, p_district_name text, p_geometry jsonb, p_facilities jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  target_profile_id uuid;
  target_geojson jsonb;
  target_geometry extensions.geometry;
  created_profile public.hunting_profiles;
  facility record;
  inserted_count integer := 0;
  duplicate_count integer := 0;
  outside_count integer := 0;
begin
  if auth.uid() is null then raise exception 'Anmeldung erforderlich'; end if;
  if p_facilities is null or pg_catalog.jsonb_typeof(p_facilities) <> 'array'
    or pg_catalog.octet_length(p_facilities::text) > 10 * 1024 * 1024 then
    raise exception 'Ungueltige Einrichtungsliste';
  end if;
  if p_profile_id is null then
    created_profile := public.create_hunting_profile('user-imports', p_feature_id, p_district_name);
    target_profile_id := created_profile.id;
    perform public.set_hunting_profile_boundary(target_profile_id, p_geometry);
  else
    if not public.can_edit_hunting_profile(p_profile_id) then
      raise exception 'Nur Owner und Bearbeiter duerfen Einrichtungen importieren';
    end if;
    target_profile_id := p_profile_id;
  end if;
  select boundary_geojson into target_geojson from public.hunting_profiles
    where id = target_profile_id for update;
  if target_geojson is null then raise exception 'Die bestehende Reviergrenze ist nicht hinterlegt'; end if;
  target_geometry := extensions.st_setsrid(extensions.st_geomfromgeojson(target_geojson::text), 4326);
  for facility in
    select * from pg_catalog.jsonb_to_recordset(p_facilities)
      as entry(type_id text, title text, notes text, latitude double precision, longitude double precision)
  loop
    if facility.type_id is null or facility.type_id !~ '^[a-z0-9][a-z0-9_-]{0,39}$'
      or public.is_temporary_hunting_marker(facility.type_id)
      or facility.title is null or length(facility.title) not between 1 and 80
      or length(coalesce(facility.notes, '')) > 300
      or facility.latitude is null or facility.longitude is null
      or not (facility.latitude between -90 and 90 and facility.longitude between -180 and 180) then
      raise exception 'Ungueltige dauerhafte Einrichtung';
    end if;
    if p_profile_id is not null and not extensions.st_covers(target_geometry,
      extensions.st_setsrid(extensions.st_makepoint(facility.longitude, facility.latitude), 4326)) then
      outside_count := outside_count + 1;
      continue;
    end if;
    if exists (
      select 1 from public.hunting_markers marker where marker.profile_id = target_profile_id
        and marker.type_id = facility.type_id
        and lower(normalize(btrim(marker.title), NFKC)) = lower(normalize(btrim(facility.title), NFKC))
        and floor(marker.latitude * 1e6 + 0.5) = floor(facility.latitude * 1e6 + 0.5)
        and floor(marker.longitude * 1e6 + 0.5) = floor(facility.longitude * 1e6 + 0.5)
    ) then
      duplicate_count := duplicate_count + 1;
      continue;
    end if;
    insert into public.hunting_markers (profile_id, type_id, title, notes, latitude, longitude, created_by)
      values (target_profile_id, facility.type_id, facility.title, coalesce(facility.notes, ''),
        facility.latitude, facility.longitude, auth.uid());
    inserted_count := inserted_count + 1;
  end loop;
  return pg_catalog.jsonb_build_object('profile_id', target_profile_id, 'inserted_count', inserted_count,
    'duplicate_count', duplicate_count, 'outside_count', outside_count);
end;
$$;

create or replace function public.set_hunting_marker_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_temporary_hunting_marker(new.type_id) then
    new.created_at := now();
    new.expires_at := new.created_at + interval '48 hours';
  else
    new.expires_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists hunting_marker_expiry on public.hunting_markers;
create trigger hunting_marker_expiry before insert on public.hunting_markers
  for each row execute function public.set_hunting_marker_expiry();

create or replace function public.create_temporary_hunting_marker(
  p_profile_id uuid, p_type_id text, p_title text, p_notes text,
  p_latitude double precision, p_longitude double precision,
  p_user_latitude double precision, p_user_longitude double precision
)
returns public.hunting_markers
language plpgsql security definer
set search_path = ''
as $$
declare
  district_geojson jsonb;
  district_geometry extensions.geometry;
  created_marker public.hunting_markers;
  marker_rule public.hunting_temporary_marker_types;
begin
  if auth.uid() is null or not public.can_view_hunting_profile(p_profile_id) then
    raise exception 'Nur Owner und eingeladene Mitglieder duerfen Meldungen setzen';
  end if;
  select * into marker_rule from public.hunting_temporary_marker_types where type_id = p_type_id;
  if not found then
    raise exception 'Ungueltige temporaere Meldungsart';
  end if;
  if marker_rule.editors_only and not public.can_edit_hunting_profile(p_profile_id) then
    raise exception 'Nur Owner und Bearbeiter duerfen Standplaetze setzen';
  end if;
  if p_latitude is null or p_longitude is null
    or not (p_latitude between -90 and 90 and p_longitude between -180 and 180) then
    raise exception 'Ungueltige Koordinaten';
  end if;
  if marker_rule.requires_current_location and (p_user_latitude is null or p_user_longitude is null
    or not (p_user_latitude between -90 and 90 and p_user_longitude between -180 and 180)) then
    raise exception 'Ungueltige Koordinaten';
  end if;
  select boundary_geojson into district_geojson from public.hunting_profiles where id = p_profile_id;
  if district_geojson is null then
    raise exception 'Der Owner muss dieses Profil einmal oeffnen, um die Reviergrenze zu hinterlegen';
  end if;
  district_geometry := extensions.st_setsrid(extensions.st_geomfromgeojson(district_geojson::text), 4326);
  if marker_rule.requires_current_location and not extensions.st_covers(district_geometry,
      extensions.st_setsrid(extensions.st_makepoint(p_user_longitude, p_user_latitude), 4326)) then
    raise exception 'Dein aktueller Standort liegt ausserhalb des Reviers';
  end if;
  if not extensions.st_covers(district_geometry,
      extensions.st_setsrid(extensions.st_makepoint(p_longitude, p_latitude), 4326)) then
    raise exception 'Die Markierung muss innerhalb des Reviers liegen';
  end if;
  insert into public.hunting_markers (profile_id, type_id, title, notes, latitude, longitude, created_by)
    values (p_profile_id, p_type_id, p_title, p_notes, p_latitude, p_longitude, auth.uid())
    returning * into created_marker;
  return created_marker;
end;
$$;

create or replace function public.delete_expired_hunting_markers()
returns void
language sql security definer
set search_path = ''
as $$
  delete from public.hunting_markers where expires_at <= now();
$$;

do $$
declare previous_job record;
begin
  for previous_job in select jobid from cron.job where jobname = 'delete-expired-hunting-markers' loop
    perform cron.unschedule(previous_job.jobid);
  end loop;
  perform cron.schedule('delete-expired-hunting-markers', '* * * * *',
    'select public.delete_expired_hunting_markers()');
end;
$$;

drop function if exists public.invite_hunting_profile_member(uuid, text);
create or replace function public.invite_hunting_profile_member(p_profile_id uuid, p_email text, p_role text default 'guest')
returns void
language plpgsql security definer
set search_path = ''
as $$
declare normalized_email text := lower(trim(p_email));
begin
  if auth.uid() is null or not public.can_edit_hunting_profile(p_profile_id) then
    raise exception 'Nur der Owner oder ein Bearbeiter kann Benutzer einladen';
  end if;
  if p_role is null or p_role not in ('guest', 'editor') then
    raise exception 'Ungueltige Teilnehmerrolle';
  end if;
  if normalized_email = lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'Der eigene Zugang kann nicht eingeladen werden';
  end if;
  insert into public.hunting_profile_invitations (profile_id, email, invited_by, role)
  values (p_profile_id, normalized_email, auth.uid(), p_role)
  on conflict (profile_id, email) do update
    set invited_by = excluded.invited_by, role = excluded.role, created_at = now(), accepted_at = null;
end;
$$;

create or replace function public.accept_hunting_profile_invitations()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  accepted_count integer;
  verified_email text;
begin
  if auth.uid() is null then return 0; end if;
  select lower(u.email) into verified_email from auth.users u
    where u.id = auth.uid() and u.email_confirmed_at is not null;
  if verified_email is null then return 0; end if;
  insert into public.hunting_profile_members (profile_id, user_id, invited_by, role)
  select i.profile_id, auth.uid(), i.invited_by, i.role
  from public.hunting_profile_invitations i
  where i.accepted_at is null and i.email = verified_email
  on conflict (profile_id, user_id) do update
    set invited_by = excluded.invited_by, role = excluded.role;
  get diagnostics accepted_count = row_count;
  update public.hunting_profile_invitations
    set accepted_at = now()
    where accepted_at is null and email = verified_email;
  return accepted_count;
end;
$$;

alter table public.hunting_profiles enable row level security;
alter table public.hunting_profile_members enable row level security;
alter table public.hunting_profile_invitations enable row level security;
alter table public.hunting_markers enable row level security;
alter table public.hunting_profile_locations enable row level security;
alter table public.hunting_user_profiles enable row level security;

drop policy if exists "Users can view their own display name" on public.hunting_user_profiles;
create policy "Users can view their own display name" on public.hunting_user_profiles
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "Users can create their own display name" on public.hunting_user_profiles;
create policy "Users can create their own display name" on public.hunting_user_profiles
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "Users can update their own display name" on public.hunting_user_profiles;
create policy "Users can update their own display name" on public.hunting_user_profiles
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Profiles visible to owner and invited members" on public.hunting_profiles;
create policy "Profiles visible to owner and invited members" on public.hunting_profiles
  for select to authenticated using (public.can_view_hunting_profile(id));
drop policy if exists "Owner can delete profile" on public.hunting_profiles;
create policy "Owner can delete profile" on public.hunting_profiles
  for delete to authenticated using (owner_id = (select auth.uid()));

drop policy if exists "Members can view their own membership" on public.hunting_profile_members;
create policy "Members can view their own membership" on public.hunting_profile_members
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Markers visible to profile members" on public.hunting_markers;
create policy "Markers visible to profile members" on public.hunting_markers
  for select to authenticated using (public.can_view_hunting_profile(profile_id)
    and (expires_at is null or expires_at > now()));
drop policy if exists "Profile owner can create markers" on public.hunting_markers;
create policy "Profile owner can create markers" on public.hunting_markers
  for insert to authenticated with check (public.can_edit_hunting_profile(profile_id)
    and not public.is_temporary_hunting_marker(type_id) and expires_at is null
    and created_by = (select auth.uid()));
drop policy if exists "Profile owner can delete markers" on public.hunting_markers;
create policy "Profile owner can delete markers" on public.hunting_markers
  for delete to authenticated using (public.can_edit_hunting_profile(profile_id));
drop policy if exists "Members can delete their own temporary markers" on public.hunting_markers;
create policy "Members can delete their own temporary markers" on public.hunting_markers
  for delete to authenticated using (public.can_view_hunting_profile(profile_id)
    and public.is_temporary_hunting_marker(type_id) and created_by = (select auth.uid()));

drop policy if exists "Owners can view profile locations" on public.hunting_profile_locations;
drop policy if exists "Profile members can view locations" on public.hunting_profile_locations;
create policy "Profile members can view locations" on public.hunting_profile_locations
  for select to authenticated using (public.can_view_hunting_profile(profile_id)
    and public.hunting_mode_is_enabled(profile_id));
drop policy if exists "Users can share their own profile location" on public.hunting_profile_locations;
create policy "Users can share their own profile location" on public.hunting_profile_locations
  for insert to authenticated with check (user_id = (select auth.uid())
    and public.can_view_hunting_profile(profile_id) and public.hunting_mode_is_enabled(profile_id));
drop policy if exists "Users can update their own profile location" on public.hunting_profile_locations;
create policy "Users can update their own profile location" on public.hunting_profile_locations
  for update to authenticated using (user_id = (select auth.uid())
    and public.can_view_hunting_profile(profile_id) and public.hunting_mode_is_enabled(profile_id))
  with check (user_id = (select auth.uid())
    and public.can_view_hunting_profile(profile_id) and public.hunting_mode_is_enabled(profile_id));
drop policy if exists "Users can remove their own profile location" on public.hunting_profile_locations;
create policy "Users can remove their own profile location" on public.hunting_profile_locations
  for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.hunting_profiles, public.hunting_profile_members,
  public.hunting_profile_invitations, public.hunting_markers,
  public.hunting_profile_locations, public.hunting_user_profiles from public, anon, authenticated;
grant select, delete on public.hunting_profiles to authenticated;
grant select on public.hunting_profile_members to authenticated;
grant select, insert, delete on public.hunting_markers to authenticated;
grant select, insert, update, delete on public.hunting_profile_locations to authenticated;
grant select, insert, update on public.hunting_user_profiles to authenticated;
revoke all on function public.can_view_hunting_profile(uuid) from public, anon;
revoke all on function public.owns_hunting_profile(uuid) from public, anon;
revoke all on function public.can_edit_hunting_profile(uuid) from public, anon;
revoke all on function public.get_hunting_profile_participants(uuid) from public, anon;
revoke all on function public.get_hunting_profile_owner_emails(uuid[]) from public, anon;
revoke all on function public.hunting_mode_is_enabled(uuid) from public, anon;
revoke all on function public.require_hunting_mode_for_location() from public, anon, authenticated;
revoke all on function public.set_hunting_mode(uuid, boolean) from public, anon, authenticated;
revoke all on function public.create_hunting_profile(text, text, text) from public, anon;
revoke all on function public.invite_hunting_profile_member(uuid, text, text) from public, anon;
revoke all on function public.accept_hunting_profile_invitations() from public, anon;
grant execute on function public.can_view_hunting_profile(uuid) to authenticated;
grant execute on function public.owns_hunting_profile(uuid) to authenticated;
grant execute on function public.can_edit_hunting_profile(uuid) to authenticated;
grant execute on function public.get_hunting_profile_participants(uuid) to authenticated;
grant execute on function public.get_hunting_profile_owner_emails(uuid[]) to authenticated;
grant execute on function public.hunting_mode_is_enabled(uuid) to authenticated;
grant execute on function public.set_hunting_mode(uuid, boolean) to authenticated;
grant execute on function public.create_hunting_profile(text, text, text) to authenticated;
grant execute on function public.invite_hunting_profile_member(uuid, text, text) to authenticated;
grant execute on function public.accept_hunting_profile_invitations() to authenticated;
revoke all on function public.set_hunting_profile_boundary(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.set_hunting_marker_expiry() from public, anon, authenticated;
revoke all on function public.create_temporary_hunting_marker(uuid, text, text, text,
  double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke all on function public.delete_expired_hunting_markers() from public, anon, authenticated;
grant execute on function public.set_hunting_profile_boundary(uuid, jsonb) to authenticated;
revoke all on function public.import_hunting_profile(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.import_hunting_profile(uuid, text, text, jsonb, jsonb) to authenticated;
grant execute on function public.create_temporary_hunting_marker(uuid, text, text, text,
  double precision, double precision, double precision, double precision) to authenticated;