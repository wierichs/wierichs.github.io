begin;

create or replace function public.get_hunting_dog_pairing_states(p_profile_id uuid)
returns table(dog_id uuid, paired boolean, pending boolean)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Anmeldung erforderlich';
  end if;
  if not coalesce(public.can_edit_hunting_profile(p_profile_id), false) then
    raise exception 'Nur der Owner oder ein Bearbeiter kann die Kopplungen pruefen';
  end if;
  return query
    select dog.id,
      exists (
        select 1 from public.hunting_dog_devices device
        where device.dog_id = dog.id and device.revoked_at is null
      ),
      exists (
        select 1 from public.hunting_dog_device_pairings pairing
        where pairing.dog_id = dog.id
      )
    from public.hunting_dogs dog
    where dog.profile_id = p_profile_id
    order by dog.id;
end;
$$;

revoke all on function public.get_hunting_dog_pairing_states(uuid)
  from public, anon, authenticated;
grant execute on function public.get_hunting_dog_pairing_states(uuid)
  to authenticated;

notify pgrst, 'reload schema';
commit;
