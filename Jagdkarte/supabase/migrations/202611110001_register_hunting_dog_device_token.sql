begin;

create or replace function public.register_hunting_dog_device_token(
  p_dog_id uuid,
  p_device_token text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  target_profile_id uuid;
  new_device_id uuid := gen_random_uuid();
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

  update public.hunting_dog_devices
  set revoked_at = now()
  where dog_id = p_dog_id and revoked_at is null;

  insert into public.hunting_dog_devices (id, dog_id, token_hash)
  values (new_device_id, p_dog_id,
    encode(extensions.digest(convert_to(p_device_token, 'UTF8'), 'sha256'), 'hex'));

  return new_device_id;
end;
$$;

revoke all on function public.register_hunting_dog_device_token(uuid, text) from public, anon, authenticated;
grant execute on function public.register_hunting_dog_device_token(uuid, text) to authenticated;

commit;