begin;

create table if not exists public.hunting_dog_device_pairings (
  id uuid primary key default gen_random_uuid(),
  dog_id uuid not null unique references public.hunting_dogs(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

alter table public.hunting_dog_device_pairings enable row level security;
revoke all on public.hunting_dog_device_pairings from public, anon, authenticated;

create or replace function public.create_hunting_dog_device(p_dog_id uuid)
returns table(device_id uuid, device_token text)
language plpgsql security definer
set search_path = ''
as $$
declare
  new_device_id uuid := gen_random_uuid();
  new_device_token text;
begin
  perform 1 from public.hunting_dogs dog
  where dog.id = p_dog_id and public.can_edit_hunting_profile(dog.profile_id)
  for update;
  if not found then
    raise exception 'Nur der Owner oder ein Bearbeiter kann ein Hundegeraet koppeln';
  end if;

  new_device_token := encode(extensions.gen_random_bytes(32), 'hex');
  delete from public.hunting_dog_device_pairings where dog_id = p_dog_id;
  update public.hunting_dog_devices set revoked_at = now()
    where dog_id = p_dog_id and revoked_at is null;
  insert into public.hunting_dog_devices (id, dog_id, token_hash)
  values (new_device_id, p_dog_id,
    encode(extensions.digest(convert_to(new_device_token, 'UTF8'), 'sha256'), 'hex'));
  return query select new_device_id, new_device_token;
end;
$$;

create or replace function public.stage_hunting_dog_device_token(
  p_dog_id uuid,
  p_device_token text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  new_pairing_id uuid;
  existing_id uuid;
  existing_dog_id uuid;
  existing_revoked_at timestamptz;
  target_profile_id uuid;
  hashed_token text;
begin
  if auth.uid() is null then
    raise exception 'Anmeldung erforderlich';
  end if;
  if p_device_token is null or p_device_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Ungueltiger Hundegeraeteschluessel';
  end if;

  select dog.profile_id into target_profile_id
  from public.hunting_dogs dog
  where dog.id = p_dog_id
    and public.can_edit_hunting_profile(dog.profile_id)
  for update;
  if target_profile_id is null then
    raise exception 'Nur der Owner oder ein Bearbeiter kann ein Hundegeraet koppeln';
  end if;

  hashed_token := encode(extensions.digest(convert_to(p_device_token, 'UTF8'), 'sha256'), 'hex');

  select device.id, device.dog_id, device.revoked_at
  into existing_id, existing_dog_id, existing_revoked_at
  from public.hunting_dog_devices device
  where device.token_hash = hashed_token;
  if found then
    if existing_dog_id = p_dog_id and existing_revoked_at is null then
      return existing_id;
    end if;
    raise exception 'Dieser Schluessel wurde bereits verwendet';
  end if;

  select pairing.id, pairing.dog_id
  into existing_id, existing_dog_id
  from public.hunting_dog_device_pairings pairing
  where pairing.token_hash = hashed_token;
  if found then
    if existing_dog_id = p_dog_id then
      return existing_id;
    end if;
    raise exception 'Dieser Schluessel ist bereits fuer einen anderen Hund vorgemerkt';
  end if;

  begin
    insert into public.hunting_dog_device_pairings (dog_id, token_hash)
    values (p_dog_id, hashed_token)
    on conflict (dog_id) do update
      set token_hash = excluded.token_hash, created_at = now()
    returning id into new_pairing_id;
  exception when unique_violation then
    raise exception 'Dieser Schluessel ist bereits fuer einen anderen Hund vorgemerkt';
  end;
  return new_pairing_id;
end;
$$;

create or replace function public.complete_hunting_dog_device_pairing(
  p_device_token text,
  p_confirm boolean
)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  target_dog_id uuid;
  pairing_id uuid;
  existing_id uuid;
  existing_dog_id uuid;
  existing_revoked_at timestamptz;
  new_device_id uuid := gen_random_uuid();
  hashed_token text;
begin
  if p_confirm is null then
    raise exception 'Die Kopplung muss bestaetigt oder abgebrochen werden';
  end if;
  if p_device_token is null or p_device_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Ungueltiger Hundegeraeteschluessel';
  end if;
  hashed_token := encode(extensions.digest(convert_to(p_device_token, 'UTF8'), 'sha256'), 'hex');

  select pairing.dog_id into target_dog_id
  from public.hunting_dog_device_pairings pairing
  where pairing.token_hash = hashed_token;
  if not found then
    select device.id, device.dog_id, device.revoked_at
    into existing_id, existing_dog_id, existing_revoked_at
    from public.hunting_dog_devices device
    where device.token_hash = hashed_token;
    if found and existing_revoked_at is null then
      return 'already_active';
    end if;
    return 'not_found';
  end if;

  perform 1 from public.hunting_dogs dog where dog.id = target_dog_id for update;
  if not found then
    return 'not_found';
  end if;

  select pairing.id into pairing_id
  from public.hunting_dog_device_pairings pairing
  where pairing.dog_id = target_dog_id and pairing.token_hash = hashed_token
  for update;
  if not found then
    select device.id, device.dog_id, device.revoked_at
    into existing_id, existing_dog_id, existing_revoked_at
    from public.hunting_dog_devices device
    where device.token_hash = hashed_token;
    if found and existing_revoked_at is null then
      return 'already_active';
    end if;
    return 'not_found';
  end if;

  if not p_confirm then
    delete from public.hunting_dog_device_pairings where id = pairing_id;
    return 'cancelled';
  end if;

  update public.hunting_dog_devices
  set revoked_at = now()
  where dog_id = target_dog_id and revoked_at is null;
  insert into public.hunting_dog_devices (id, dog_id, token_hash)
  values (new_device_id, target_dog_id, hashed_token);
  delete from public.hunting_dog_device_pairings where id = pairing_id;
  return 'activated';
end;
$$;

revoke all on function public.create_hunting_dog_device(uuid) from public, anon;
revoke all on function public.stage_hunting_dog_device_token(uuid, text) from public, anon, authenticated;
revoke all on function public.complete_hunting_dog_device_pairing(text, boolean) from public, anon, authenticated;
grant execute on function public.create_hunting_dog_device(uuid) to authenticated;
grant execute on function public.stage_hunting_dog_device_token(uuid, text) to authenticated;
grant execute on function public.complete_hunting_dog_device_pairing(text, boolean) to anon, authenticated;

commit;
