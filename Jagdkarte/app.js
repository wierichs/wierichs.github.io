import { boundaries, loadBoundaries, featureName } from './data.js';

const config = window.JAGDKARTE_CONFIG;
const boundaryCacheName = 'jagdkarte-boundaries-v1';
const element = id => document.getElementById(id);
const map = L.map('map').setView([51.1, 10.4], 6);
const mapSurface = element('map-surface');
const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
let user = null;
let auth = null;
let supabaseClient = null;
let authPending = false;
let features = [];
let selected = null;
let boundary = null;
let locationLayer = null;
let controller = null;
let boundaryLoadRevision = 0;
let boundaryUpdatedAt = null;
let installPrompt = null;
let authRevision = 0;
let sourceAttribution = '';
let tileWarningShown = false;
let mapStatusTimer = null;
let profiles = [];
let activeProfile = null;
let placementMode = false;
let markerCoordinates = null;
let markerPending = false;
let markerExpiryTimers = [];
let profileRevision = 0;
let markerTypes = [];
let markerTypesById = new Map();
let fallbackMarkerType = 'sonstiges';
let locationInterval = null;
let locationRequestPending = false;
let sharingProfileId = null;
let sharedLocationIsInBoundary = false;
let presenceInterval = null;
let presenceRevision = 0;
let profileActivationRevision = 0;
let pendingProfileId = null;
const profileMarkers = L.layerGroup().addTo(map);
const profileLocations = L.layerGroup().addTo(map);

window.lucide?.createIcons();
new ResizeObserver(() => map.invalidateSize()).observe(element('map'));
tiles.on('tileerror', () => {
  if (!tileWarningShown) {
    showMapStatus('Hintergrundkarte nicht verfuegbar. Internetverbindung pruefen.', 'error');
    tileWarningShown = true;
  }
});

function hideMapStatus() {
  clearTimeout(mapStatusTimer);
  mapStatusTimer = null;
  element('map-status').hidden = true;
}

function showMapStatus(message, type = 'info') {
  hideMapStatus();
  element('map-status-text').textContent = message;
  element('close-map-status').hidden = type !== 'error';
  element('map-status').hidden = false;
  if (type === 'info') mapStatusTimer = setTimeout(hideMapStatus, 3000);
}

element('close-map-status').addEventListener('click', hideMapStatus);

function currentSource() { return config.sources.find(source => source.id === element('source').value); }
function status(message) { element('status').textContent = message; }
function selectedFeatureId() {
  const source = currentSource();
  const configuredId = source?.idFields?.map(field => selected?.properties?.[field])
    .find(value => value !== undefined && value !== null && String(value).trim());
  const value = configuredId ?? selected?.properties?.id ?? selected?.id;
  return value == null ? null : String(value);
}

function profileStatus(message) { element('profile-status').textContent = message; }

function resetMarkerPlacement() {
  placementMode = false;
  markerCoordinates = null;
  element('marker-instruction').hidden = true;
  element('marker-form').hidden = true;
  element('add-marker').setAttribute('aria-pressed', 'false');
  element('marker-title').value = '';
  element('marker-notes').value = '';
}

function updateProfileControls() {
  const ownProfile = activeProfile?.owner_id === user?.id;
  const canCreate = Boolean(user && selected && selectedFeatureId());
  element('claim-profile').hidden = !canCreate || profiles.some(profile => profile.owner_id === user.id);
  element('invite-toggle').hidden = !ownProfile;
  const availableTypes = markerTypes.filter(type => ownProfile || type.temporary);
  element('add-marker').hidden = !user || !activeProfile || availableTypes.length === 0;
  const select = element('marker-type');
  Array.from(select.options).forEach(option => {
    option.disabled = !ownProfile && !markerTypesById.get(option.value)?.temporary;
    option.hidden = option.disabled;
  });
  if (select.selectedOptions[0]?.disabled) select.value = availableTypes[0]?.id || '';
}

async function loadMarkerTypes() {
  const response = await fetch(config.markerTypesUrl || './marker-types.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const catalog = await response.json();
  if (catalog.version !== 1 || !Array.isArray(catalog.types)) throw new Error('Ungueltiges Katalogformat');
  const parsedTypes = catalog.types.map(type => {
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(type.id) || typeof type.label !== 'string' || !type.label.trim()) {
      throw new Error('Ungueltiger Objekttyp');
    }
    const iconUrl = new URL(type.iconUrl, location.href);
    if (iconUrl.origin !== location.origin || !iconUrl.pathname.endsWith('.svg')) throw new Error('Nur lokale SVG-Icons sind erlaubt');
    for (const key of ['iconSize', 'iconAnchor', 'popupAnchor']) {
      if (!Array.isArray(type[key]) || type[key].length !== 2 || !type[key].every(Number.isFinite)) {
        throw new Error(`Ungueltige Icon-Geometrie: ${key}`);
      }
    }
    if (type.iconSize.some(size => size <= 0) || type.iconAnchor.some((value, index) => value < 0 || value > type.iconSize[index])) {
      throw new Error('Ungueltiger Icon-Anker');
    }
    return { ...type, iconUrl: iconUrl.href };
  });
  markerTypesById = new Map(parsedTypes.map(type => [type.id, type]));
  if (markerTypesById.size !== parsedTypes.length || !markerTypesById.has(catalog.fallbackType)) {
    throw new Error('Doppelte Objekttypen oder fehlender Fallback');
  }
  markerTypes = parsedTypes;
  fallbackMarkerType = catalog.fallbackType;
  const select = element('marker-type');
  select.replaceChildren();
  markerTypes.forEach(type => {
    const option = document.createElement('option');
    option.value = type.id;
    option.textContent = type.label;
    select.append(option);
  });
  select.value = fallbackMarkerType;
}

function clearProfileMarkers() {
  markerExpiryTimers.forEach(timer => clearTimeout(timer));
  markerExpiryTimers = [];
  profileMarkers.clearLayers();
}

async function registerProfileBoundary(profile) {
  if (profile.owner_id !== user?.id || !selected) return;
  const { error } = await supabaseClient.rpc('set_hunting_profile_boundary', {
    p_profile_id: profile.id, p_geometry: selected.geometry
  });
  if (error) profileStatus(`Reviergrenze konnte nicht hinterlegt werden: ${error.message}. Datenbankschema aktualisieren.`);
}

async function loadProfileMarkers() {
  const revision = ++profileRevision;
  clearProfileMarkers();
  if (!supabaseClient || !activeProfile || !user) return;
  const profileId = activeProfile.id;
  const userId = user.id;
  const { data, error } = await supabaseClient.from('hunting_markers')
    .select('id,type_id,title,notes,latitude,longitude,created_by,created_at,expires_at')
    .eq('profile_id', activeProfile.id).order('created_at');
  if (revision !== profileRevision || activeProfile?.id !== profileId || user?.id !== userId) return;
  if (error) {
    profileStatus(`Markierungen konnten nicht geladen werden: ${error.message}`);
    return;
  }
  (data || []).forEach(marker => {
    const expiresAt = marker.expires_at ? new Date(marker.expires_at).getTime() : null;
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) return;
    const type = markerTypesById.get(marker.type_id) || markerTypesById.get(fallbackMarkerType);
    const popup = document.createElement('div');
    popup.className = 'profile-marker-popup';
    const title = document.createElement('strong');
    title.textContent = marker.title || type.label;
    popup.append(title);
    if (marker.title && marker.title !== type.label) {
      const typeLabel = document.createElement('span');
      typeLabel.textContent = type.label;
      popup.append(typeLabel);
    }
    if (marker.notes) {
      const notes = document.createElement('span');
      notes.textContent = marker.notes;
      popup.append(notes);
    }
    if (expiresAt !== null) {
      const expiry = document.createElement('span');
      expiry.textContent = `Gueltig bis ${new Date(expiresAt).toLocaleString('de-DE')}`;
      popup.append(expiry);
    }
    if (activeProfile.owner_id === user.id || (type.temporary && marker.created_by === user.id)) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Markierung loeschen';
      remove.addEventListener('click', async () => {
        const { error: deleteError } = await supabaseClient.from('hunting_markers').delete().eq('id', marker.id);
        if (deleteError) profileStatus(`Markierung konnte nicht geloescht werden: ${deleteError.message}`);
        else await loadProfileMarkers();
      });
      popup.append(remove);
    }
    const mapMarker = L.marker([marker.latitude, marker.longitude], {
      icon: L.icon({
        iconUrl: type.iconUrl,
        iconSize: type.iconSize,
        iconAnchor: type.iconAnchor,
        popupAnchor: type.popupAnchor,
        alt: type.label,
        title: type.label
      })
    }).bindPopup(popup);
    mapMarker.on('add', () => {
      const iconElement = mapMarker.getElement();
      if (iconElement) iconElement.setAttribute('aria-label', type.label);
    });
    mapMarker.addTo(profileMarkers);
    if (expiresAt !== null) {
      markerExpiryTimers.push(setTimeout(() => profileMarkers.removeLayer(mapMarker), Math.max(0, expiresAt - Date.now())));
    }
  });
}

setInterval(() => {
  if (activeProfile && user && !document.hidden && !markerPending &&
    !profileMarkers.getLayers().some(marker => marker.isPopupOpen())) void loadProfileMarkers();
}, 30000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && activeProfile && user) void loadProfileMarkers();
});

async function stopProfileLocation() {
  if (locationInterval !== null) clearInterval(locationInterval);
  locationInterval = null;
  locationRequestPending = false;
  const previousProfileId = sharingProfileId;
  sharingProfileId = null;
  sharedLocationIsInBoundary = false;
  if (presenceInterval !== null) clearInterval(presenceInterval);
  presenceInterval = null;
  presenceRevision += 1;
  profileLocations.clearLayers();
  if (previousProfileId && user && supabaseClient) {
    const { error } = await supabaseClient.from('hunting_profile_locations').delete()
      .eq('profile_id', previousProfileId).eq('user_id', user.id);
    if (error) profileStatus(`Standort konnte nicht entfernt werden: ${error.message}`);
  }
}

async function loadProfileLocations() {
  const revision = ++presenceRevision;
  if (!activeProfile || !user || !supabaseClient) return;
  const freshAfter = new Date(Date.now() - 90000).toISOString();
  const { data, error } = await supabaseClient.from('hunting_profile_locations')
    .select('user_id,latitude,longitude,accuracy,updated_at')
    .eq('profile_id', activeProfile.id).gte('updated_at', freshAfter);
  if (revision !== presenceRevision || !activeProfile || !user) return;
  profileLocations.clearLayers();
  element('location-key').hidden = true;
  if (error) {
    element('presence-status').hidden = false;
    element('presence-status').textContent = `Standorte nicht verfuegbar. Datenbankschema aktualisieren. (${error.message})`;
    return;
  }
  (data || []).forEach(location => {
    const marker = L.marker([location.latitude, location.longitude], {
      icon: L.divIcon({
        className: 'profile-location-marker',
        html: '<span class="person-location-swatch"><i data-lucide="user-round" aria-hidden="true"></i></span>',
        iconSize: [36, 36],
        iconAnchor: [18, 18],
        popupAnchor: [0, -18]
      })
    });
    marker.on('add', () => {
      const markerElement = marker.getElement();
      if (!markerElement) return;
      markerElement.setAttribute('role', 'img');
      markerElement.setAttribute('aria-label', `Benutzer ${location.user_id.slice(0, 8)}`);
      window.lucide?.createIcons({ root: markerElement });
    });
    const popup = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = `Benutzer ${location.user_id.slice(0, 8)}`;
    const time = document.createElement('span');
    time.textContent = `Aktualisiert ${new Date(location.updated_at).toLocaleTimeString('de-DE')}; Genauigkeit ${Math.round(location.accuracy)} m`;
    popup.append(label, time);
    marker.bindPopup(popup).addTo(profileLocations);
  });
  element('location-key').hidden = !data?.length;
  element('presence-status').hidden = false;
  element('presence-status').textContent = data?.length
    ? `${data.length} aktuelle Standortfreigabe${data.length === 1 ? '' : 'n'} im Revier.`
    : 'Aktuell keine Benutzer im Revier.';
}

async function activateProfile(profile) {
  const revision = ++profileActivationRevision;
  await stopProfileLocation();
  if (revision !== profileActivationRevision) return;
  activeProfile = null;
  element('profile-list').value = '';
  element('presence-status').hidden = true;
  updateProfileControls();
  if (!profile) {
    clearProfileMarkers();
    element('presence-status').hidden = true;
    profileStatus('Du siehst dieses Revier wie ein Gast.');
    return;
  }
  if (profile.owner_id === user?.id) {
    activeProfile = profile;
    element('profile-list').value = profile.id;
    updateProfileControls();
    await registerProfileBoundary(profile);
    if (revision !== profileActivationRevision || activeProfile?.id !== profile.id) return;
    await loadProfileMarkers();
    element('presence-status').hidden = false;
    void loadProfileLocations();
    presenceInterval = setInterval(() => void loadProfileLocations(), 30000);
    return;
  }
  if (!navigator.geolocation) {
    profileStatus('Standortfreigabe nicht verfuegbar. Das Revier wird wie fuer einen Gast angezeigt.');
    return;
  }
  sharingProfileId = profile.id;
  const { error: clearError } = await supabaseClient.from('hunting_profile_locations').delete()
    .eq('profile_id', profile.id).eq('user_id', user.id);
  if (revision !== profileActivationRevision) return;
  if (clearError) profileStatus(`Vorherige Standortfreigabe konnte nicht entfernt werden: ${clearError.message}`);
  const updateSharedLocation = async position => {
    if (sharingProfileId !== profile.id || !user) return;
    if (activeProfile?.id !== profile.id) {
      activeProfile = profile;
      element('profile-list').value = profile.id;
      updateProfileControls();
      void loadProfileMarkers();
      element('presence-status').hidden = false;
      void loadProfileLocations();
      presenceInterval = setInterval(() => void loadProfileLocations(), 30000);
      profileStatus('Standortfreigabe aktiv. Mitglieder dieses Revierprofils sehen einander.');
    }
    const point = { lat: position.coords.latitude, lng: position.coords.longitude };
    if (!pointInSelectedFeature(point)) {
      if (sharedLocationIsInBoundary) {
        sharedLocationIsInBoundary = false;
        const { error } = await supabaseClient.from('hunting_profile_locations').delete()
          .eq('profile_id', profile.id).eq('user_id', user.id);
        if (error) profileStatus(`Standort ausserhalb des Reviers konnte nicht entfernt werden: ${error.message}`);
      }
      return;
    }
    sharedLocationIsInBoundary = true;
    const { error } = await supabaseClient.from('hunting_profile_locations').upsert({
      profile_id: profile.id,
      user_id: user.id,
      latitude: point.lat,
      longitude: point.lng,
      accuracy: position.coords.accuracy,
      updated_at: new Date().toISOString()
    }, { onConflict: 'profile_id,user_id' });
    if (error) profileStatus(`Standort konnte nicht uebermittelt werden: ${error.message}. Datenbankschema aus schema.sql pruefen.`);
  };
  const requestLocation = () => {
    if (sharingProfileId !== profile.id || locationRequestPending) return;
    locationRequestPending = true;
    navigator.geolocation.getCurrentPosition(position => {
      locationRequestPending = false;
      void updateSharedLocation(position);
    }, error => {
      locationRequestPending = false;
    if (sharingProfileId !== profile.id) return;
    if (error.code === 1) void rejectProfileSelection(profile, 'Standortzugriff abgelehnt. Das Revier wird wie fuer einen Gast angezeigt.');
    else profileStatus('Warte auf eine verfuegbare Standortbestimmung.');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  };
  profileStatus('Browser-Standortfreigabe wird angefordert ...');
  requestLocation();
  locationInterval = setInterval(requestLocation, 30000);
}

async function rejectProfileSelection(profile, message) {
  if (sharingProfileId !== profile.id && activeProfile?.id !== profile.id) return;
  const revision = ++profileActivationRevision;
  await stopProfileLocation();
  if (revision !== profileActivationRevision) return;
  activeProfile = null;
  element('profile-list').value = '';
  clearProfileMarkers();
  element('presence-status').hidden = true;
  updateProfileControls();
  profileStatus(message);
}

async function loadProfiles(preferredId) {
  const revision = ++profileRevision;
  profiles = [];
  activeProfile = null;
  clearProfileMarkers();
  resetMarkerPlacement();
  updateProfileControls();
  const source = currentSource();
  const featureId = selectedFeatureId();
  if (!user || !selected || !source || !featureId) {
    profileStatus('Fuer dieses Revier ist keine stabile Kennung vorhanden.');
    return;
  }
  profileStatus('Profile werden geladen ...');
  const { data, error } = await supabaseClient.from('hunting_profiles')
    .select('id,source_id,feature_id,district_name,owner_id,created_at')
    .eq('source_id', source.id).eq('feature_id', featureId).order('created_at');
  if (revision !== profileRevision) return;
  if (error) {
    profileStatus(`Profile nicht verfuegbar. Datenbankschema aus schema.sql einrichten. (${error.message})`);
    return;
  }
  profiles = data || [];
  const profileSelect = element('profile-list');
  profileSelect.replaceChildren();
  profiles.forEach(profile => {
    const option = document.createElement('option');
    option.value = profile.id;
    const profileLabel = profile.owner_id === user.id ? 'Mein Profil' : `Geteiltes Profil ${profile.owner_id.slice(0, 8)}`;
    option.textContent = `${profileLabel} - ${profile.district_name}`;
    profileSelect.append(option);
  });
  const guestOption = document.createElement('option');
  guestOption.value = '';
  guestOption.textContent = 'Als Gast ansehen';
  profileSelect.prepend(guestOption);
  activeProfile = profiles.find(profile => profile.id === preferredId && profile.owner_id === user.id) ||
    profiles.find(profile => profile.owner_id === user.id) || null;
  if (activeProfile) profileSelect.value = activeProfile.id;
  profileSelect.hidden = profiles.length === 0;
  profileStatus(profiles.length ? `${profiles.length} unabhaengige(s) Revierprofil(e).` : 'Noch kein Profil fuer dieses Revier.');
  updateProfileControls();
  if (activeProfile) await registerProfileBoundary(activeProfile);
  if (revision !== profileRevision) return;
  await loadProfileMarkers();
  if (activeProfile?.owner_id === user.id) {
    element('presence-status').hidden = false;
    void loadProfileLocations();
    presenceInterval = setInterval(() => void loadProfileLocations(), 10000);
  }
}

function clearSelection() {
  profileActivationRevision += 1;
  void stopProfileLocation();
  pendingProfileId = null;
  if (element('location-consent-dialog').open) element('location-consent-dialog').close();
  if (boundary) map.removeLayer(boundary);
  boundary = null;
  selected = null;
  profiles = [];
  activeProfile = null;
  profileRevision += 1;
  clearProfileMarkers();
  profileLocations.clearLayers();
  element('location-key').hidden = true;
  resetMarkerPlacement();
  element('profile-list').replaceChildren();
  element('profile-list').hidden = true;
  element('presence-status').hidden = true;
  element('invite-form').hidden = true;
  element('invite-toggle').hidden = true;
  element('add-marker').hidden = true;
  element('claim-profile').hidden = true;
  profileStatus('Waehle ein Revier aus.');
  element('selection').hidden = true;
  element('fit').disabled = true;
  element('results').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', 'false'));
}

function selectFeature(feature, button) {
  clearSelection();
  selected = feature;
  const source = currentSource();
  boundary = L.geoJSON(feature, { style: { color: '#c43b55', weight: 3, fillColor: '#c43b55', fillOpacity: .14 } });
  if (element('show-boundary').checked) boundary.addTo(map);
  map.fitBounds(boundary.getBounds(), { padding: [24, 24], maxZoom: 16 });
  element('selected-name').textContent = featureName(feature, source);
  element('details').replaceChildren();
  Object.entries(feature.properties || {}).forEach(([key, value]) => {
    if (value === null || typeof value === 'object') return;
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = ({ id: 'Nummer', gid: 'Datensatz', revierdate: 'Revierart', revierda_1: 'Name', jagdbezirk: 'Jagdbezirk', hektar: 'Flaeche (ha)' })[key] || key;
    detail.textContent = String(value);
    element('details').append(term, detail);
  });
  button.setAttribute('aria-pressed', 'true');
  element('selection').hidden = false;
  element('fit').disabled = false;
  element('profile-section').hidden = !user;
  if (user) void loadProfiles();
}

function pointOnSegment(point, start, end) {
  const cross = (point.lng - start[0]) * (end[1] - start[1]) - (point.lat - start[1]) * (end[0] - start[0]);
  if (Math.abs(cross) > 1e-10) return false;
  return point.lng >= Math.min(start[0], end[0]) - 1e-10 && point.lng <= Math.max(start[0], end[0]) + 1e-10 &&
    point.lat >= Math.min(start[1], end[1]) - 1e-10 && point.lat <= Math.max(start[1], end[1]) + 1e-10;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const start = ring[previous];
    const end = ring[index];
    if (pointOnSegment(point, start, end)) return true;
    const crosses = (start[1] > point.lat) !== (end[1] > point.lat) &&
      point.lng < (end[0] - start[0]) * (point.lat - start[1]) / (end[1] - start[1]) + start[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInSelectedFeature(point) {
  const geometry = selected?.geometry;
  if (geometry?.type === 'Polygon') {
    return pointInRing(point, geometry.coordinates[0]) && !geometry.coordinates.slice(1).some(ring => pointInRing(point, ring));
  }
  if (geometry?.type === 'MultiPolygon') {
    return geometry.coordinates.some(polygon => pointInRing(point, polygon[0]) && !polygon.slice(1).some(ring => pointInRing(point, ring)));
  }
  return false;
}

function renderResults() {
  const query = element('query').value.trim().toLocaleLowerCase('de');
  const matches = features.filter(feature => Object.values(feature.properties || {}).some(value =>
    value !== null && typeof value !== 'object' && String(value).toLocaleLowerCase('de').includes(query)));
  element('results').replaceChildren();
  element('result-count').textContent = String(matches.length);
  const source = currentSource();
  matches.slice(0, 200).forEach(feature => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(feature === selected));
    const name = document.createElement('strong');
    name.textContent = featureName(feature, source);
    const subtitle = document.createElement('small');
    subtitle.textContent = [feature.properties?.revierdate, feature.properties?.id != null ? `Nr. ${feature.properties.id}` : null,
      feature.properties?.hektar != null ? `${feature.properties.hektar} ha` : null].filter(Boolean).join(' / ') || source.label;
    button.append(name, subtitle);
    button.addEventListener('click', () => selectFeature(feature, button));
    item.append(button);
    element('results').append(item);
  });
  const updated = boundaryUpdatedAt ? ` (Grenzstand ${new Date(boundaryUpdatedAt).toLocaleString('de-DE')})` : '';
  status(matches.length
    ? `${matches.length} Reviere${matches.length > 200 ? ', erste 200 angezeigt' : ''}.${updated}`
    : `Keine passenden Reviere gefunden.${updated}`);
}

function updateSource() {
  const source = currentSource();
  if (sourceAttribution) map.attributionControl.removeAttribution(sourceAttribution);
  sourceAttribution = '';
  if (!source) return;
  document.querySelector('.source-note span').textContent = source.snapshotDate
    ? `Datenstand: ${source.snapshotDate} (lokaler Snapshot)`
    : 'Verfuegbare Abdeckung: konfigurierte Regionen';
  element('source-link').href = source.metadataUrl;
  element('license-link').href = source.licenseUrl;
  element('license-link').textContent = source.license;
  const attribution = document.createElement('span');
  attribution.textContent = `${source.attribution} (${source.license}); Darstellung unveraendert`;
  sourceAttribution = attribution.outerHTML;
  map.attributionControl.addAttribution(sourceAttribution);
}

function boundaryCacheRequest(source) {
  return new Request(new URL(`./__boundary-cache__/${encodeURIComponent(source.id)}.json`, location.href));
}

async function readBoundaryCache(source) {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open(boundaryCacheName);
    const response = await cache.match(boundaryCacheRequest(source));
    if (!response) return null;
    const collection = await response.json();
    return { features: boundaries(collection), updatedAt: response.headers.get('x-jagdkarte-cached-at') };
  } catch { return null; }
}

async function writeBoundaryCache(source, loadedFeatures) {
  if (!('caches' in window)) return null;
  try {
    const updatedAt = new Date().toISOString();
    const response = new Response(JSON.stringify({ type: 'FeatureCollection', features: loadedFeatures }), {
      headers: { 'Content-Type': 'application/geo+json', 'X-Jagdkarte-Cached-At': updatedAt }
    });
    const cache = await caches.open(boundaryCacheName);
    await cache.put(boundaryCacheRequest(source), response);
    return updatedAt;
  } catch { return null; }
}

function showBoundaries() {
  if (features.length) map.fitBounds(L.geoJSON({ type: 'FeatureCollection', features }).getBounds(), { padding: [25, 25], maxZoom: 11 });
  renderResults();
}

async function fetchSelectedBoundaries(source, revision) {
  const requestController = new AbortController();
  controller = requestController;
  const timeout = setTimeout(() => requestController.abort('timeout'), 30000);
  element('search-form').setAttribute('aria-busy', 'true');
  element('refresh-boundaries').disabled = true;
  status(features.length ? 'Reviergrenzen werden aktualisiert ...' : 'Reviergrenzen werden erstmals geladen ...');
  try {
    const loaded = await loadBoundaries(source, requestController.signal);
    if (controller !== requestController || revision !== boundaryLoadRevision) return;
    features = loaded;
    boundaryUpdatedAt = await writeBoundaryCache(source, loaded) || new Date().toISOString();
    if (revision === boundaryLoadRevision) showBoundaries();
  } catch (error) {
    if (controller !== requestController || revision !== boundaryLoadRevision) return;
    const reason = requestController.signal.aborted
      ? 'Zeitueberschreitung.'
      : `Datenquelle nicht erreichbar: ${error.message}.`;
    status(features.length
      ? `${reason} Gespeicherte Reviergrenzen bleiben sichtbar.`
      : `${reason} Verbindung oder CORS-Freigabe pruefen.`);
  } finally {
    clearTimeout(timeout);
    if (controller === requestController) {
      controller = null;
      element('search-form').setAttribute('aria-busy', 'false');
      element('refresh-boundaries').disabled = !currentSource();
    }
  }
}

async function loadSelectedSource() {
  const source = currentSource();
  const revision = ++boundaryLoadRevision;
  controller?.abort();
  controller = null;
  element('search-form').setAttribute('aria-busy', 'false');
  clearSelection();
  features = [];
  boundaryUpdatedAt = null;
  element('results').replaceChildren();
  element('result-count').textContent = '0';
  updateSource();
  element('refresh-boundaries').disabled = !source;
  if (!source) {
    status('Bitte zuerst eine Region auswaehlen.');
    return;
  }
  status('Gespeicherte Reviergrenzen werden gesucht ...');
  const cached = await readBoundaryCache(source);
  if (revision !== boundaryLoadRevision || currentSource()?.id !== source.id) return;
  if (cached?.features.length) {
    features = cached.features;
    boundaryUpdatedAt = cached.updatedAt;
    showBoundaries();
    return;
  }
  await fetchSelectedBoundaries(source, revision);
}

function refreshSelectedSource() {
  const source = currentSource();
  if (!source) {
    status('Bitte zuerst eine Region auswaehlen.');
    return;
  }
  const revision = ++boundaryLoadRevision;
  controller?.abort();
  clearSelection();
  void fetchSelectedBoundaries(source, revision);
}

config.sources.forEach(source => {
  const option = document.createElement('option');
  option.value = source.id;
  option.textContent = source.label;
  element('source').append(option);
});
updateSource();
status('Region auswaehlen, um Reviere zu laden.');
element('refresh-boundaries').disabled = true;
element('source').addEventListener('change', loadSelectedSource);
element('refresh-boundaries').addEventListener('click', refreshSelectedSource);
element('search-form').addEventListener('submit', event => {
  event.preventDefault();
  if (features.length) renderResults();
  else status(currentSource()
    ? 'Reviergrenzen werden geladen. Bitte kurz warten oder Aktualisieren auswaehlen.'
    : 'Bitte zuerst eine Region auswaehlen.');
});
element('query').addEventListener('input', () => { if (features.length) renderResults(); });
element('clear').addEventListener('click', clearSelection);
element('fit').addEventListener('click', () => { if (boundary) map.fitBounds(boundary.getBounds(), { padding: [24, 24], maxZoom: 16 }); });
function syncMapFullscreen() {
  const fullscreen = document.fullscreenElement === mapSurface || mapSurface.classList.contains('is-fullscreen');
  const label = fullscreen ? 'Vollbild beenden' : 'Karte im Vollbild anzeigen';
  element('fullscreen-map').title = label;
  element('fullscreen-map').setAttribute('aria-label', label);
  element('fullscreen-map').setAttribute('aria-pressed', String(fullscreen));
  element('fullscreen-enter-icon').hidden = fullscreen;
  element('fullscreen-exit-icon').hidden = !fullscreen;
  requestAnimationFrame(() => map.invalidateSize());
}
element('fullscreen-map').addEventListener('click', async () => {
  if (document.fullscreenElement === mapSurface) {
    await document.exitFullscreen();
  } else if (mapSurface.classList.contains('is-fullscreen')) {
    mapSurface.classList.remove('is-fullscreen');
    syncMapFullscreen();
  } else if (mapSurface.requestFullscreen) {
    try { await mapSurface.requestFullscreen(); }
    catch { mapSurface.classList.add('is-fullscreen'); syncMapFullscreen(); }
  } else {
    mapSurface.classList.add('is-fullscreen');
    syncMapFullscreen();
  }
});
document.addEventListener('fullscreenchange', syncMapFullscreen);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.fullscreenElement && mapSurface.classList.contains('is-fullscreen')) {
    mapSurface.classList.remove('is-fullscreen');
    syncMapFullscreen();
  }
});
element('show-boundary').addEventListener('change', event => {
  if (!boundary) return;
  if (event.target.checked) boundary.addTo(map); else map.removeLayer(boundary);
});
element('claim-profile').addEventListener('click', async () => {
  if (!user || !selected || !supabaseClient) return;
  const featureId = selectedFeatureId();
  if (!featureId) { profileStatus('Dieses Revier hat keine stabile Kennung und kann nicht als Profil gespeichert werden.'); return; }
  const source = currentSource();
  element('claim-profile').disabled = true;
  profileStatus('Eigenes Revierprofil wird angelegt ...');
  const { data, error } = await supabaseClient.rpc('create_hunting_profile', {
    p_source_id: source.id, p_feature_id: featureId, p_district_name: featureName(selected, source)
  });
  element('claim-profile').disabled = false;
  if (error) { profileStatus(`Profil konnte nicht angelegt werden: ${error.message}. Datenbankschema aus schema.sql pruefen.`); return; }
  await loadProfiles(data?.id || data?.[0]?.id);
});
element('profile-list').addEventListener('change', async event => {
  const profile = profiles.find(candidate => candidate.id === event.target.value) || null;
  const revision = ++profileActivationRevision;
  await stopProfileLocation();
  if (revision !== profileActivationRevision) return;
  activeProfile = null;
  resetMarkerPlacement();
  element('invite-form').hidden = true;
  clearProfileMarkers();
  updateProfileControls();
  if (!profile) {
    element('presence-status').hidden = true;
    profileStatus('Du siehst dieses Revier wie ein Gast.');
    return;
  }
  if (profile.owner_id === user?.id) {
    await activateProfile(profile);
    return;
  }
  element('presence-status').hidden = true;
  pendingProfileId = profile.id;
  event.target.value = '';
  element('location-consent-dialog').showModal();
});
element('accept-location').addEventListener('click', () => {
  const profile = profiles.find(candidate => candidate.id === pendingProfileId);
  pendingProfileId = null;
  element('location-consent-dialog').close();
  if (profile) void activateProfile(profile);
});
function declineProfileLocation() {
  profileActivationRevision += 1;
  pendingProfileId = null;
  element('location-consent-dialog').close();
  element('profile-list').value = '';
  activeProfile = null;
  clearProfileMarkers();
  element('presence-status').hidden = true;
  updateProfileControls();
  profileStatus('Standortfreigabe abgelehnt. Du siehst dieses Revier wie ein Gast.');
}
element('decline-location').addEventListener('click', declineProfileLocation);
element('location-consent-dialog').addEventListener('cancel', event => {
  event.preventDefault();
  declineProfileLocation();
});
element('invite-toggle').addEventListener('click', () => {
  element('invite-form').hidden = !element('invite-form').hidden;
  if (!element('invite-form').hidden) element('invite-email').focus();
});
element('invite-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!auth || !supabaseClient || !activeProfile || activeProfile.owner_id !== user?.id) return;
  const email = element('invite-email').value.trim().toLocaleLowerCase('en-US');
  const button = element('invite-form').querySelector('button[type="submit"]');
  button.disabled = true;
  profileStatus('Einladung wird vorbereitet ...');
  const { error: inviteError } = await supabaseClient.rpc('invite_hunting_profile_member', {
    p_profile_id: activeProfile.id, p_email: email
  });
  if (inviteError) {
    profileStatus(`Einladung fehlgeschlagen: ${inviteError.message}`);
    button.disabled = false;
    return;
  }
  const redirect = new URL('./', location.href);
  const { error: emailError } = await auth.signInWithOtp({ email, options: {
    emailRedirectTo: redirect.href, shouldCreateUser: true
  } });
  button.disabled = false;
  if (emailError) {
    profileStatus(`Einladung gespeichert, E-Mail konnte nicht versendet werden: ${emailError.message}`);
    return;
  }
  element('invite-email').value = '';
  profileStatus('Einladungslink per E-Mail angefordert. Nach bestaetigter Anmeldung wird dieses Profil lesbar.');
});
element('add-marker').addEventListener('click', () => {
  if (!activeProfile || !user || markerPending) return;
  placementMode = !placementMode;
  markerCoordinates = null;
  element('marker-form').hidden = true;
  element('marker-instruction').hidden = !placementMode;
  element('add-marker').setAttribute('aria-pressed', String(placementMode));
});
element('cancel-marker').addEventListener('click', resetMarkerPlacement);
map.on('click', event => {
  if (!placementMode) return;
  if (!pointInSelectedFeature(event.latlng)) {
    profileStatus('Markierungen muessen innerhalb des ausgewaehlten Jagdbezirks liegen.');
    return;
  }
  markerCoordinates = event.latlng;
  placementMode = false;
  element('marker-instruction').hidden = true;
  element('marker-coordinates').textContent = `${event.latlng.lat.toFixed(5)}, ${event.latlng.lng.toFixed(5)}`;
  element('marker-form').hidden = false;
  element('add-marker').setAttribute('aria-pressed', 'false');
  element('marker-title').focus();
});
element('marker-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!supabaseClient || !markerCoordinates || !activeProfile || !user || markerPending) return;
  const type = markerTypesById.get(element('marker-type').value);
  if (!type || (!type.temporary && activeProfile.owner_id !== user.id)) return;
  const profileId = activeProfile.id;
  const userId = user.id;
  const feature = selected;
  const coordinates = { lat: markerCoordinates.lat, lng: markerCoordinates.lng };
  if (!pointInSelectedFeature(coordinates)) {
    profileStatus('Markierungen muessen innerhalb des ausgewaehlten Jagdbezirks liegen.');
    return;
  }
  const button = element('marker-form').querySelector('button[type="submit"]');
  markerPending = true;
  button.disabled = true;
  const title = element('marker-title').value.trim() || type.label;
  const notes = element('marker-notes').value.trim();
  try {
    let result;
    if (type.temporary) {
      if (!navigator.geolocation) throw new Error('Standortbestimmung nicht verfuegbar.');
      profileStatus('Aktueller Standort wird geprueft ...');
      const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve,
        error => reject(new Error(error.code === 1 ? 'Standortzugriff nicht erlaubt.' : 'Standort konnte nicht bestimmt werden.')),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }));
      if (activeProfile?.id !== profileId || user?.id !== userId || selected !== feature) return;
      if (!pointInSelectedFeature({ lat: position.coords.latitude, lng: position.coords.longitude })) {
        throw new Error('Dein aktueller Standort liegt ausserhalb des Reviers.');
      }
      result = await supabaseClient.rpc('create_temporary_hunting_marker', {
        p_profile_id: profileId, p_type_id: type.id, p_title: title, p_notes: notes,
        p_latitude: coordinates.lat, p_longitude: coordinates.lng,
        p_user_latitude: position.coords.latitude, p_user_longitude: position.coords.longitude
      });
    } else {
      result = await supabaseClient.from('hunting_markers').insert({
        profile_id: profileId, type_id: type.id, title, notes,
        latitude: coordinates.lat, longitude: coordinates.lng, created_by: userId
      });
    }
    if (activeProfile?.id !== profileId || user?.id !== userId || selected !== feature) return;
    if (result.error) throw new Error(result.error.message);
    resetMarkerPlacement();
    profileStatus('Markierung gespeichert.');
    await loadProfileMarkers();
  } catch (error) {
    if (activeProfile?.id === profileId && user?.id === userId && selected === feature) {
      profileStatus(`Markierung konnte nicht gespeichert werden: ${error.message}`);
    }
  } finally {
    markerPending = false;
    button.disabled = false;
  }
});
element('download').addEventListener('click', () => {
  if (!selected) return;
  const source = currentSource();
  const blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features: [selected],
    source: source.metadataUrl, attribution: source.attribution, license: source.license,
    sourceSnapshotDate: source.snapshotDate || null, retrievedAt: new Date().toISOString()
  }, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'jagdbezirk.geojson';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
element('locate').addEventListener('click', () => {
  showMapStatus('Standort wird bestimmt ...', 'pending');
  if (!navigator.geolocation) { showMapStatus('Standortbestimmung nicht verfuegbar.', 'error'); return; }
  navigator.geolocation.getCurrentPosition(position => {
    const coordinates = [position.coords.latitude, position.coords.longitude];
    if (locationLayer) map.removeLayer(locationLayer);
    const accuracyText = `Standortgenauigkeit: ${Math.round(position.coords.accuracy)} m`;
    locationLayer = L.featureGroup([L.circle(coordinates, { radius: position.coords.accuracy, color: '#257aa5', weight: 1 }),
      L.circleMarker(coordinates, { radius: 6, color: '#fff', weight: 2, fillColor: '#257aa5', fillOpacity: 1 }).bindPopup(accuracyText)]).addTo(map);
    map.setView(coordinates, 14);
    showMapStatus(accuracyText);
  }, error => { showMapStatus(error.code === 1 ? 'Standortzugriff nicht erlaubt.' : 'Standort konnte nicht bestimmt werden.', 'error'); }, { timeout: 15000, maximumAge: 60000 });
});

async function applySession(session) {
  const revision = ++authRevision;
  let verified = null;
  if (session) {
    const { data, error } = await auth.getUser();
    if (!error) verified = data.user;
  }
  if (revision !== authRevision) return;
  if (user && (!verified || verified.id !== user.id)) {
    profileActivationRevision += 1;
    await stopProfileLocation();
  }
  const previousId = user?.id;
  user = verified;
  if (verified && previousId !== verified.id) {
    const { error } = await supabaseClient.rpc('accept_hunting_profile_invitations');
    if (error) profileStatus(`Einladungen konnten nicht angenommen werden: ${error.message}`);
  }
  element('search-fields').disabled = false;
  element('auth-notice').hidden = Boolean(user);
  element('auth-notice').textContent = 'Reviergrenzen sind frei zugaenglich. Melde dich an, um Revierprofile und Markierungen zu sehen.';
  element('user-label').textContent = user?.email || 'Nicht angemeldet';
  element('account-button').querySelector('span').textContent = user ? 'Abmelden' : 'Anmelden';
  if (!user) {
    controller?.abort();
    controller = null;
    profiles = [];
    activeProfile = null;
    profileRevision += 1;
    clearProfileMarkers();
    resetMarkerPlacement();
    element('profile-section').hidden = true;
    element('profile-list').replaceChildren();
    element('profile-list').hidden = true;
    element('invite-form').hidden = true;
    element('profile-status').textContent = 'Melde dich an, um Revierprofile zu sehen.';
    updateProfileControls();
    if (features.length) renderResults();
    else if (!currentSource() && !controller) status('Region auswaehlen, um Reviere zu laden.');
  } else if (previousId !== user.id) {
    element('login-dialog').close();
    if (selected) {
      element('profile-section').hidden = false;
      void loadProfiles();
    }
  }
}

element('account-button').addEventListener('click', async () => {
  if (user) {
    profileActivationRevision += 1;
    await stopProfileLocation();
    const { error } = await auth.signOut();
    if (error) status(`Abmeldung fehlgeschlagen: ${error.message}`);
    else await applySession(null);
  } else element('login-dialog').showModal();
});
element('close-login').addEventListener('click', () => element('login-dialog').close());
element('auth-modes').addEventListener('change', () => {
  const registering = document.querySelector('input[name="auth-mode"]:checked').value === 'register';
  element('login-title').textContent = registering ? 'Registrieren' : 'Anmelden';
  element('send-link').querySelector('span').textContent = registering ? 'Registrierungslink senden' : 'Anmeldelink senden';
  if (auth) element('login-status').textContent = '';
});
element('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!auth || authPending) return;
  const registering = document.querySelector('input[name="auth-mode"]:checked').value === 'register';
  const email = element('email').value.trim();
  authPending = true;
  element('send-link').disabled = true;
  element('email').disabled = true;
  element('auth-modes').disabled = true;
  element('login-form').setAttribute('aria-busy', 'true');
  element('login-status').textContent = registering ? 'Registrierungslink wird angefordert ...' : 'Anmeldelink wird angefordert ...';
  try {
    const redirect = new URL('./', location.href);
    const { error } = await auth.signInWithOtp({ email, options: {
      emailRedirectTo: redirect.href,
      shouldCreateUser: registering
    } });
    element('login-status').textContent = error
      ? `${registering ? 'Registrierung' : 'Anmeldung'} fehlgeschlagen: ${error.message}`
      : registering
        ? 'Registrierungs-E-Mail angefordert. Bitte den Link oeffnen, um die E-Mail-Adresse zu bestaetigen; auch den Spamordner pruefen.'
        : 'E-Mail angefordert. Bitte den Anmeldelink oeffnen; auch den Spamordner pruefen.';
  } catch { element('login-status').textContent = 'Anmeldedienst nicht erreichbar. Bitte erneut versuchen.'; }
  finally {
    authPending = false;
    element('send-link').disabled = false;
    element('email').disabled = false;
    element('auth-modes').disabled = false;
    element('login-form').setAttribute('aria-busy', 'false');
  }
});

if (config.supabaseUrl && config.supabasePublishableKey && window.supabase) {
  try { await loadMarkerTypes(); }
  catch (error) { profileStatus(`Objekttyp-Konfiguration konnte nicht geladen werden: ${error.message}`); }
  supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { flowType: 'pkce', persistSession: true }
  });
  auth = supabaseClient.auth;
  auth.onAuthStateChange((_event, session) => { setTimeout(() => applySession(session), 0); });
  const callbackUrl = new URL(location.href);
  const tokenHash = callbackUrl.searchParams.get('token_hash');
  if (tokenHash) {
    const tokenType = callbackUrl.searchParams.get('type');
    callbackUrl.searchParams.delete('token_hash');
    callbackUrl.searchParams.delete('type');
    history.replaceState(history.state, '', `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`);
    element('login-dialog').showModal();
    if (tokenType !== 'email') {
      element('login-status').textContent = 'Der Anmeldelink ist ungueltig oder wird nicht unterstuetzt.';
    } else {
      element('login-status').textContent = 'Anmeldelink wird bestaetigt ...';
      try {
        const { data: verification, error: verificationError } = await auth.verifyOtp({
          token_hash: tokenHash,
          type: 'email'
        });
        if (verificationError) {
          element('login-status').textContent = `Anmeldelink ungueltig oder abgelaufen: ${verificationError.message}`;
        } else {
          await applySession(verification.session);
          element('login-dialog').close();
          element('login-status').textContent = 'Anmeldung erfolgreich.';
        }
      } catch {
        element('login-status').textContent = 'Anmeldedienst nicht erreichbar. Bitte erneut versuchen.';
      }
    }
  }
  const { data, error } = await auth.getSession();
  if (error) element('login-status').textContent = error.message;
  await applySession(data.session);
} else {
  element('search-fields').disabled = false;
  element('send-link').disabled = true;
  element('email').disabled = true;
  element('auth-notice').textContent = 'Reviergrenzen sind frei zugaenglich. Der Anmeldedienst fuer Revierprofile ist noch nicht eingerichtet.';
  element('login-status').textContent = 'Supabase-Projektadresse und oeffentlichen Publishable Key in config.js konfigurieren. Es werden keine Anmeldedaten lokal simuliert.';
  status('Region auswaehlen, um Reviere zu laden.');
}

function networkState() {
  element('network').textContent = navigator.onLine ? 'Online' : 'Offline';
  element('network').classList.toggle('offline', !navigator.onLine);
}
window.addEventListener('online', networkState);
window.addEventListener('offline', networkState);
networkState();
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; element('install').hidden = false; });
element('install').addEventListener('click', async () => { if (!installPrompt) return; await installPrompt.prompt(); installPrompt = null; element('install').hidden = true; });
window.addEventListener('appinstalled', () => { installPrompt = null; element('install').hidden = true; });
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { showMapStatus('Offline-App konnte nicht eingerichtet werden.', 'error'); });
}