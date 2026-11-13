begin;

create or replace function public.get_hunting_dog_device_pairing_status(
  p_dog_id uuid,
  p_device_token text
)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  hashed_token text;
begin
  if auth.uid() is null then
    raise exception 'Anmeldung erforderlich';
  end if;
  if p_device_token is null or p_device_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Ungueltiger Hundegeraeteschluessel';
  end if;
  if not exists (
    select 1 from public.hunting_dogs dog
    where dog.id = p_dog_id and public.can_edit_hunting_profile(dog.profile_id)
  ) then
    raise exception 'Nur der Owner oder ein Bearbeiter kann die Kopplung pruefen';
  end if;

  hashed_token := encode(extensions.digest(convert_to(p_device_token, 'UTF8'), 'sha256'), 'hex');
  if exists (
    select 1 from public.hunting_dog_devices device
    where device.dog_id = p_dog_id and device.token_hash = hashed_token
      and device.revoked_at is null
  ) then
    return 'active';
  end if;
  if exists (
    select 1 from public.hunting_dog_device_pairings pairing
    where pairing.dog_id = p_dog_id and pairing.token_hash = hashed_token
  ) then
    return 'pending';
  end if;
  return 'not_found';
end;
$$;

revoke all on function public.get_hunting_dog_device_pairing_status(uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_hunting_dog_device_pairing_status(uuid, text)
  to authenticated;

notify pgrst, 'reload schema';
commit;
