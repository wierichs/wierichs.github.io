import { boundaries, loadBoundaries, featureName } from './data.js';
import { createJwdExport } from './jwd-import.js';

const config = window.JAGDKARTE_CONFIG;
const boundaryCacheName = 'jagdkarte-boundaries-v1';
const selectionStorageKey = 'jagdkarte-last-selection-v1';
const profileSelectionStorageKey = 'jagdkarte-last-profile-v1';
const locationConsentStorageKey = 'jagdkarte-location-consent-v1';
const markerIconSizeStorageKey = 'jagdkarte-marker-icon-size-v1';
const markerIconScales = { small: 0.8, standard: 1, large: 1.25 };
const element = id => document.getElementById(id);
function readLocationConsent(profile) {
  if (!user || !profile) return null;
  try {
    const consents = JSON.parse(localStorage.getItem(locationConsentStorageKey) || '{}');
    const consent = consents[`${user.id}:${profile.id}`];
    return typeof consent === 'boolean' ? consent : null;
  } catch { return null; }
}
function writeLocationConsent(profile, consent) {
  if (!user || !profile) return;
  try {
    const saved = JSON.parse(localStorage.getItem(locationConsentStorageKey) || '{}');
    const consents = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    consents[`${user.id}:${profile.id}`] = consent;
    localStorage.setItem(locationConsentStorageKey, JSON.stringify(consents));
  } catch {}
}
const map = L.map('map').setView([51.1, 10.4], 6);
const mapSurface = element('map-surface');
const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
const mapTilerApiKey = typeof config.mapTilerApiKey === 'string' ? config.mapTilerApiKey.trim() : '';
const satelliteViewButton = element('toggle-satellite');
if (mapTilerApiKey) {
  const satelliteTiles = L.tileLayer(
    `https://api.maptiler.com/maps/satellite-v4/{z}/{x}/{y}.jpg?key=${encodeURIComponent(mapTilerApiKey)}`,
    {
      tileSize: 512,
      zoomOffset: -1,
      minZoom: 1,
      maxZoom: 20,
      attribution: '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener"><img class="maptiler-attribution-logo" src="https://api.maptiler.com/resources/logo.svg" alt="MapTiler"> &copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>',
      crossOrigin: true
    }
  );
  satelliteTiles.on('tileerror', () => {
    if (satelliteTileWarningShown) return;
    showMapStatus('Satellitenkarte nicht verfuegbar. API-Key und Verbindung pruefen.', 'error');
    satelliteTileWarningShown = true;
  });
  satelliteViewButton.hidden = false;
  satelliteViewButton.addEventListener('click', () => {
    const satelliteEnabled = !map.hasLayer(satelliteTiles);
    const nextLayer = satelliteEnabled ? satelliteTiles : tiles;
    map.removeLayer(satelliteEnabled ? tiles : satelliteTiles);
    nextLayer.addTo(map);
    map.fire('baselayerchange', { layer: nextLayer, name: satelliteEnabled ? 'Satellit' : 'OpenStreetMap' });
  });
}
L.control.scale({ imperial: false }).addTo(map);
let user = null;
let auth = null;
let supabaseClient = null;
let authPending = false;
let requestedEmail = null;
let features = [];
let selected = null;
let savedSelection = readSavedSelection();
let boundary = null;
let locationLayer = null;
let controller = null;
let boundaryLoadRevision = 0;
let boundaryUpdatedAt = null;
let installPrompt = null;
let authRevision = 0;
let sourceAttribution = '';
let tileWarningShown = false;
let satelliteTileWarningShown = false;
let mapStatusTimer = null;
let profiles = [];
let savedProfiles = [];
let savedProfilesRevision = 0;
let savedOpenRevision = 0;
let savedProfilePending = false;
let profileImportPending = false;
let profileDeletePending = false;
let activeProfile = null;
let boundaryEditGeometry = null;
let selectedBoundaryVertex = null;
let selectedBoundaryPart = null;
let boundaryEditPending = false;
let placementMode = false;
let markerCoordinates = null;
let markerPending = false;
let markerExpiryTimers = [];
let profileRevision = 0;
let markerTypes = [];
let markerTypesById = new Map();
let fallbackMarkerType = 'sonstiges';
let markerIconSize = readMarkerIconSize();
let locationInterval = null;
let locationRequestPending = false;
let sharingProfileId = null;
let sharedLocationIsInBoundary = null;
let presenceInterval = null;
let huntingModeInterval = null;
let presenceRevision = 0;
let profileActivationRevision = 0;
let huntingModePending = false;
const profileMarkers = L.layerGroup().addTo(map);
const profileLocations = L.layerGroup().addTo(map);
const boundaryEditHandles = L.layerGroup().addTo(map);
const boundaryEditParts = L.layerGroup().addTo(map);

window.lucide?.createIcons();
new ResizeObserver(() => map.invalidateSize()).observe(element('map'));
element('toggle-map-legend').addEventListener('click', () => {
  const collapsed = !element('map-key').hidden;
  element('map-key').hidden = collapsed;
  const label = collapsed ? 'Legende anzeigen' : 'Legende ausblenden';
  element('toggle-map-legend').setAttribute('aria-expanded', String(!collapsed));
  element('toggle-map-legend').setAttribute('aria-label', label);
  element('toggle-map-legend').title = label;
});
element('toggle-search-panel').addEventListener('click', () => {
  const collapsed = element('app-layout').classList.toggle('search-collapsed');
  const label = collapsed ? 'Reviersuche aufklappen' : 'Reviersuche einklappen';
  element('search-panel-body').hidden = collapsed;
  element('toggle-search-panel').setAttribute('aria-expanded', String(!collapsed));
  element('toggle-search-panel').setAttribute('aria-label', label);
  element('toggle-search-panel').title = label;
  element('collapse-search-icon').toggleAttribute('hidden', collapsed);
  element('expand-search-icon').toggleAttribute('hidden', !collapsed);
});
map.on('baselayerchange', event => {
  if (event.name === 'Satellit') satelliteTileWarningShown = false;
  const satelliteEnabled = event.name === 'Satellit';
  const label = satelliteEnabled ? 'Straßenkarte anzeigen' : 'Satellitenansicht anzeigen';
  satelliteViewButton.setAttribute('aria-pressed', String(satelliteEnabled));
  satelliteViewButton.setAttribute('aria-label', label);
  satelliteViewButton.title = label;
});
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

function setDistrictTab(name, focus = false, refreshSaved = true) {
  for (const tabName of ['search', 'saved']) {
    const active = name === tabName;
    const tab = element(`${tabName}-tab`);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    element(`${tabName}-view`).hidden = !active;
    if (active && focus) tab.focus();
  }
  if (name === 'saved' && refreshSaved) void loadSavedProfiles();
}

element('search-tab').addEventListener('click', () => setDistrictTab('search'));
element('saved-tab').addEventListener('click', () => setDistrictTab('saved'));
element('district-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const name = event.key === 'Home' ? 'search' : event.key === 'End' ? 'saved'
    : element('search-tab').getAttribute('aria-selected') === 'true' ? 'saved' : 'search';
  setDistrictTab(name, true);
});
element('refresh-saved').addEventListener('click', () => void loadSavedProfiles());
element('import-profile').addEventListener('click', () => element('import-profile-file').click());
element('import-profile-file').addEventListener('change', event => {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = '';
  if (file) void importJwdProfile(file);
});

function chooseProfileImport(imported) {
  const candidates = imported.candidates || [imported];
  const dialog = element('boundary-import-dialog');
  const select = element('boundary-import-feature');
  const selectLabel = element('boundary-import-feature-label');
  const nameInput = element('boundary-import-name');
  select.replaceChildren(...candidates.map((candidate, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${candidate.name} (${index + 1})`;
    return option;
  }));
  select.hidden = candidates.length < 2;
  selectLabel.hidden = candidates.length < 2;
  nameInput.value = candidates[0].name;
  select.onchange = () => { nameInput.value = candidates[Number(select.value)].name; };
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      const candidate = candidates[Number(select.value)] || candidates[0];
      const name = nameInput.value.trim();
      resolve(dialog.returnValue === 'import' && name ? { ...candidate, name } : null);
    }, { once: true });
    dialog.showModal();
    (candidates.length > 1 ? select : nameInput).focus();
  });
}

function updateSavedProfileSelection() {
  for (const button of element('saved-profiles').querySelectorAll('button')) {
    const profile = savedProfiles.find(candidate => candidate.id === button.dataset.profileId);
    const active = Boolean(profile && selected && profile.source_id === currentSource()?.id &&
      profile.feature_id === selectedFeatureId() && (!activeProfile || activeProfile.id === profile.id));
    button.setAttribute('aria-pressed', String(active));
  }
}

function renderSavedProfiles() {
  element('saved-profiles').replaceChildren();
  for (const profile of savedProfiles) {
    const source = config.sources.find(candidate => candidate.id === profile.source_id);
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.profileId = profile.id;
    button.disabled = savedProfilePending;
    const name = document.createElement('strong');
    name.textContent = profile.owner_id === user?.id ? profile.district_name
      : `${profile.district_name} @${profile.owner_email || profile.owner_id.slice(0, 8)}`;
    const detail = document.createElement('small');
    detail.textContent = [source?.label || profile.source_id, profile.owner_id === user?.id
      ? 'Eigen' : profile.member_role === 'editor' ? 'Bearbeiter' : 'Gast'].join(' / ');
    button.append(name, detail);
    button.addEventListener('click', () => void openSavedProfile(profile));
    item.append(button);
    element('saved-profiles').append(item);
  }
  updateSavedProfileSelection();
}

async function loadSavedProfiles() {
  const revision = ++savedProfilesRevision;
  element('refresh-saved').disabled = true;
  if (!user || !supabaseClient) {
    savedProfiles = [];
    renderSavedProfiles();
    element('saved-status').textContent = 'Anmelden, um gespeicherte Reviere zu sehen.';
    return false;
  }
  const userId = user.id;
  element('saved-view').setAttribute('aria-busy', 'true');
  element('saved-status').textContent = 'Gespeicherte Reviere werden geladen ...';
  try {
    const { data, error } = await supabaseClient.from('hunting_profiles')
      .select('id,source_id,feature_id,district_name,owner_id,created_at,hunting_mode').order('district_name');
    if (revision !== savedProfilesRevision || user?.id !== userId) return false;
    if (error) throw new Error(error.message);
    const { data: memberships, error: membershipError } = await supabaseClient.from('hunting_profile_members')
      .select('profile_id,role').eq('user_id', userId);
    if (revision !== savedProfilesRevision || user?.id !== userId) return false;
    if (membershipError) throw new Error(membershipError.message);
    const memberRoles = new Map((memberships || []).map(member => [member.profile_id, member.role]));
    const sharedProfileIds = (data || []).filter(profile => profile.owner_id !== userId).map(profile => profile.id);
    let ownerEmails = [];
    let ownerEmailError = null;
    if (sharedProfileIds.length) {
      const { data: emails, error: emailError } = await supabaseClient.rpc('get_hunting_profile_owner_emails', {
        p_profile_ids: sharedProfileIds
      });
      if (revision !== savedProfilesRevision || user?.id !== userId) return false;
      if (emailError) ownerEmailError = emailError;
      else ownerEmails = emails || [];
    }
    const ownerEmailByProfileId = new Map(ownerEmails.map(owner => [owner.profile_id, owner.owner_email]));
    savedProfiles = (data || []).map(profile => ({ ...profile,
      owner_email: ownerEmailByProfileId.get(profile.id) || null,
      member_role: profile.owner_id === userId ? 'owner' : memberRoles.get(profile.id) || 'guest'
    })).sort((left, right) => Number(right.owner_id === userId) - Number(left.owner_id === userId) ||
      left.district_name.localeCompare(right.district_name, 'de'));
    renderSavedProfiles();
    element('saved-status').textContent = ownerEmailError
      ? `Reviere geladen, Owner-E-Mails noch nicht verfuegbar. Datenbankschema aktualisieren. (${ownerEmailError.message})`
      : savedProfiles.length
        ? `${savedProfiles.length} gespeicherte(s) Revierprofil(e).` : 'Noch keine eigenen oder freigegebenen Reviere.';
    return true;
  } catch (error) {
    if (revision === savedProfilesRevision && user?.id === userId) {
      element('saved-status').textContent = `Gespeicherte Reviere konnten nicht geladen werden: ${error.message}`;
    }
    return false;
  } finally {
    if (revision === savedProfilesRevision) {
      element('saved-view').setAttribute('aria-busy', 'false');
      element('refresh-saved').disabled = !user;
    }
  }
}

async function openSavedProfile(profile) {
  if (!user || savedProfilePending) return;
  const source = config.sources.find(candidate => candidate.id === profile.source_id);
  if (!source) {
    element('saved-status').textContent = 'Die gespeicherte Region ist nicht mehr verfuegbar.';
    return;
  }
  const revision = ++savedOpenRevision;
  const userId = user.id;
  savedProfilePending = true;
  renderSavedProfiles();
  element('saved-status').textContent = 'Gespeichertes Revier wird geoeffnet ...';
  try {
    saveSelection(null);
    element('source').value = source.id;
    const loadRevision = boundaryLoadRevision + 1;
    await loadSelectedSource();
    if (revision !== savedOpenRevision || user?.id !== userId || boundaryLoadRevision !== loadRevision) return;
    const feature = features.find(candidate => featureIdentifier(candidate, source) === profile.feature_id);
    if (!feature) throw new Error('Das Revier ist in den verfuegbaren Grenzdaten nicht enthalten.');
    await selectFeature(feature, null, profile.id);
    if (revision !== savedOpenRevision || user?.id !== userId) return;
    renderResults();
    updateSavedProfileSelection();
    element('saved-status').textContent = `Ausgewaehlt: ${profile.district_name}`;
  } catch (error) {
    if (revision === savedOpenRevision && user?.id === userId) {
      element('saved-status').textContent = `Revier konnte nicht geoeffnet werden: ${error.message}`;
    }
  } finally {
    if (revision === savedOpenRevision) {
      savedProfilePending = false;
      for (const button of element('saved-profiles').querySelectorAll('button')) button.disabled = false;
    }
  }
}

async function importJwdProfile(file) {
  if (!user || !supabaseClient || profileImportPending) return;
  const userId = user.id;
  let createdProfileId = null;
  let createdNewProfile = false;
  let importedFeatureId = null;
  let facilitiesToInsert = [];
  let duplicateCount = 0;
  let outsideTargetCount = 0;
  let existingProfile = null;
  profileImportPending = true;
  element('import-profile').disabled = true;
  element('saved-status').textContent = 'Revierdatei wird geprueft ...';
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('Die Datei ist groesser als 10 MB.');
    const { findJwdFacilityAdditions, mapJwdFacilities, matchingEditableProfiles, parseProfileImport } = await import('./jwd-import.js');
    let imported = parseProfileImport(await file.text(), file.name);
    imported = await chooseProfileImport(imported);
    if (!imported) {
      element('saved-status').textContent = 'Revierimport abgebrochen.';
      return;
    }
    if (imported.name.length > 200) throw new Error('Der Reviername ist laenger als 200 Zeichen.');
    if (user?.id !== userId) throw new Error('Die Anmeldung hat sich waehrend des Imports geaendert.');
    if (!markerTypesById.has(fallbackMarkerType)) throw new Error('Der Markerkatalog ist noch nicht verfuegbar.');
    const mappedFacilities = mapJwdFacilities(imported.facilities, markerTypes, fallbackMarkerType);
    if (mappedFacilities.some(marker => marker.title.length > 80 || marker.notes.length > 300)) {
      throw new Error('Ein Einrichtungsname oder Importvermerk ueberschreitet die erlaubte Laenge.');
    }
    const previewFeature = { type: 'Feature', properties: { id: 'preview', name: imported.name }, geometry: imported.geometry };
    const outsideCount = mappedFacilities.filter(marker => !pointInFeature({ lat: marker.latitude, lng: marker.longitude }, previewFeature)).length;
    const untitledCount = imported.facilities.filter(facility => !facility.title).length;
    const unknownTypeCount = mappedFacilities.filter(marker => marker.notes.startsWith('Importierter Originaltyp:')).length;
    const pacifiedCount = imported.geometry.type === 'Polygon'
      ? imported.geometry.coordinates.length - 1
      : imported.geometry.coordinates.reduce((count, polygon) => count + polygon.length - 1, 0);
    const warnings = [
      outsideCount ? `${outsideCount} Markierung(en) liegen ausserhalb der Grenze oder in einem befriedeten Bereich und werden dennoch importiert.` : '',
      untitledCount ? `${untitledCount} Einrichtung(en) ohne Namen erhalten einen automatisch erzeugten Namen.` : '',
      unknownTypeCount ? `${unknownTypeCount} unbekannte(r) Markertyp(en) erhalten das Sonstige-Icon; der Originaltyp bleibt in den Notizen erhalten.` : ''
    ].filter(Boolean);
    if (!await loadSavedProfiles()) throw new Error('Gespeicherte Revierprofile konnten nicht aktualisiert werden.');
    if (user?.id !== userId) throw new Error('Die Anmeldung hat sich waehrend des Imports geaendert.');
    const matchingProfiles = matchingEditableProfiles(savedProfiles, imported.name, userId);
    if (matchingProfiles.length > 1) {
      throw new Error(`Es gibt mehrere eigene oder bearbeitbare Reviere namens "${imported.name}". Der Import wurde nicht zugeordnet.`);
    }
    existingProfile = matchingProfiles[0] || null;
    facilitiesToInsert = mappedFacilities;
    if (existingProfile) {
      const { data: profileData, error: profileError } = await supabaseClient.from('hunting_profiles')
        .select('boundary_geojson').eq('id', existingProfile.id).maybeSingle();
      if (profileError || !profileData) throw new Error(`Vorhandenes Revierprofil konnte nicht geladen werden: ${profileError?.message || 'Profil nicht verfuegbar'}`);
      const { data: existingMarkers, error: markerLoadError } = await supabaseClient.from('hunting_markers')
        .select('type_id,title,latitude,longitude').eq('profile_id', existingProfile.id);
      if (markerLoadError) throw new Error(`Vorhandene Markierungen konnten nicht geladen werden: ${markerLoadError.message}`);
      const additions = findJwdFacilityAdditions(mappedFacilities, existingMarkers || []);
      duplicateCount = additions.duplicateCount;
      const targetGeometry = profileData.boundary_geojson || imported.geometry;
      const targetFeature = { type: 'Feature', properties: { id: 'target', name: imported.name }, geometry: targetGeometry };
      facilitiesToInsert = additions.additions.filter(marker => {
        const inside = pointInFeature({ lat: marker.latitude, lng: marker.longitude }, targetFeature);
        if (!inside) outsideTargetCount += 1;
        return inside;
      });
      if (!facilitiesToInsert.length) {
        setDistrictTab('saved', false, false);
        await loadSavedProfiles();
        element('saved-status').textContent = duplicateCount
          ? `Keine neuen Ergaenzungen fuer "${existingProfile.district_name}" gefunden; ${duplicateCount} vorhandene Markierung(en) uebersprungen.`
          : `Keine neuen Markierungen innerhalb der bestehenden Reviergrenze fuer "${existingProfile.district_name}" gefunden.`;
        return;
      }
    }
    if (outsideTargetCount) warnings.push(`${outsideTargetCount} neue Markierung(en) ausserhalb der bestehenden Reviergrenze werden nicht uebernommen.`);
    const summary = [
      `"${imported.name}" importieren?`,
      existingProfile
        ? `${facilitiesToInsert.length} neue Markierung(en) fuer das vorhandene Profil; ${duplicateCount} Duplikat(e) werden uebersprungen. Grenze und Profil bleiben unveraendert.`
        : `${mappedFacilities.length} Einrichtungen und ${pacifiedCount} befriedete(r) Bereich(e).`,
      ...warnings
    ].join('\n');
    if (!window.confirm(summary)) return;

    if (existingProfile) {
      createdProfileId = existingProfile.id;
    } else {
      const featureId = `jwd-${crypto.randomUUID()}`;
      importedFeatureId = featureId;
      const { data, error } = await supabaseClient.rpc('create_hunting_profile', {
        p_source_id: 'user-imports', p_feature_id: featureId, p_district_name: imported.name
      });
      if (error) throw new Error(error.message);
      createdProfileId = data?.id || data?.[0]?.id;
      if (!createdProfileId) throw new Error('Das Revierprofil wurde ohne Profil-ID angelegt.');
      createdNewProfile = true;
      const { error: boundaryError } = await supabaseClient.rpc('set_hunting_profile_boundary', {
        p_profile_id: createdProfileId, p_geometry: imported.geometry
      });
      if (boundaryError) throw new Error(boundaryError.message);
    }
    if (user?.id !== userId) throw new Error('Die Anmeldung hat sich waehrend des Imports geaendert.');

    if (facilitiesToInsert.length) {
      const { error: markerError } = await supabaseClient.from('hunting_markers').insert(facilitiesToInsert.map(marker => ({
        profile_id: createdProfileId,
        type_id: marker.typeId,
        title: marker.title,
        notes: marker.notes,
        latitude: marker.latitude,
        longitude: marker.longitude,
        created_by: userId
      })));
      if (markerError) throw new Error(markerError.message);
    }
  } catch (error) {
    let cleanupMessage = '';
    if (createdNewProfile && createdProfileId) {
      const { error: cleanupError } = await supabaseClient.from('hunting_profiles').delete().eq('id', createdProfileId);
      if (cleanupError) cleanupMessage = ` Das unvollstaendige Profil konnte nicht automatisch entfernt werden: ${cleanupError.message}`;
    }
    if (user?.id === userId) {
      setDistrictTab('saved', false, false);
      element('saved-status').textContent = `Import fehlgeschlagen: ${error.message}.${cleanupMessage}`;
    }
    return;
  } finally {
    profileImportPending = false;
    element('import-profile').disabled = !user;
  }

  if (user?.id !== userId) return;
  if (existingProfile) {
    setDistrictTab('saved', false, false);
    await loadSavedProfiles();
    element('saved-status').textContent = `${facilitiesToInsert.length} neue Ergaenzung(en) fuer "${existingProfile.district_name}" uebernommen; ${duplicateCount} Duplikat(e) uebersprungen. Grenze und bestehende Markierungen blieben unveraendert.`;
    return;
  }
  element('source').value = 'user-imports';
  saveSelection(null);
  await loadSelectedSource();
  const importedFeature = features.find(feature => featureIdentifier(feature, currentSource()) === importedFeatureId);
  if (importedFeature) {
    await selectFeature(importedFeature, null, createdProfileId);
    renderResults();
  }
  await loadSavedProfiles();
  element('saved-status').textContent = importedFeature
    ? 'Revierdatei importiert und geoeffnet.'
    : 'Revierdatei importiert. Waehle das Revier in der Liste aus.';
}

function currentSource() { return config.sources.find(source => source.id === element('source').value); }
function status(message) { element('status').textContent = message; }
function featureIdentifier(feature, source) {
  const configuredId = source?.idFields?.map(field => feature?.properties?.[field])
    .find(value => value !== undefined && value !== null && String(value).trim());
  const value = configuredId ?? feature?.properties?.id ?? feature?.id;
  return value == null ? null : String(value);
}

function selectedFeatureId() { return featureIdentifier(selected, currentSource()); }

function readSavedSelection() {
  try {
    const selection = JSON.parse(localStorage.getItem(selectionStorageKey));
    return selection && config.sources.some(source => source.id === selection.sourceId) &&
      config.sources.find(source => source.id === selection.sourceId)?.type !== 'profile-imports' &&
      typeof selection.featureId === 'string' && selection.featureId.trim() ? selection : null;
  } catch { return null; }
}

function saveSelection(selection) {
  savedSelection = selection;
  try {
    if (selection) localStorage.setItem(selectionStorageKey, JSON.stringify(selection));
    else localStorage.removeItem(selectionStorageKey);
  } catch {}
}

function readSavedProfileChoice(userId, sourceId, featureId) {
  try {
    const choice = JSON.parse(localStorage.getItem(profileSelectionStorageKey));
    if (choice?.userId !== userId || choice.sourceId !== sourceId || choice.featureId !== featureId ||
      !(choice.profileId === null || typeof choice.profileId === 'string' && choice.profileId.trim())) return null;
    return choice;
  } catch { return null; }
}

function saveProfileChoice(profileId) {
  const source = currentSource();
  const featureId = selectedFeatureId();
  if (!user || !source || source.type === 'profile-imports' || !featureId) return;
  try {
    localStorage.setItem(profileSelectionStorageKey, JSON.stringify({
      userId: user.id, sourceId: source.id, featureId, profileId: profileId || null
    }));
  } catch {}
}

function profileStatus(message) { element('profile-status').textContent = message; }
function shareLocationStatus(message) {
  const status = element('share-location-status');
  status.textContent = message;
  status.hidden = !message;
}
function readMarkerIconSize() {
  try {
    const size = localStorage.getItem(markerIconSizeStorageKey);
    return Object.hasOwn(markerIconScales, size) ? size : 'standard';
  } catch { return 'standard'; }
}

function canEditProfile(profile = activeProfile) {
  return Boolean(user && profile && (profile.owner_id === user.id || profile.member_role === 'editor'));
}

async function loadOwnDisplayName() {
  const userId = user?.id;
  if (!userId || !supabaseClient) return;
  const { data, error } = await supabaseClient.from('hunting_user_profiles')
    .select('display_name').eq('user_id', userId).maybeSingle();
  if (user?.id !== userId) return;
  if (error) {
    element('display-name-status').hidden = false;
    element('display-name-status').textContent = `Anzeigename nicht verfuegbar. Datenbankschema aktualisieren. (${error.message})`;
    return;
  }
  element('display-name').value = data?.display_name || '';
}

function resetMarkerPlacement() {
  if (placementMode) hideMapStatus();
  placementMode = false;
  markerCoordinates = null;
  element('marker-form').hidden = true;
  element('add-marker').setAttribute('aria-pressed', 'false');
  element('marker-title').value = '';
  element('marker-notes').value = '';
}

function updateProfileControls() {
  const canEdit = canEditProfile();
  const source = currentSource();
  const canEditBoundary = Boolean(canEdit && source?.type === 'profile-imports' && activeProfile && selected &&
    activeProfile.source_id === source.id && activeProfile.feature_id === selectedFeatureId());
  element('edit-boundary').hidden = !canEditBoundary || boundaryEditGeometry !== null;
  element('remove-boundary-point').hidden = !canEditBoundary || boundaryEditGeometry === null;
  element('remove-boundary-part').hidden = !canEditBoundary || boundaryEditGeometry === null;
  element('save-boundary').hidden = !canEditBoundary || boundaryEditGeometry === null;
  element('cancel-boundary').hidden = !canEditBoundary || boundaryEditGeometry === null;
  element('edit-boundary').disabled = boundaryEditPending;
  element('remove-boundary-point').disabled = boundaryEditPending || !selectedBoundaryVertex ||
    selectedBoundaryVertex.ring.length <= 4;
  const polygonCount = boundaryPolygons(boundaryEditGeometry).length;
  const canRemoveBoundaryPart = Boolean(selectedBoundaryVertex?.ringIndex > 0 ||
    (selectedBoundaryPart !== null && polygonCount > 1));
  element('remove-boundary-part').disabled = boundaryEditPending || !canRemoveBoundaryPart;
  element('remove-boundary-part').querySelector('span').textContent = selectedBoundaryVertex?.ringIndex > 0
    ? 'Innenfläche entfernen' : 'Teilfläche entfernen';
  element('save-boundary').disabled = boundaryEditPending;
  element('cancel-boundary').disabled = boundaryEditPending;
  const canCreate = Boolean(user && selected && selectedFeatureId());
  element('claim-profile').hidden = !canCreate || profiles.some(profile => profile.owner_id === user.id);
  element('invite-toggle').hidden = !canEdit;
  const isOwner = Boolean(user && activeProfile?.owner_id === user.id);
  element('delete-profile').hidden = !isOwner;
  element('delete-profile').disabled = profileDeletePending;
  element('profile-list').disabled = profileDeletePending;
  element('hunting-mode-control').hidden = !canEdit;
  element('owner-location-notice').hidden = !canEdit;
  element('hunting-mode').checked = Boolean(activeProfile?.hunting_mode);
  const canShareLocation = Boolean(user && activeProfile && activeProfile.owner_id !== user.id && activeProfile.hunting_mode);
  element('share-location-control').hidden = !canShareLocation;
  element('share-location-note').hidden = !canShareLocation;
  element('share-location').checked = Boolean(canShareLocation &&
    (sharingProfileId === activeProfile.id || readLocationConsent(activeProfile) === true));
  if (!canShareLocation) shareLocationStatus('');
  element('hunting-mode').disabled = huntingModePending;
  const availableTypes = markerTypes.filter(type => canEdit || (type.temporary && !type.editorsOnly));
  element('add-marker').hidden = !user || !activeProfile || availableTypes.length === 0;
  const select = element('marker-type');
  Array.from(select.options).forEach(option => {
    const type = markerTypesById.get(option.value);
    option.disabled = !canEdit && (!type?.temporary || type.editorsOnly);
    option.hidden = option.disabled;
  });
  Array.from(select.querySelectorAll('optgroup')).forEach(group => {
    group.hidden = !Array.from(group.querySelectorAll('option')).some(option => !option.disabled);
  });
  if (select.selectedOptions[0]?.disabled) select.value = availableTypes[0]?.id || '';
  updateSavedProfileSelection();
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
  const permanentGroup = document.createElement('optgroup');
  permanentGroup.label = 'Dauerhaft';
  const temporaryGroup = document.createElement('optgroup');
  temporaryGroup.label = 'Temporär · 48 Stunden';
  markerTypes.forEach(type => {
    const option = document.createElement('option');
    option.value = type.id;
    option.textContent = type.label;
    (type.temporary ? temporaryGroup : permanentGroup).append(option);
  });
  select.replaceChildren(permanentGroup, temporaryGroup);
  select.value = fallbackMarkerType;
}

function clearProfileMarkers() {
  markerExpiryTimers.forEach(timer => clearTimeout(timer));
  markerExpiryTimers = [];
  profileMarkers.clearLayers();
}

async function registerProfileBoundary(profile) {
  if (!canEditProfile(profile) || !selected) return;
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
    if (canEditProfile(activeProfile) && !type.temporary) {
      const editType = document.createElement('button');
      editType.type = 'button';
      editType.setAttribute('aria-label', 'Markertyp ändern');
      editType.title = 'Markertyp ändern';
      const editIcon = document.createElement('i');
      editIcon.setAttribute('data-lucide', 'pencil');
      editIcon.setAttribute('aria-hidden', 'true');
      editType.append(editIcon);
      const typeForm = document.createElement('form');
      typeForm.className = 'profile-marker-type-form';
      typeForm.hidden = true;
      const typeSelect = document.createElement('select');
      typeSelect.className = 'profile-marker-type-select';
      typeSelect.setAttribute('aria-label', 'Neuer Markertyp');
      markerTypes.filter(candidate => !candidate.temporary).forEach(candidate => {
        const option = document.createElement('option');
        option.value = candidate.id;
        option.textContent = candidate.label;
        typeSelect.append(option);
      });
      typeSelect.value = markerTypesById.has(marker.type_id) ? marker.type_id : fallbackMarkerType;
      const typeActions = document.createElement('div');
      typeActions.className = 'profile-marker-type-actions';
      const saveType = document.createElement('button');
      saveType.type = 'submit';
      saveType.setAttribute('aria-label', 'Markertyp speichern');
      saveType.title = 'Markertyp speichern';
      const saveIcon = document.createElement('i');
      saveIcon.setAttribute('data-lucide', 'check');
      saveIcon.setAttribute('aria-hidden', 'true');
      saveType.append(saveIcon);
      const cancelType = document.createElement('button');
      cancelType.type = 'button';
      cancelType.setAttribute('aria-label', 'Abbrechen');
      cancelType.title = 'Abbrechen';
      const cancelIcon = document.createElement('i');
      cancelIcon.setAttribute('data-lucide', 'x');
      cancelIcon.setAttribute('aria-hidden', 'true');
      cancelType.append(cancelIcon);
      typeActions.append(saveType, cancelType);
      typeForm.append(typeSelect, typeActions);
      const markerProfileId = activeProfile.id;
      const markerUserId = user.id;
      editType.addEventListener('click', () => {
        typeForm.hidden = false;
        editType.hidden = true;
        typeSelect.focus();
      });
      cancelType.addEventListener('click', () => {
        typeSelect.value = markerTypesById.has(marker.type_id) ? marker.type_id : fallbackMarkerType;
        typeForm.hidden = true;
        editType.hidden = false;
        editType.focus();
      });
      typeForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (activeProfile?.id !== markerProfileId || user?.id !== markerUserId || !canEditProfile()) return;
        const nextType = markerTypesById.get(typeSelect.value);
        if (!nextType || nextType.temporary) return;
        if (nextType.id === marker.type_id) {
          typeForm.hidden = true;
          editType.hidden = false;
          return;
        }
        saveType.disabled = true;
        cancelType.disabled = true;
        try {
          const { error: typeError } = await supabaseClient.rpc('change_hunting_marker_type', {
            p_marker_id: marker.id, p_type_id: nextType.id
          });
          if (activeProfile?.id !== markerProfileId || user?.id !== markerUserId) return;
          if (typeError) throw new Error(typeError.message);
          typeForm.hidden = true;
          profileStatus('Markertyp geändert.');
          await loadProfileMarkers();
        } catch (error) {
          if (activeProfile?.id === markerProfileId && user?.id === markerUserId) {
            profileStatus(`Markertyp konnte nicht geändert werden: ${error.message}`);
          }
        } finally {
          saveType.disabled = false;
          cancelType.disabled = false;
        }
      });
      popup.append(editType, typeForm);
    }
    if (expiresAt !== null) {
      const expiry = document.createElement('span');
      expiry.textContent = `Gueltig bis ${new Date(expiresAt).toLocaleString('de-DE')}`;
      popup.append(expiry);
    }
    if (canEditProfile(activeProfile)) {
      const move = document.createElement('button');
      move.type = 'button';
      move.setAttribute('aria-label', 'Auf aktuelle Position verschieben');
      move.title = 'Auf aktuelle Position verschieben';
      const moveIcon = document.createElement('i');
      moveIcon.setAttribute('data-lucide', 'locate-fixed');
      moveIcon.setAttribute('aria-hidden', 'true');
      move.append(moveIcon);
      move.addEventListener('click', () => {
        if (!navigator.geolocation) {
          profileStatus('Standortbestimmung im Browser nicht verfuegbar.');
          return;
        }
        const profileId = activeProfile.id;
        const userId = user.id;
        move.disabled = true;
        profileStatus('Aktuelle Position wird bestimmt ...');
        navigator.geolocation.getCurrentPosition(async position => {
          const coordinates = { lat: position.coords.latitude, lng: position.coords.longitude };
          if (activeProfile?.id !== profileId || user?.id !== userId || !canEditProfile()) {
            move.disabled = false;
            return;
          }
          if (!pointInSelectedFeature(coordinates)) {
            move.disabled = false;
            profileStatus('Dein aktueller Standort liegt ausserhalb des Reviers. Die Markierung wurde nicht verschoben.');
            return;
          }
          try {
            const { error: moveError } = await supabaseClient.rpc('move_hunting_marker_to_location', {
              p_marker_id: marker.id,
              p_latitude: coordinates.lat,
              p_longitude: coordinates.lng
            });
            if (activeProfile?.id !== profileId || user?.id !== userId) return;
            move.disabled = false;
            if (moveError) profileStatus(`Markierung konnte nicht verschoben werden: ${moveError.message}`);
            else {
              profileStatus('Markierung auf deinen aktuellen Standort verschoben.');
              await loadProfileMarkers();
            }
          } catch (error) {
            move.disabled = false;
            if (activeProfile?.id === profileId && user?.id === userId) {
              profileStatus(`Markierung konnte nicht verschoben werden: ${error.message}`);
            }
          }
        }, error => {
          move.disabled = false;
          if (activeProfile?.id === profileId && user?.id === userId) {
            profileStatus(error.code === 1
              ? 'Standortzugriff abgelehnt. Die Markierung wurde nicht verschoben.'
              : 'Aktuelle Position konnte nicht bestimmt werden.');
          }
        }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
      });
      popup.append(move);
    }
    if (canEditProfile(activeProfile) || (type.temporary && marker.created_by === user.id)) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Markierung loeschen');
      remove.title = 'Markierung loeschen';
      const removeIcon = document.createElement('i');
      removeIcon.setAttribute('data-lucide', 'trash-2');
      removeIcon.setAttribute('aria-hidden', 'true');
      remove.append(removeIcon);
      remove.addEventListener('click', async () => {
        const { error: deleteError } = await supabaseClient.from('hunting_markers').delete().eq('id', marker.id);
        if (deleteError) profileStatus(`Markierung konnte nicht geloescht werden: ${deleteError.message}`);
        else await loadProfileMarkers();
      });
      popup.append(remove);
    }
    const scale = markerIconScales[markerIconSize];
    const mapMarker = L.marker([marker.latitude, marker.longitude], {
      icon: L.icon({
        iconUrl: type.iconUrl,
        iconSize: type.iconSize.map(value => Math.round(value * scale)),
        iconAnchor: type.iconAnchor.map(value => Math.round(value * scale)),
        popupAnchor: type.popupAnchor.map(value => Math.round(value * scale)),
        alt: type.label,
        title: type.label
      })
    }).bindPopup(popup);
    mapMarker.on('popupopen', () => window.lucide?.createIcons({ root: popup }));
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

function pauseProfileLocation() {
  if (locationInterval !== null) clearInterval(locationInterval);
  locationInterval = null;
  locationRequestPending = false;
  sharingProfileId = null;
  sharedLocationIsInBoundary = null;
  if (presenceInterval !== null) clearInterval(presenceInterval);
  presenceInterval = null;
  presenceRevision += 1;
  profileLocations.clearLayers();
  element('location-key').hidden = true;
}

async function stopProfileLocation() {
  const previousProfileId = sharingProfileId;
  pauseProfileLocation();
  if (huntingModeInterval !== null) clearInterval(huntingModeInterval);
  huntingModeInterval = null;
  if (previousProfileId && user && supabaseClient) {
    const { error } = await supabaseClient.from('hunting_profile_locations').delete()
      .eq('profile_id', previousProfileId).eq('user_id', user.id);
    if (error) profileStatus(`Standort konnte nicht entfernt werden: ${error.message}`);
  }
}

function startPresenceUpdates() {
  if (presenceInterval !== null) clearInterval(presenceInterval);
  void loadProfileLocations();
  presenceInterval = setInterval(() => void loadProfileLocations(), 30000);
}

function updateHuntingMode(profile, enabled) {
  profile.hunting_mode = enabled;
  if (activeProfile?.id === profile.id) activeProfile.hunting_mode = enabled;
  updateProfileControls();
  if (!enabled) {
    const previousProfileId = sharingProfileId;
    pauseProfileLocation();
    if (previousProfileId && user) void supabaseClient.from('hunting_profile_locations').delete()
      .eq('profile_id', previousProfileId).eq('user_id', user.id);
    element('presence-status').hidden = false;
    element('presence-status').textContent = 'Jagdmodus aus. Standortfreigaben sind pausiert.';
  } else if (profile.owner_id === user?.id) {
    element('presence-status').hidden = false;
    element('presence-status').textContent = 'Jagdmodus aktiv. Dein Standort und Teilnehmerstandorte werden geteilt.';
    startPresenceUpdates();
    void startProfileLocationSharing(profile);
  } else {
    element('presence-status').hidden = false;
    element('presence-status').textContent = 'Jagdmodus aktiv. Du kannst deinen Standort mit diesem Revier teilen.';
    startPresenceUpdates();
    if (readLocationConsent(profile) === true) void startProfileLocationSharing(profile);
  }
}

function startHuntingModeUpdates(profile) {
  if (huntingModeInterval !== null) clearInterval(huntingModeInterval);
  huntingModeInterval = setInterval(async () => {
    if (!activeProfile || activeProfile.id !== profile.id || !supabaseClient) return;
    const { data, error } = await supabaseClient.from('hunting_profiles')
      .select('hunting_mode').eq('id', profile.id).maybeSingle();
    if (error || !data || activeProfile?.id !== profile.id) return;
    const enabled = Boolean(data.hunting_mode);
    if (enabled !== Boolean(activeProfile.hunting_mode)) updateHuntingMode(profile, enabled);
  }, 10000);
}

async function loadProfileLocations() {
  const revision = ++presenceRevision;
  if (!activeProfile || !user || !supabaseClient) return;
  if (!activeProfile.hunting_mode) {
    profileLocations.clearLayers();
    element('location-key').hidden = true;
    return;
  }
  const profileId = activeProfile.id;
  const [{ data, error }, { data: participants, error: participantError }] = await Promise.all([
    supabaseClient.from('hunting_profile_locations')
      .select('user_id,latitude,longitude,accuracy,updated_at')
      .eq('profile_id', profileId),
    supabaseClient.rpc('get_hunting_profile_participants', { p_profile_id: profileId })
  ]);
  if (revision !== presenceRevision || !activeProfile || !user) return;
  if (error) {
    element('presence-status').hidden = false;
    element('presence-status').textContent = `Standorte nicht verfuegbar. Datenbankschema aktualisieren. (${error.message})`;
    return;
  }
  profileLocations.clearLayers();
  element('location-key').hidden = true;
  const participantById = new Map((participantError ? [] : participants || [])
    .map(participant => [participant.participant_user_id, participant]));
  (data || []).forEach(location => {
    const participant = participantById.get(location.user_id);
    const role = participant?.participant_role || 'guest';
    const displayName = participant?.display_name?.trim() || participant?.participant_email?.trim() ||
      `Benutzer ${location.user_id.slice(0, 8)}`;
    const iconName = role === 'owner' ? 'crown' : role === 'editor' ? 'shield-check' : 'user-round';
    const roleClass = role === 'owner' ? 'person-location-owner' : role === 'editor' ? 'person-location-editor' : '';
    const marker = L.marker([location.latitude, location.longitude], {
      icon: L.divIcon({
        className: 'profile-location-marker',
        html: `<span class="person-location-swatch ${roleClass}"><i data-lucide="${iconName}" aria-hidden="true"></i></span>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
        popupAnchor: [0, -18]
      })
    });
    marker.on('add', () => {
      const markerElement = marker.getElement();
      if (!markerElement) return;
      markerElement.setAttribute('role', 'img');
      markerElement.setAttribute('aria-label', displayName);
      window.lucide?.createIcons({ root: markerElement });
    });
    const popup = document.createElement('div');
    popup.className = 'profile-location-popup';
    const label = document.createElement('strong');
    label.textContent = displayName;
    const time = document.createElement('span');
    time.textContent = `Zuletzt aktualisiert: ${new Date(location.updated_at).toLocaleTimeString('de-DE')}`;
    const accuracy = document.createElement('span');
    accuracy.textContent = `Genauigkeit: ${Math.round(location.accuracy)} m`;
    popup.append(label, time, accuracy);
    marker.bindPopup(popup).addTo(profileLocations);
  });
  element('location-key').hidden = !data?.length;
  element('presence-status').hidden = false;
  element('presence-status').textContent = data?.length
    ? `${data.length} letzte bekannte Position${data.length === 1 ? '' : 'en'} im Revier.${participantError ? ' Namen und Rollen sind derzeit nicht verfuegbar.' : ''}`
    : 'Aktuell keine Benutzer im Revier.';
}

async function startProfileLocationSharing(profile) {
  if (sharingProfileId === profile.id) return;
  if (!navigator.geolocation) {
    element('share-location').checked = false;
    updateProfileControls();
    shareLocationStatus('Standortbestimmung im Browser nicht verfuegbar.');
    return;
  }
  sharingProfileId = profile.id;
  const updateSharedLocation = async position => {
    if (sharingProfileId !== profile.id || !user || !activeProfile?.hunting_mode) return;
    const point = { lat: position.coords.latitude, lng: position.coords.longitude };
    if (!pointInSelectedFeature(point)) {
      if (sharedLocationIsInBoundary !== false) {
        sharedLocationIsInBoundary = false;
        const { error } = await supabaseClient.from('hunting_profile_locations').delete()
          .eq('profile_id', profile.id).eq('user_id', user.id);
        if (error) profileStatus(`Standort ausserhalb des Reviers konnte nicht entfernt werden: ${error.message}`);
      }
      if (sharingProfileId === profile.id && activeProfile?.id === profile.id && profile.owner_id !== user.id) {
        shareLocationStatus('Dein Standort liegt ausserhalb des Reviers und wird nicht geteilt.');
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
    if (sharingProfileId !== profile.id || activeProfile?.id !== profile.id) return;
    if (error) {
      profileStatus(`Standort konnte nicht uebermittelt werden: ${error.message}. Datenbankschema aus schema.sql pruefen.`);
      if (profile.owner_id !== user.id) shareLocationStatus('Standort konnte nicht mit diesem Revier geteilt werden.');
    }
    else if (profile.owner_id === user.id) void loadProfileLocations();
    else if (activeProfile?.id === profile.id) {
      shareLocationStatus('Dein Standort wird mit diesem Revier geteilt.');
    }
  };
  const requestLocation = () => {
    if (sharingProfileId !== profile.id || locationRequestPending || !activeProfile?.hunting_mode) return;
    locationRequestPending = true;
    navigator.geolocation.getCurrentPosition(position => {
      locationRequestPending = false;
      void updateSharedLocation(position);
    }, error => {
      locationRequestPending = false;
      if (sharingProfileId !== profile.id) return;
      if (error.code === 1 && profile.owner_id === user?.id) {
        clearInterval(locationInterval);
        locationInterval = null;
        sharingProfileId = null;
        sharedLocationIsInBoundary = false;
        void supabaseClient.from('hunting_profile_locations').delete()
          .eq('profile_id', profile.id).eq('user_id', user.id);
        profileStatus('Standortzugriff abgelehnt. Jagdmodus bleibt fuer die Gruppe aktiv, dein Standort wird nicht geteilt.');
      } else if (error.code === 1) {
        clearInterval(locationInterval);
        locationInterval = null;
        sharingProfileId = null;
        sharedLocationIsInBoundary = false;
        void supabaseClient.from('hunting_profile_locations').delete()
          .eq('profile_id', profile.id).eq('user_id', user.id);
        writeLocationConsent(profile, false);
        updateProfileControls();
        shareLocationStatus('Browser-Standortzugriff abgelehnt. Dein Standort wird nicht geteilt.');
      } else {
        profileStatus('Warte auf eine verfuegbare Standortbestimmung.');
      }
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  };
  locationInterval = setInterval(requestLocation, 30000);
  requestLocation();
}

async function activateProfile(profile) {
  const revision = ++profileActivationRevision;
  await stopProfileLocation();
  if (revision !== profileActivationRevision) return;
  const { data: modeData, error: modeError } = await supabaseClient.from('hunting_profiles')
    .select('hunting_mode').eq('id', profile.id).maybeSingle();
  if (revision !== profileActivationRevision) return;
  if (modeError || !modeData) {
    profileStatus(`Jagdmodus konnte nicht geladen werden: ${modeError?.message || 'Profil nicht verfuegbar'}`);
    return;
  }
  profile.hunting_mode = Boolean(modeData.hunting_mode);
  if (profile.owner_id === user?.id) {
    profile.member_role = 'owner';
  } else {
    const { data: membership, error: membershipError } = await supabaseClient.from('hunting_profile_members')
      .select('role').eq('profile_id', profile.id).eq('user_id', user.id).maybeSingle();
    if (revision !== profileActivationRevision) return;
    if (membershipError || !membership) {
      profileStatus(`Mitgliedsrolle konnte nicht geladen werden: ${membershipError?.message || 'Profilzugriff fehlt'}`);
      return;
    }
    profile.member_role = membership.role;
  }
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
    startHuntingModeUpdates(profile);
    if (profile.hunting_mode) {
      startPresenceUpdates();
      void startProfileLocationSharing(profile);
    }
    else element('presence-status').textContent = 'Jagdmodus aus. Standortfreigaben sind pausiert.';
    return;
  }
  activeProfile = profile;
  element('profile-list').value = profile.id;
  updateProfileControls();
  await registerProfileBoundary(profile);
  if (revision !== profileActivationRevision || activeProfile?.id !== profile.id) return;
  await loadProfileMarkers();
  if (revision !== profileActivationRevision || activeProfile?.id !== profile.id) return;
  element('presence-status').hidden = false;
  startHuntingModeUpdates(profile);
  if (!profile.hunting_mode) {
    element('presence-status').textContent = 'Jagdmodus aus. Standortfreigaben sind pausiert.';
    return;
  }
  element('presence-status').textContent = 'Jagdmodus aktiv. Du kannst deinen Standort mit diesem Revier teilen.';
  startPresenceUpdates();
  if (readLocationConsent(profile) === true) void startProfileLocationSharing(profile);
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
    .select('id,source_id,feature_id,district_name,owner_id,created_at,hunting_mode')
    .eq('source_id', source.id).eq('feature_id', featureId).order('created_at');
  if (revision !== profileRevision) return;
  if (error) {
    profileStatus(`Profile nicht verfuegbar. Datenbankschema aus schema.sql einrichten. (${error.message})`);
    return;
  }
  const { data: memberships, error: membershipError } = await supabaseClient.from('hunting_profile_members')
    .select('profile_id,role').eq('user_id', user.id);
  if (revision !== profileRevision) return;
  if (membershipError) {
    profileStatus(`Mitgliedsrollen nicht verfuegbar. Datenbankschema aus schema.sql aktualisieren. (${membershipError.message})`);
    return;
  }
  const memberRoles = new Map((memberships || []).map(member => [member.profile_id, member.role]));
  const sharedProfileIds = (data || []).filter(profile => profile.owner_id !== user.id).map(profile => profile.id);
  let ownerEmails = [];
  if (sharedProfileIds.length) {
    const { data: emails } = await supabaseClient.rpc('get_hunting_profile_owner_emails', {
      p_profile_ids: sharedProfileIds
    });
    if (revision !== profileRevision) return;
    ownerEmails = emails || [];
  }
  const ownerEmailByProfileId = new Map(ownerEmails.map(owner => [owner.profile_id, owner.owner_email]));
  profiles = (data || []).map(profile => ({ ...profile,
    owner_email: ownerEmailByProfileId.get(profile.id) || null,
    member_role: profile.owner_id === user.id ? 'owner' : memberRoles.get(profile.id) || 'guest'
  }));
  const profileSelect = element('profile-list');
  profileSelect.replaceChildren();
  profiles.forEach(profile => {
    const option = document.createElement('option');
    option.value = profile.id;
    const profileLabel = profile.owner_id === user.id ? 'Owner'
      : profile.member_role === 'editor' ? 'Bearbeiter' : 'Gast';
    const ownerAddress = profile.owner_id === user.id ? user.email || user.id.slice(0, 8)
      : profile.owner_email || profile.owner_id.slice(0, 8);
    option.textContent = `${profileLabel} - ${profile.district_name} @${ownerAddress}`;
    profileSelect.append(option);
  });
  const guestOption = document.createElement('option');
  guestOption.value = '';
  guestOption.textContent = 'Als Gast ansehen';
  profileSelect.prepend(guestOption);
  const rememberedChoice = preferredId ? null : readSavedProfileChoice(user.id, source.id, featureId);
  const rememberedProfile = typeof rememberedChoice?.profileId === 'string'
    ? profiles.find(profile => profile.id === rememberedChoice.profileId) : null;
  const preferredProfile = profiles.find(profile => profile.id === preferredId);
  activeProfile = preferredId ? (preferredProfile?.owner_id === user.id ? preferredProfile : null)
    : rememberedChoice?.profileId === null ? null
      : rememberedProfile ? (rememberedProfile.owner_id === user.id ? rememberedProfile : null)
        : profiles.find(profile => profile.owner_id === user.id) || null;
  if (activeProfile) {
    profileSelect.value = activeProfile.id;
    saveProfileChoice(activeProfile.id);
  }
  profileSelect.hidden = profiles.length === 0;
  profileStatus(profiles.length ? `${profiles.length} unabhaengige(s) Revierprofil(e).` : 'Noch kein Profil fuer dieses Revier.');
  if (preferredId && !preferredProfile) profileStatus('Dieses Profil ist nicht mehr zugreifbar.');
  else if (rememberedChoice?.profileId && !rememberedProfile) {
    profileStatus('Das zuletzt verwendete Profil ist nicht mehr zugreifbar.');
    saveProfileChoice(activeProfile?.id || null);
  }
  updateProfileControls();
  if (activeProfile) await registerProfileBoundary(activeProfile);
  if (revision !== profileRevision) return;
  await loadProfileMarkers();
  if (activeProfile?.owner_id === user.id) {
    element('presence-status').hidden = false;
    startHuntingModeUpdates(activeProfile);
    if (activeProfile.hunting_mode) {
      startPresenceUpdates();
      void startProfileLocationSharing(activeProfile);
    }
    else element('presence-status').textContent = 'Jagdmodus aus. Standortfreigaben sind pausiert.';
  }
  const profileToRestore = preferredProfile || rememberedProfile;
  if (profileToRestore && profileToRestore.owner_id !== user?.id) await chooseProfile(profileToRestore);
}

function clearSelection() {
  profileActivationRevision += 1;
  void stopProfileLocation();
  stopBoundaryEditing(true);
  if (boundary) map.removeLayer(boundary);
  boundary = null;
  selected = null;
  updateSavedProfileSelection();
  profiles = [];
  activeProfile = null;
  profileRevision += 1;
  clearProfileMarkers();
  profileLocations.clearLayers();
  element('location-key').hidden = true;
  resetMarkerPlacement();
  element('profile-list').replaceChildren();
  element('profile-list').hidden = true;
  element('hunting-mode-control').hidden = true;
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

function selectFeature(feature, button, preferredProfileId) {
  clearSelection();
  selected = feature;
  const source = currentSource();
  const featureId = selectedFeatureId();
  saveSelection(featureId && source.type !== 'profile-imports' ? { sourceId: source.id, featureId } : null);
  boundary = L.geoJSON(feature, { smoothFactor: 0, style: { color: '#c43b55', weight: 3, fillColor: '#c43b55', fillOpacity: .14 } });
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
  button?.setAttribute('aria-pressed', 'true');
  element('selection').hidden = false;
  element('fit').disabled = false;
  element('profile-section').hidden = !user;
  updateSavedProfileSelection();
  if (user) return loadProfiles(preferredProfileId);
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

function pointInFeature(point, feature) {
  const geometry = feature?.geometry;
  if (geometry?.type === 'Polygon') {
    return pointInRing(point, geometry.coordinates[0]) && !geometry.coordinates.slice(1).some(ring => pointInRing(point, ring));
  }
  if (geometry?.type === 'MultiPolygon') {
    return geometry.coordinates.some(polygon => pointInRing(point, polygon[0]) && !polygon.slice(1).some(ring => pointInRing(point, ring)));
  }
  return false;
}

function pointInSelectedFeature(point) {
  return pointInFeature(point, selected);
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
  const sourceLink = element('source-link');
  const licenseLink = element('license-link');
  sourceLink.hidden = !source || source.type === 'profile-imports';
  licenseLink.hidden = !source || source.type === 'profile-imports';
  if (!source) {
    document.querySelector('.source-note span').textContent = 'Verfuegbare Abdeckung: konfigurierte Regionen';
    return;
  }
  if (source.type === 'profile-imports') {
    document.querySelector('.source-note span').textContent = 'Private, importierte Revierprofile';
    return;
  }
  document.querySelector('.source-note span').textContent = source.snapshotDate
    ? `Datenstand: ${source.snapshotDate} (lokaler Snapshot)`
    : 'Verfuegbare Abdeckung: konfigurierte Regionen';
  sourceLink.href = source.metadataUrl;
  licenseLink.href = source.licenseUrl;
  licenseLink.textContent = source.license;
  const attribution = document.createElement('span');
  attribution.textContent = `${source.attribution} (${source.license}); Darstellung unveraendert`;
  sourceAttribution = attribution.outerHTML;
  map.attributionControl.addAttribution(sourceAttribution);
}

function boundaryCacheRequest(source) {
  return new Request(new URL(`./__boundary-cache__/${encodeURIComponent(source.id)}.json`, location.href));
}

async function loadImportedBoundaries(source) {
  if (!user || !supabaseClient) throw new Error('Anmeldung erforderlich, um private Importe zu laden.');
  const { data, error } = await supabaseClient.from('hunting_profiles')
    .select('feature_id,district_name,boundary_geojson').eq('source_id', source.id);
  if (error) throw new Error(error.message);
  return boundaries({
    type: 'FeatureCollection',
    features: (data || []).filter(profile => profile.boundary_geojson).map(profile => ({
      type: 'Feature',
      id: profile.feature_id,
      properties: { id: profile.feature_id, name: profile.district_name },
      geometry: profile.boundary_geojson
    }))
  });
}

async function readBoundaryCache(source) {
  if (!('caches' in window) || source.type === 'profile-imports') return null;
  try {
    const cache = await caches.open(boundaryCacheName);
    const response = await cache.match(boundaryCacheRequest(source));
    if (!response) return null;
    const collection = await response.json();
    return { features: boundaries(collection), updatedAt: response.headers.get('x-jagdkarte-cached-at') };
  } catch { return null; }
}

async function writeBoundaryCache(source, loadedFeatures) {
  if (!('caches' in window) || source.type === 'profile-imports') return null;
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
  const source = currentSource();
  const remembered = savedSelection?.sourceId === source?.id
    ? features.find(feature => featureIdentifier(feature, source) === savedSelection.featureId) : null;
  const missingSelection = savedSelection?.sourceId === source?.id && !remembered;
  if (remembered) selectFeature(remembered);
  else if (missingSelection) saveSelection(null);
  renderResults();
  if (missingSelection) status('Das zuletzt ausgewaehlte Revier ist in dieser Region nicht mehr verfuegbar.');
}

async function fetchSelectedBoundaries(source, revision) {
  const requestController = new AbortController();
  controller = requestController;
  const timeout = setTimeout(() => requestController.abort('timeout'), 30000);
  element('search-form').setAttribute('aria-busy', 'true');
  element('refresh-boundaries').disabled = true;
  status(features.length ? 'Reviergrenzen werden aktualisiert ...' : 'Reviergrenzen werden erstmals geladen ...');
  try {
    const loaded = source.type === 'profile-imports'
      ? await loadImportedBoundaries(source)
      : await loadBoundaries(source, requestController.signal);
    if (controller !== requestController || revision !== boundaryLoadRevision) return;
    features = loaded;
    boundaryUpdatedAt = await writeBoundaryCache(source, loaded) || new Date().toISOString();
    if (revision === boundaryLoadRevision) showBoundaries();
  } catch (error) {
    if (controller !== requestController || revision !== boundaryLoadRevision) return;
    if (source.type === 'profile-imports' && !user) {
      status('Anmelden, um private Revierimporte zu laden.');
      return;
    }
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
element('source').addEventListener('change', () => {
  saveSelection(null);
  void loadSelectedSource();
});
element('refresh-boundaries').addEventListener('click', refreshSelectedSource);
element('search-form').addEventListener('submit', event => {
  event.preventDefault();
  if (features.length) renderResults();
  else status(currentSource()
    ? 'Reviergrenzen werden geladen. Bitte kurz warten oder Aktualisieren auswaehlen.'
    : 'Bitte zuerst eine Region auswaehlen.');
});
element('query').addEventListener('input', () => { if (features.length) renderResults(); });
element('clear').addEventListener('click', () => {
  saveSelection(null);
  clearSelection();
});
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
  await chooseProfile(profile);
});
element('edit-boundary').addEventListener('click', startBoundaryEditing);
element('remove-boundary-point').addEventListener('click', () => {
  if (!selectedBoundaryVertex || selectedBoundaryVertex.ring.length <= 4 || boundaryEditPending) return;
  const { ring, index } = selectedBoundaryVertex;
  ring.splice(index, 1);
  ring[ring.length - 1] = [...ring[0]];
  selectedBoundaryPart = null;
  if (boundary) {
    boundary.clearLayers();
    boundary.addData({ ...selected, geometry: boundaryEditGeometry });
  }
  renderBoundaryEditParts();
  renderBoundaryEditHandles();
  updateProfileControls();
});
element('remove-boundary-part').addEventListener('click', () => {
  if (boundaryEditPending) return;
  if (selectedBoundaryVertex?.ringIndex > 0) {
    selectedBoundaryVertex.polygon.splice(selectedBoundaryVertex.ringIndex, 1);
  } else if (selectedBoundaryPart !== null && boundaryPolygons(boundaryEditGeometry).length > 1) {
    boundaryEditGeometry.coordinates.splice(selectedBoundaryPart, 1);
  } else return;
  selectedBoundaryPart = null;
  selectedBoundaryVertex = null;
  if (boundary) {
    boundary.clearLayers();
    boundary.addData({ ...selected, geometry: boundaryEditGeometry });
  }
  renderBoundaryEditParts();
  renderBoundaryEditHandles();
  updateProfileControls();
});
element('save-boundary').addEventListener('click', saveBoundaryEditing);
element('cancel-boundary').addEventListener('click', () => stopBoundaryEditing(true));
element('display-name-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!user || !supabaseClient) return;
  const userId = user.id;
  const displayName = element('display-name').value.trim();
  const button = element('display-name-form').querySelector('button[type="submit"]');
  button.disabled = true;
  element('display-name-status').hidden = true;
  const { error } = await supabaseClient.from('hunting_user_profiles').upsert({
    user_id: userId,
    display_name: displayName || null,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  button.disabled = false;
  if (user?.id !== userId) return;
  element('display-name-status').hidden = false;
  element('display-name-status').textContent = error
    ? `Anzeigename konnte nicht gespeichert werden: ${error.message}`
    : displayName ? 'Anzeigename gespeichert.' : 'Anzeigename entfernt.';
  if (!error && activeProfile?.hunting_mode) void loadProfileLocations();
});
element('marker-icon-size').addEventListener('change', event => {
  const size = event.currentTarget.value;
  if (!Object.hasOwn(markerIconScales, size)) return;
  markerIconSize = size;
  element('marker-icon-size-status').hidden = false;
  try {
    localStorage.setItem(markerIconSizeStorageKey, size);
    element('marker-icon-size-status').textContent = 'Einstellung auf diesem Gerät gespeichert.';
  } catch {
    element('marker-icon-size-status').textContent = 'Einstellung gilt bis zum Schließen dieser Seite.';
  }
  if (activeProfile && user) void loadProfileMarkers();
});
element('hunting-mode').addEventListener('change', async event => {
  const profile = activeProfile;
  if (!profile || !canEditProfile(profile) || !supabaseClient) return;
  const revision = profileActivationRevision;
  const enabled = event.currentTarget.checked;
  huntingModePending = true;
  updateProfileControls();
  const { error } = await supabaseClient.rpc('set_hunting_mode', {
    p_profile_id: profile.id,
    p_enabled: enabled
  });
  huntingModePending = false;
  if (revision !== profileActivationRevision || activeProfile?.id !== profile.id) {
    updateProfileControls();
    return;
  }
  if (error) {
    updateProfileControls();
    profileStatus(`Jagdmodus konnte nicht geaendert werden: ${error.message}. Datenbankschema aus schema.sql aktualisieren.`);
    return;
  }
  updateHuntingMode(profile, enabled);
});

async function chooseProfile(profile) {
  const revision = ++profileActivationRevision;
  stopBoundaryEditing(true);
  await stopProfileLocation();
  if (revision !== profileActivationRevision) return;
  saveProfileChoice(profile?.id || null);
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
  await activateProfile(profile);
}
element('share-location').addEventListener('change', event => {
  const profile = activeProfile;
  if (!profile || profile.owner_id === user?.id || !profile.hunting_mode) {
    event.currentTarget.checked = false;
    return;
  }
  if (event.currentTarget.checked) {
    writeLocationConsent(profile, true);
    shareLocationStatus('Browser-Standortfreigabe wird angefragt ...');
    void startProfileLocationSharing(profile);
    return;
  }
  writeLocationConsent(profile, false);
  shareLocationStatus('Dein Standort wird nicht mehr geteilt.');
  void stopProfileLocation().then(() => {
    if (activeProfile?.id === profile.id && profile.hunting_mode) startPresenceUpdates();
    updateProfileControls();
  });
});
element('invite-toggle').addEventListener('click', () => {
  element('invite-form').hidden = !element('invite-form').hidden;
  if (!element('invite-form').hidden) element('invite-email').focus();
});
async function deleteActiveProfile() {
  const profile = activeProfile;
  const userId = user?.id;
  const selectedProfileId = element('profile-list').value;
  if (!profile || !userId || !selectedProfileId || profile.id !== selectedProfileId ||
      profile.owner_id !== userId || !supabaseClient || profileDeletePending) return;
  if (!window.confirm(`Dein Revierprofil "${profile.district_name}" loeschen? Das Profil anderer Owner bleibt bestehen.`)) return;
  profileDeletePending = true;
  updateProfileControls();
  profileStatus('Eigenes Revierprofil wird geloescht ...');
  const { data, error } = await supabaseClient.from('hunting_profiles').delete().eq('id', selectedProfileId).select('id');
  profileDeletePending = false;
  if (user?.id !== userId) return;
  if (error || !data?.some(deleted => deleted.id === profile.id)) {
    updateProfileControls();
    profileStatus(error ? `Revierprofil konnte nicht geloescht werden: ${error.message}`
      : 'Revierprofil wurde nicht geloescht. Bitte Auswahl aktualisieren.');
    return;
  }
  await stopProfileLocation();
  activeProfile = null;
  await loadProfiles();
  void loadSavedProfiles();
  profileStatus('Eigenes Revierprofil geloescht.');
}
element('delete-profile').addEventListener('click', () => void deleteActiveProfile());
element('invite-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!auth || !supabaseClient || !canEditProfile()) return;
  const email = element('invite-email').value.trim().toLocaleLowerCase('en-US');
  const role = element('invite-role').value;
  const button = element('invite-form').querySelector('button[type="submit"]');
  button.disabled = true;
  profileStatus('Einladung wird vorbereitet ...');
  const { error: inviteError } = await supabaseClient.rpc('invite_hunting_profile_member', {
    p_profile_id: activeProfile.id, p_email: email, p_role: role
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
  profileStatus(`${role === 'editor' ? 'Bearbeiter' : 'Gast'}-Einladung per E-Mail angefordert.`);
});
element('add-marker').addEventListener('click', () => {
  if (!activeProfile || !user || markerPending) return;
  if (placementMode) hideMapStatus();
  else showMapStatus('Karte antippen, um die Position festzulegen.');
  placementMode = !placementMode;
  markerCoordinates = null;
  element('marker-form').hidden = true;
  element('add-marker').setAttribute('aria-pressed', String(placementMode));
});
element('cancel-marker').addEventListener('click', resetMarkerPlacement);
map.on('click', event => {
  if (placementMode) {
    if (!pointInSelectedFeature(event.latlng)) {
      profileStatus('Markierungen muessen innerhalb des ausgewaehlten Jagdbezirks liegen.');
      showMapStatus('Bitte einen Punkt innerhalb der Reviergrenze waehlen.');
      return;
    }
    hideMapStatus();
    markerCoordinates = event.latlng;
    placementMode = false;
    element('marker-coordinates').textContent = `${event.latlng.lat.toFixed(5)}, ${event.latlng.lng.toFixed(5)}`;
    element('marker-form').hidden = false;
    element('add-marker').setAttribute('aria-pressed', 'false');
    element('marker-title').focus();
    return;
  }
  if (element('search-panel-body').hidden || element('search-tab').getAttribute('aria-selected') !== 'true' || !features.length) return;
  const feature = features.find(candidate => pointInFeature(event.latlng, candidate));
  if (feature) selectFeature(feature);
});
element('marker-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!supabaseClient || !markerCoordinates || !activeProfile || !user || markerPending) return;
  const type = markerTypesById.get(element('marker-type').value);
  if (!type || ((!type.temporary || type.editorsOnly) && !canEditProfile())) return;
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
      let userCoordinates = null;
      if (type.requiresCurrentLocation !== false) {
        if (!navigator.geolocation) throw new Error('Standortbestimmung nicht verfuegbar.');
        profileStatus('Aktueller Standort wird geprueft ...');
        const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve,
          error => reject(new Error(error.code === 1 ? 'Standortzugriff nicht erlaubt.' : 'Standort konnte nicht bestimmt werden.')),
          { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }));
        if (activeProfile?.id !== profileId || user?.id !== userId || selected !== feature) return;
        userCoordinates = { lat: position.coords.latitude, lng: position.coords.longitude };
        if (!pointInSelectedFeature(userCoordinates)) {
          throw new Error('Dein aktueller Standort liegt ausserhalb des Reviers.');
        }
      }
      result = await supabaseClient.rpc('create_temporary_hunting_marker', {
        p_profile_id: profileId, p_type_id: type.id, p_title: title, p_notes: notes,
        p_latitude: coordinates.lat, p_longitude: coordinates.lng,
        p_user_latitude: userCoordinates?.lat ?? null, p_user_longitude: userCoordinates?.lng ?? null
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
  const name = featureName(selected, source);
  const fileName = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim() || 'jagdbezirk';
  const blob = new Blob([JSON.stringify(createJwdExport(name, selected.geometry), null, 2)],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${fileName}.jwd`;
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
  element('user-label').textContent = user?.email || '';
  element('user-label').hidden = !user;
  if (user && previousId !== user.id) void loadOwnDisplayName();
  else if (element('display-name-dialog').open) element('display-name-dialog').close();
  element('account-button').querySelector('span').textContent = user ? 'Abmelden' : 'Anmelden';
  element('import-profile').hidden = !user;
  element('import-profile').disabled = !user || profileImportPending;
  if (!user) {
    savedProfilesRevision += 1;
    savedOpenRevision += 1;
    savedProfilePending = false;
    savedProfiles = [];
    renderSavedProfiles();
    element('saved-view').setAttribute('aria-busy', 'false');
    element('saved-status').textContent = 'Anmelden, um gespeicherte Reviere zu sehen.';
    element('refresh-saved').disabled = true;
    controller?.abort();
    controller = null;
    const privateImportsSelected = currentSource()?.type === 'profile-imports';
    if (privateImportsSelected) {
      boundaryLoadRevision += 1;
      features = [];
      boundaryUpdatedAt = null;
      clearSelection();
      element('results').replaceChildren();
      element('result-count').textContent = '0';
    }
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
    if (privateImportsSelected) status('Anmelden, um private Revierimporte zu laden.');
    else if (features.length) renderResults();
    else if (!currentSource() && !controller) status('Region auswaehlen, um Reviere zu laden.');
  } else if (previousId !== user.id) {
    savedProfiles = [];
    renderSavedProfiles();
    void loadSavedProfiles();
    element('login-dialog').close();
    if (currentSource()?.type === 'profile-imports') void loadSelectedSource();
    if (selected) {
      element('profile-section').hidden = false;
      void loadProfiles();
    }
  }
}

element('user-label').addEventListener('click', async () => {
  if (!user) return;
  element('display-name-status').hidden = true;
  element('marker-icon-size').value = markerIconSize;
  element('marker-icon-size-status').hidden = true;
  await loadOwnDisplayName();
  if (!user) return;
  element('display-name-dialog').showModal();
  element('display-name').focus();
});
element('close-display-name').addEventListener('click', () => element('display-name-dialog').close());
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
function resetEmailCode() {
  requestedEmail = null;
  element('code-form').hidden = true;
  element('email-code').value = '';
  const registering = document.querySelector('input[name="auth-mode"]:checked').value === 'register';
  element('send-link').querySelector('span').textContent = registering ? 'Registrierungscode senden' : 'Anmeldecode senden';
}

function setAuthPending(pending) {
  authPending = pending;
  element('send-link').disabled = pending;
  element('email').disabled = pending;
  element('auth-modes').disabled = pending;
  element('verify-code').disabled = pending;
  element('email-code').disabled = pending;
  element('login-form').setAttribute('aria-busy', String(pending));
  element('code-form').setAttribute('aria-busy', String(pending));
}

element('email').addEventListener('input', () => {
  resetEmailCode();
  element('login-status').textContent = '';
});
element('auth-modes').addEventListener('change', () => {
  const registering = document.querySelector('input[name="auth-mode"]:checked').value === 'register';
  element('login-title').textContent = registering ? 'Registrieren' : 'Anmelden';
  resetEmailCode();
  if (auth) element('login-status').textContent = '';
});
element('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!auth || authPending || !element('login-form').reportValidity()) return;
  const registering = document.querySelector('input[name="auth-mode"]:checked').value === 'register';
  const email = element('email').value.trim();
  setAuthPending(true);
  element('login-status').textContent = registering ? 'Registrierungscode wird angefordert ...' : 'Anmeldecode wird angefordert ...';
  try {
    const redirect = new URL('./', location.href);
    const { error } = await auth.signInWithOtp({ email, options: {
      emailRedirectTo: redirect.href,
      shouldCreateUser: registering
    } });
    if (error) {
      element('login-status').textContent = `${registering ? 'Registrierung' : 'Anmeldung'} fehlgeschlagen: ${error.message}`;
    } else {
      requestedEmail = email;
      element('email-code').value = '';
      element('code-form').hidden = false;
      element('send-link').querySelector('span').textContent = 'Code erneut senden';
      element('login-status').textContent = registering ? 'Registrierungs-E-Mail angefordert.' : 'E-Mail angefordert.';
    }
  } catch { element('login-status').textContent = 'Anmeldedienst nicht erreichbar. Bitte erneut versuchen.'; }
  finally {
    setAuthPending(false);
    if (requestedEmail) element('email-code').focus();
  }
});

element('code-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!auth || authPending || !requestedEmail || !element('code-form').reportValidity()) return;
  const email = requestedEmail;
  const token = element('email-code').value;
  setAuthPending(true);
  element('login-status').textContent = 'E-Mail-Code wird bestaetigt ...';
  try {
    const { data, error } = await auth.verifyOtp({ email, token, type: 'email' });
    if (error) {
      element('login-status').textContent = `Code ungueltig oder abgelaufen: ${error.message}`;
    } else if (!data?.session) {
      element('login-status').textContent = 'Anmeldung konnte nicht bestaetigt werden.';
    } else {
      await applySession(data.session);
      if (user) {
        resetEmailCode();
        element('login-dialog').close();
        element('login-status').textContent = 'Anmeldung erfolgreich.';
      } else {
        element('login-status').textContent = 'Sitzung konnte nicht verifiziert werden. Bitte erneut versuchen.';
      }
    }
  } catch {
    element('login-status').textContent = 'Anmeldedienst nicht erreichbar. Bitte erneut versuchen.';
  } finally {
    setAuthPending(false);
    if (requestedEmail) element('email-code').focus();
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
  const wasControlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (wasControlled) element('update-app').hidden = false;
  });
  element('update-app').addEventListener('click', () => location.reload());
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(registration => {
    const checkForUpdate = () => {
      if (navigator.onLine && !document.hidden) void registration.update().catch(() => {});
    };
    window.addEventListener('online', checkForUpdate);
    window.addEventListener('focus', checkForUpdate);
    window.addEventListener('pageshow', checkForUpdate);
    document.addEventListener('visibilitychange', checkForUpdate);
    void checkForUpdate();
    setInterval(checkForUpdate, 30 * 60 * 1000);
  }).catch(() => { showMapStatus('Offline-App konnte nicht eingerichtet werden.', 'error'); });
}

if (savedSelection) {
  element('source').value = savedSelection.sourceId;
  void loadSelectedSource();
}

function boundaryRings(geometry) {
  return boundaryPolygons(geometry).flat();
}

function boundaryPolygons(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function renderBoundaryEditParts() {
  boundaryEditParts.clearLayers();
  boundaryPolygons(boundaryEditGeometry).forEach((polygon, index) => {
    const layer = L.polygon(polygon[0].map(([longitude, latitude]) => [latitude, longitude]), {
      color: selectedBoundaryPart === index ? '#e2a930' : '#c43b55',
      weight: selectedBoundaryPart === index ? 4 : 2,
      opacity: 0.8,
      fillColor: selectedBoundaryPart === index ? '#e2a930' : '#c43b55',
      fillOpacity: selectedBoundaryPart === index ? 0.16 : 0.001,
      className: 'boundary-edit-part'
    });
    layer.on('click', () => {
      selectedBoundaryPart = index;
      selectedBoundaryVertex = null;
      renderBoundaryEditParts();
      updateProfileControls();
    });
    boundaryEditParts.addLayer(layer);
  });
}

function renderBoundaryEditHandles() {
  boundaryEditHandles.clearLayers();
  selectedBoundaryVertex = null;
  const vertexIcon = L.divIcon({ className: 'boundary-edit-handle boundary-edit-vertex', iconSize: [18, 18], iconAnchor: [9, 9] });
  const midpointIcon = L.divIcon({ className: 'boundary-edit-handle boundary-edit-midpoint', iconSize: [14, 14], iconAnchor: [7, 7] });
  boundaryPolygons(boundaryEditGeometry).forEach((polygon, polygonIndex) => {
    polygon.forEach((ring, ringIndex) => {
      const vertexCount = ring.length - 1;
      for (let index = 0; index < vertexCount; index += 1) {
        const coordinate = ring[index];
        const vertex = L.marker([coordinate[1], coordinate[0]], {
          draggable: true, keyboard: true, title: 'Grenzpunkt verschieben', icon: vertexIcon
        });
        vertex.on('click', () => {
          selectedBoundaryPart = null;
          selectedBoundaryVertex = { polygon, ring, ringIndex, index };
          renderBoundaryEditParts();
          updateProfileControls();
        });
        vertex.on('drag', event => {
          const { lat, lng } = event.target.getLatLng();
          ring[index] = [lng, lat];
          if (index === 0) ring[vertexCount] = [...ring[0]];
          if (boundary) {
            boundary.clearLayers();
            boundary.addData({ ...selected, geometry: boundaryEditGeometry });
          }
        });
        vertex.on('dragend', () => {
          renderBoundaryEditParts();
          renderBoundaryEditHandles();
          updateProfileControls();
        });
        boundaryEditHandles.addLayer(vertex);

        const next = ring[(index + 1) % vertexCount];
        const midpoint = L.marker([(coordinate[1] + next[1]) / 2, (coordinate[0] + next[0]) / 2], {
          keyboard: true, title: 'Grenzpunkt hinzufuegen', icon: midpointIcon
        });
        midpoint.on('click', () => {
          selectedBoundaryPart = null;
          ring.splice(index + 1, 0, [(coordinate[0] + next[0]) / 2, (coordinate[1] + next[1]) / 2]);
          ring[ring.length - 1] = [...ring[0]];
          if (boundary) {
            boundary.clearLayers();
            boundary.addData({ ...selected, geometry: boundaryEditGeometry });
          }
          renderBoundaryEditParts();
          renderBoundaryEditHandles();
          updateProfileControls();
        });
        boundaryEditHandles.addLayer(midpoint);
      }
    });
  });
}

function startBoundaryEditing() {
  if (currentSource()?.type !== 'profile-imports' || !canEditProfile() || !selected) return;
  resetMarkerPlacement();
  boundaryEditGeometry = JSON.parse(JSON.stringify(selected.geometry));
  selectedBoundaryPart = null;
  renderBoundaryEditParts();
  renderBoundaryEditHandles();
  updateProfileControls();
}

function stopBoundaryEditing(restore = false) {
  if (restore && boundary && selected) {
    boundary.clearLayers();
    boundary.addData(selected);
  }
  boundaryEditGeometry = null;
  selectedBoundaryVertex = null;
  selectedBoundaryPart = null;
  boundaryEditHandles.clearLayers();
  boundaryEditParts.clearLayers();
  boundaryEditPending = false;
  if (element('edit-boundary')) updateProfileControls();
}

async function saveBoundaryEditing() {
  const profile = activeProfile;
  if (!profile || !canEditProfile(profile) || currentSource()?.type !== 'profile-imports' ||
      !boundaryEditGeometry || !supabaseClient || boundaryEditPending) return;
  boundaryEditPending = true;
  updateProfileControls();
  const geometry = JSON.parse(JSON.stringify(boundaryEditGeometry));
  const { error } = await supabaseClient.rpc('set_hunting_profile_boundary', {
    p_profile_id: profile.id, p_geometry: geometry
  });
  boundaryEditPending = false;
  if (activeProfile?.id !== profile.id || currentSource()?.type !== 'profile-imports') return;
  if (error) {
    updateProfileControls();
    profileStatus(`Grenze konnte nicht gespeichert werden: ${error.message}`);
    return;
  }
  selected = { ...selected, geometry };
  features = features.map(feature => featureIdentifier(feature, currentSource()) === profile.feature_id
    ? { ...feature, geometry } : feature);
  stopBoundaryEditing();
  if (boundary) {
    boundary.clearLayers();
    boundary.addData(selected);
  }
  profileStatus('Reviergrenze gespeichert.');
}