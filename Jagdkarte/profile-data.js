export async function fetchAllRows(createQuery, isCurrent = () => true) {
  const rows = [];
  const pageSize = 500;
  try {
    while (isCurrent()) {
      const { data, error } = await createQuery().range(rows.length, rows.length + pageSize - 1);
      if (!isCurrent()) return { data: null, error: null };
      if (error) return { data: null, error };
      if (!Array.isArray(data)) throw new Error('Der Datendienst hat keine vollstaendige Liste geliefert.');
      if (!data.length) return { data: rows, error: null };
      rows.push(...data);
    }
    return { data: null, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

export function canShareProfileLocation(profile, user, consent) {
  return Boolean(user && profile?.hunting_mode && (profile.owner_id === user.id ||
    (consent?.profileId === profile.id && consent?.userId === user.id)));
}

export async function importJwdProfileData(client, { profileId, featureId, name, geometry, facilities }) {
  const { data, error } = await client.rpc('import_hunting_profile', {
    p_profile_id: profileId || null,
    p_feature_id: featureId || null,
    p_district_name: name,
    p_geometry: geometry,
    p_facilities: facilities.map(marker => ({
      type_id: marker.typeId, title: marker.title, notes: marker.notes,
      latitude: marker.latitude, longitude: marker.longitude
    }))
  });
  if (error) throw new Error(error.message);
  if (!data?.profile_id || !Number.isInteger(data.inserted_count)) throw new Error('Der Import wurde nicht bestaetigt.');
  return data;
}

export function applyMarkerRules(types, rules) {
  const rulesById = new Map();
  for (const rule of rules) {
    if (!types.some(type => type.id === rule.type_id) || rulesById.has(rule.type_id) ||
        typeof rule.requires_current_location !== 'boolean' || typeof rule.editors_only !== 'boolean') {
      throw new Error('Markerkatalog und Datenbankregeln stimmen nicht ueberein.');
    }
    rulesById.set(rule.type_id, rule);
  }
  return types.map(type => {
    const rule = rulesById.get(type.id);
    return { ...type, temporary: Boolean(rule), editorsOnly: rule?.editors_only || false,
      requiresCurrentLocation: rule?.requires_current_location ?? false };
  });
}