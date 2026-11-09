begin;

create table if not exists public.hunting_relay_devices (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.hunting_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  signing_public_key text not null check (length(signing_public_key) between 256 and 2048),
  lease_until timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  sharing_enabled boolean not null default false,
  sharing_epoch uuid not null default gen_random_uuid(),
  last_sequence bigint not null default 0 check (last_sequence >= 0)
);
create unique index if not exists hunting_relay_device_key_idx
  on public.hunting_relay_devices(profile_id, user_id, signing_public_key) where revoked_at is null;

create table if not exists public.hunting_relay_messages (
  origin_device_id uuid not null,
  message_id uuid not null,
  profile_id uuid not null references public.hunting_profiles(id) on delete cascade,
  envelope_digest text not null check (envelope_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  accepted_at timestamptz not null default now(),
  position_applied boolean not null,
  primary key(origin_device_id, message_id)
);
create index if not exists hunting_relay_message_profile_idx
  on public.hunting_relay_messages(profile_id, accepted_at);

alter table public.hunting_relay_devices enable row level security;
alter table public.hunting_relay_messages enable row level security;
revoke all on public.hunting_relay_devices, public.hunting_relay_messages from public, anon, authenticated;
grant select, insert, update, delete on public.hunting_relay_devices, public.hunting_relay_messages to service_role;

create or replace function public.register_hunting_relay_device(p_profile_id uuid, p_public_key text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare result uuid;
begin
  if auth.uid() is null or not public.can_view_hunting_profile(p_profile_id) then
    raise exception 'relay_membership_required' using errcode = '42501';
  end if;
  if p_public_key is null or length(p_public_key) not between 256 and 2048
    or p_public_key !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'invalid_public_key' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_profile_id::text || auth.uid()::text, 0));
  select id into result from public.hunting_relay_devices
    where profile_id = p_profile_id and user_id = auth.uid() and signing_public_key = p_public_key and revoked_at is null;
  if result is not null then
    update public.hunting_relay_devices set lease_until = now() + interval '15 minutes' where id = result;
    return result;
  end if;
  if (select count(*) from public.hunting_relay_devices
      where profile_id = p_profile_id and user_id = auth.uid() and revoked_at is null and lease_until > now()) >= 4 then
    raise exception 'relay_device_limit' using errcode = '22023';
  end if;
  insert into public.hunting_relay_devices(profile_id, user_id, signing_public_key, lease_until)
    values(p_profile_id, auth.uid(), p_public_key, now() + interval '15 minutes') returning id into result;
  return result;
end;
$$;

create or replace function public.revoke_hunting_relay_device(p_device_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'relay_membership_required' using errcode = '42501'; end if;
  update public.hunting_relay_devices set revoked_at = coalesce(revoked_at, now())
    where id = p_device_id and (user_id = auth.uid() or public.can_edit_hunting_profile(profile_id));
end;
$$;

create or replace function public.resolve_hunting_relay_device(p_device_id uuid)
returns table(device_id uuid, profile_id uuid, user_id uuid, dog_id uuid, public_key text, device_kind text)
language sql stable security definer set search_path = ''
as $$
  select device.id, device.profile_id, device.user_id, null::uuid, device.signing_public_key, 'participant'::text
    from public.hunting_relay_devices device
    join public.hunting_profiles profile on profile.id = device.profile_id
    where device.id = p_device_id and device.revoked_at is null and device.lease_until > now()
      and (profile.owner_id = device.user_id or exists (
        select 1 from public.hunting_profile_members member
          where member.profile_id = device.profile_id and member.user_id = device.user_id
      ))
  union all
  select device.id, dog.profile_id, null::uuid, dog.id, device.relay_signing_public_key, 'dog'::text
    from public.hunting_dog_devices device
    join public.hunting_dogs dog on dog.id = device.dog_id
    where device.id = p_device_id and device.revoked_at is null and device.relay_signing_public_key is not null;
$$;

create or replace function public.set_hunting_relay_sharing(p_device_id uuid, p_enabled boolean)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare device public.hunting_relay_devices%rowtype;
begin
  select * into device from public.hunting_relay_devices where id = p_device_id for update;
  if auth.uid() is null or device.user_id is distinct from auth.uid() or device.revoked_at is not null
    or device.lease_until <= now() or not public.can_view_hunting_profile(device.profile_id) then
    raise exception 'relay_membership_required' using errcode = '42501';
  end if;
  if p_enabled is null then raise exception 'invalid_sharing_state' using errcode = '22023'; end if;
  if p_enabled and not public.hunting_mode_is_enabled(device.profile_id) then
    raise exception 'hunting_mode_inactive' using errcode = '42501';
  end if;
  update public.hunting_relay_devices set sharing_enabled = p_enabled,
    sharing_epoch = case when p_enabled then sharing_epoch else gen_random_uuid() end
    where id = p_device_id returning * into device;
  if not p_enabled then
    delete from public.hunting_profile_locations where profile_id = device.profile_id and user_id = device.user_id;
  end if;
  return device.sharing_epoch;
end;
$$;

create or replace function public.list_hunting_relay_devices(p_profile_id uuid)
returns table(device_id uuid, public_key text, device_kind text)
language sql stable security definer set search_path = ''
as $$
  select result.device_id, result.public_key, result.device_kind from (
    select device.id from public.hunting_relay_devices device where device.profile_id = p_profile_id
    union all
    select device.id from public.hunting_dog_devices device
      join public.hunting_dogs dog on dog.id = device.dog_id where dog.profile_id = p_profile_id
  ) candidate
  cross join lateral public.resolve_hunting_relay_device(candidate.id) result
  order by result.device_id limit 128;
$$;

create or replace function public.record_hunting_relay_location(
  p_gateway_device_id uuid, p_origin_device_id uuid, p_message_id uuid, p_digest text, p_expires_at timestamptz,
  p_latitude double precision, p_longitude double precision, p_accuracy double precision,
  p_recorded_at timestamptz, p_sequence bigint default null, p_sharing_epoch uuid default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  gateway record;
  origin record;
  existing public.hunting_relay_messages%rowtype;
  boundary jsonb;
  changed integer;
  applied boolean := false;
  previous_sequence bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_origin_device_id::text, 0));
  select * into gateway from public.resolve_hunting_relay_device(p_gateway_device_id);
  select * into origin from public.resolve_hunting_relay_device(p_origin_device_id);
  if gateway.device_id is null or origin.device_id is null or gateway.profile_id <> origin.profile_id then
    raise exception 'relay_not_allowed' using errcode = '42501';
  end if;
  select boundary_geojson into boundary from public.hunting_profiles
    where id = origin.profile_id and hunting_mode for share;
  if not found then raise exception 'hunting_mode_inactive' using errcode = '42501'; end if;
  if p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or p_message_id is null
    or p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '24 hours'
    or p_recorded_at is null or p_recorded_at < now() - interval '24 hours'
    or p_latitude is null or not (p_latitude between -90 and 90)
    or p_longitude is null or not (p_longitude between -180 and 180)
    or p_accuracy is null or not (p_accuracy between 0 and 5000) then
    raise exception 'invalid_location' using errcode = '22023';
  end if;
  select * into existing from public.hunting_relay_messages
    where origin_device_id = p_origin_device_id and message_id = p_message_id;
  if found then
    if existing.envelope_digest <> p_digest then raise exception 'message_id_conflict' using errcode = '22023'; end if;
    return jsonb_build_object('accepted', true, 'duplicate', true, 'position_applied', existing.position_applied,
      'received_at', existing.accepted_at);
  end if;
  if origin.device_kind = 'participant' then
    if not exists(select 1 from public.hunting_relay_devices device where device.id = p_origin_device_id
        and device.sharing_enabled and device.sharing_epoch = p_sharing_epoch) then
      raise exception 'sharing_inactive' using errcode = '22023';
    end if;
    if p_sequence is null or p_sequence < 1 or p_sequence > 9007199254740991
      or p_recorded_at <= now() - interval '90 seconds' or p_recorded_at > now() + interval '30 seconds'
      or p_expires_at > p_recorded_at + interval '90 seconds' then
      raise exception 'invalid_participant_location' using errcode = '22023';
    end if;
    if boundary is null or not extensions.st_covers(
      extensions.st_setsrid(extensions.st_geomfromgeojson(boundary::text), 4326),
      extensions.st_setsrid(extensions.st_makepoint(p_longitude, p_latitude), 4326)) then
      raise exception 'outside_boundary' using errcode = '22023';
    end if;
    select last_sequence into previous_sequence from public.hunting_relay_devices where id = p_origin_device_id for update;
    if p_sequence > previous_sequence then
      insert into public.hunting_profile_locations(profile_id, user_id, latitude, longitude, accuracy, updated_at)
        values(origin.profile_id, origin.user_id, p_latitude, p_longitude, p_accuracy, p_recorded_at)
        on conflict(profile_id, user_id) do update set latitude = excluded.latitude, longitude = excluded.longitude,
          accuracy = excluded.accuracy, updated_at = excluded.updated_at
          where public.hunting_profile_locations.updated_at < excluded.updated_at;
      get diagnostics changed = row_count;
      applied := changed > 0;
      update public.hunting_relay_devices set last_sequence = p_sequence where id = p_origin_device_id;
    end if;
  else
    if p_sequence is not null or p_recorded_at > now() + interval '5 minutes' then
      raise exception 'invalid_dog_location' using errcode = '22023';
    end if;
    insert into public.hunting_dog_locations(dog_id, profile_id, latitude, longitude, accuracy, recorded_at)
      values(origin.dog_id, origin.profile_id, p_latitude, p_longitude, p_accuracy, p_recorded_at)
      on conflict(dog_id) do update set latitude = excluded.latitude, longitude = excluded.longitude,
        accuracy = excluded.accuracy, recorded_at = excluded.recorded_at, received_at = now()
        where public.hunting_dog_locations.recorded_at < excluded.recorded_at;
    get diagnostics changed = row_count;
    applied := changed > 0;
  end if;
  insert into public.hunting_relay_messages(origin_device_id, message_id, profile_id, envelope_digest, expires_at, position_applied)
    values(p_origin_device_id, p_message_id, origin.profile_id, p_digest, p_expires_at, applied)
    returning * into existing;
  return jsonb_build_object('accepted', true, 'duplicate', false, 'position_applied', applied, 'received_at', existing.accepted_at);
end;
$$;

create or replace function public.cleanup_hunting_relay_messages()
returns void
language sql security definer set search_path = ''
as $$
  delete from public.hunting_relay_messages where expires_at < now() - interval '24 hours';
  delete from public.hunting_relay_devices where lease_until < now() - interval '24 hours';
$$;

create or replace function public.invalidate_hunting_relay_sharing()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.hunting_mode and not new.hunting_mode then
    update public.hunting_relay_devices set sharing_enabled = false, sharing_epoch = gen_random_uuid()
      where profile_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists hunting_relay_mode_guard on public.hunting_profiles;
create trigger hunting_relay_mode_guard after update of hunting_mode on public.hunting_profiles
  for each row execute function public.invalidate_hunting_relay_sharing();
revoke all on function public.invalidate_hunting_relay_sharing() from public, anon, authenticated;

revoke all on function public.register_hunting_relay_device(uuid, text) from public, anon, authenticated;
revoke all on function public.revoke_hunting_relay_device(uuid) from public, anon, authenticated;
revoke all on function public.resolve_hunting_relay_device(uuid) from public, anon, authenticated;
revoke all on function public.list_hunting_relay_devices(uuid) from public, anon, authenticated;
revoke all on function public.record_hunting_relay_location(uuid, uuid, uuid, text, timestamptz, double precision,
  double precision, double precision, timestamptz, bigint, uuid) from public, anon, authenticated;
revoke all on function public.set_hunting_relay_sharing(uuid, boolean) from public, anon, authenticated;
revoke all on function public.cleanup_hunting_relay_messages() from public, anon, authenticated;
grant execute on function public.register_hunting_relay_device(uuid, text), public.revoke_hunting_relay_device(uuid) to authenticated;
grant execute on function public.set_hunting_relay_sharing(uuid, boolean) to authenticated;
grant execute on function public.resolve_hunting_relay_device(uuid), public.list_hunting_relay_devices(uuid),
  public.cleanup_hunting_relay_messages() to service_role;
grant execute on function public.record_hunting_relay_location(uuid, uuid, uuid, text, timestamptz, double precision,
  double precision, double precision, timestamptz, bigint, uuid) to service_role;

do $$
declare existing_job bigint;
begin
  if exists(select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    for existing_job in select jobid from cron.job where jobname = 'cleanup-hunting-relay-messages' loop
      perform cron.unschedule(existing_job);
    end loop;
    perform cron.schedule('cleanup-hunting-relay-messages', '*/15 * * * *', 'select public.cleanup_hunting_relay_messages()');
  end if;
end;
$$;

commit;