export async function initializeAppFixture() {
  const parsed = new DOMParser().parseFromString(await (await fetch('./index.html')).text(), 'text/html');
  document.body.replaceChildren(...parsed.body.childNodes);
  for (const stylesheet of parsed.querySelectorAll('link[rel="stylesheet"]')) document.head.append(stylesheet);
  const state = { user: null, mode: false, gpsRequests: 0, modeRequests: 0, pendingMode: null, holdMode: false,
    denyLocation: false, memberRole: 'guest', moveRequests: [], typeChangeRequests: [], markerType: 'sonstiges',
    boundaryRequests: [], createdProfiles: [], importedProfiles: [],
    currentPosition: { latitude: 49.5, longitude: 6.5 } };
  state.boundaryGeometry = { type: 'MultiPolygon', coordinates: [
    [[[6, 49], [7, 49], [7, 50], [6, 50], [6, 49]], [[6.2, 49.2], [6.3, 49.2], [6.3, 49.3], [6.2, 49.3], [6.2, 49.2]]],
    [[[8, 49], [9, 49], [9, 50], [8, 50], [8, 49]]]
  ] };
  let authCallback = () => {};
  const profile = () => ({ id: 'test-profile', source_id: 'user-imports', feature_id: 'jwd-test',
    district_name: 'Privates Testrevier', owner_id: 'owner', created_at: '2026-01-01',
    hunting_mode: state.mode, boundary_geojson: state.boundaryGeometry });
  const rowsFor = table => {
    if (table === 'hunting_temporary_marker_types') return [
      { type_id: 'anschuss', requires_current_location: true, editors_only: false },
      { type_id: 'wildsichtung', requires_current_location: true, editors_only: false },
      { type_id: 'standplatz', requires_current_location: false, editors_only: true }
    ];
    if (!state.user) return [];
    if (table === 'hunting_profiles') return [profile(), ...state.importedProfiles];
    if (table === 'hunting_profile_members') return [{ profile_id: 'test-profile', user_id: 'member', role: state.memberRole }];
    if (table === 'hunting_markers') return [{ id: 'test-marker', profile_id: 'test-profile', type_id: state.markerType,
      title: 'Testmarker', notes: '', latitude: 49.6, longitude: 6.6, created_by: 'owner',
      created_at: '2026-01-01T00:00:00Z', expires_at: null }];
    if (table === 'hunting_profile_locations') return [{ profile_id: 'test-profile', user_id: 'member',
      latitude: 49.5, longitude: 6.5, accuracy: 12,
      updated_at: new Date(Date.now() - 15 * 60 * 1000).toISOString() }];
    return [];
  };
  const query = table => {
    const filters = [];
    const minimums = [];
    let range = null;
    let single = false;
    let write = false;
    return {
      select() { return this; },
      eq(key, value) { filters.push([key, value]); return this; },
      is(key, value) { return this.eq(key, value); },
      gte(key, value) { minimums.push([key, value]); return this; },
      order() { return this; },
      range(start, end) { range = [start, end]; return this; },
      maybeSingle() { single = true; return this; },
      upsert() { write = true; return this; },
      delete() { write = true; return this; },
      then(resolve, reject) {
        let data = write ? [] : rowsFor(table).filter(row => filters.every(([key, value]) => row[key] === value) &&
          minimums.every(([key, value]) => row[key] >= value));
        if (range) data = data.slice(range[0], range[1] + 1);
        return Promise.resolve({ data: single ? data[0] || null : data, error: null }).then(resolve, reject);
      }
    };
  };
  const client = {
    from: query,
    rpc(name, parameters) {
      if (name === 'set_hunting_profile_boundary') {
        state.boundaryRequests.push(parameters);
        if (parameters.p_profile_id === 'test-profile') state.boundaryGeometry = parameters.p_geometry;
        else {
          const importedProfile = state.importedProfiles.find(candidate => candidate.id === parameters.p_profile_id);
          if (importedProfile) importedProfile.boundary_geojson = parameters.p_geometry;
        }
        return Promise.resolve({ data: null, error: null });
      }
      if (name === 'create_hunting_profile') {
        const createdProfile = { id: `imported-profile-${state.createdProfiles.length + 1}`,
          source_id: parameters.p_source_id, feature_id: parameters.p_feature_id,
          district_name: parameters.p_district_name, owner_id: state.user.id,
          created_at: '2026-10-20', hunting_mode: false, boundary_geojson: null };
        state.createdProfiles.push(parameters);
        state.importedProfiles.push(createdProfile);
        return Promise.resolve({ data: createdProfile, error: null });
      }
      if (name === 'change_hunting_marker_type') {
        state.typeChangeRequests.push(parameters);
        state.markerType = parameters.p_type_id;
        return Promise.resolve({ data: null, error: null });
      }
      if (name === 'move_hunting_marker_to_location') {
        state.moveRequests.push(parameters);
        return Promise.resolve({ data: null, error: null });
      }
      if (name === 'set_hunting_mode') {
        state.modeRequests += 1;
        if (state.holdMode) return new Promise(resolve => {
          state.pendingMode = () => { state.mode = parameters.p_enabled; resolve({ data: state.mode, error: null }); };
        });
        state.mode = parameters.p_enabled;
      }
      if (name === 'get_hunting_profile_owner_emails') {
        const data = [{ profile_id: 'test-profile', owner_email: 'owner@example.test' }];
        return { order() { return this; }, async range(start, end) { return { data: data.slice(start, end + 1), error: null }; } };
      }
      if (name === 'get_hunting_profile_participants') {
        return { order() { return this; }, async range() { return { data: [], error: null }; } };
      }
      return Promise.resolve({ data: null, error: null });
    },
    auth: {
      async getSession() { return { data: { session: null }, error: null }; },
      async getUser() { return { data: { user: state.user }, error: null }; },
      onAuthStateChange(callback) { authCallback = callback; },
      async signOut() { state.user = null; authCallback('SIGNED_OUT', null); return { error: null }; }
    }
  };
  window.supabase = { createClient: () => client };
  window.confirm = () => true;
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(success, error) {
      state.gpsRequests += 1;
      if (state.denyLocation) { error({ code: 1 }); return; }
      success({ coords: { ...state.currentPosition, accuracy: 5 } });
    }
  } });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    controller: null, addEventListener() {}, async register() { return { async update() {} }; }
  } });
  state.signIn = id => { state.user = { id, email: `${id}@example.test` }; authCallback('SIGNED_IN', { user: state.user }); };
  window.jagdkarteTest = state;
  await import('./vendor/leaflet/leaflet.js');
  await import('./lucide.js');
  await import('./config.js');
  window.JAGDKARTE_CONFIG.mapTilerApiKey = 'mock-maptiler-key';
  const tileLayer = window.L.tileLayer;
  window.L.tileLayer = (_url, options) => tileLayer('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHh0AAAAASUVORK5CYII=', options);
  await import('./app.js');
  state.ready = true;
}

export async function runAppTests() {
  const profileStorageKey = 'jagdkarte-last-profile-v1';
  const locationConsentStorageKey = 'jagdkarte-location-consent-v1';
  const previousProfileChoice = localStorage.getItem(profileStorageKey);
  const previousLocationConsents = localStorage.getItem(locationConsentStorageKey);
  localStorage.removeItem(profileStorageKey);
  localStorage.removeItem(locationConsentStorageKey);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;left:-10000px;width:1200px;height:800px;border:0';
  iframe.src = './tests.html?app-fixture';
  document.body.append(iframe);
  const passed = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = async condition => {
    const deadline = Date.now() + 10000;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error('App test timed out.');
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  };
  try {
    await waitFor(() => iframe.contentWindow?.jagdkarteTest?.ready);
    const frame = iframe.contentWindow;
    const state = frame.jagdkarteTest;
    const control = id => frame.document.getElementById(id);
    const satelliteButton = control('toggle-satellite');
    assert(!satelliteButton.hidden && !frame.document.querySelector('.leaflet-control-layers'),
      'MapTiler should use only the direct satellite toolbar switch.');
    satelliteButton.click();
    assert(satelliteButton.getAttribute('aria-pressed') === 'true' &&
      frame.document.querySelector('.maptiler-attribution-logo'), 'Satellite switch did not activate the basemap.');
    satelliteButton.click();
    assert(satelliteButton.getAttribute('aria-pressed') === 'false', 'Satellite switch did not return to OSM.');
    passed.push('App offers satellite imagery alongside OSM with a configured key');
    const legendButton = control('toggle-map-legend');
    assert(control('map-key').hidden && legendButton.getAttribute('aria-expanded') === 'false' &&
      legendButton.getAttribute('aria-label') === 'Legende anzeigen', 'Legend should start collapsed accessibly.');
    legendButton.click();
    assert(!control('map-key').hidden && legendButton.getAttribute('aria-expanded') === 'true' &&
      legendButton.getAttribute('aria-label') === 'Legende ausblenden', 'Legend did not expand accessibly.');
    legendButton.click();
    assert(control('map-key').hidden && legendButton.getAttribute('aria-expanded') === 'false' &&
      legendButton.getAttribute('aria-label') === 'Legende anzeigen', 'Legend did not collapse accessibly.');
    passed.push('App legend can be collapsed and expanded accessibly');
    const change = (id, value) => {
      control(id).value = value;
      control(id).dispatchEvent(new frame.Event('change', { bubbles: true }));
    };
    state.memberRole = 'editor';
    state.signIn('member');
    await waitFor(() => !control('user-label').hidden);
    change('source', 'user-imports');
    await waitFor(() => control('results').querySelector('button'));
    control('results').querySelector('button').click();
    assert(frame.document.querySelector('#app-layout').classList.contains('search-collapsed') &&
      control('search-panel-body').hidden && control('toggle-search-panel').getAttribute('aria-expanded') === 'false',
    'Selecting a district should collapse the search controls.');
    const mapLayout = control('app-layout');
    assert(mapLayout.classList.contains('has-selection') &&
      frame.getComputedStyle(control('search-panel')).position === 'absolute' &&
      Math.abs(control('map-surface').getBoundingClientRect().width - mapLayout.getBoundingClientRect().width) < 1,
    'The selected-revier panel should overlay the full-width map.');
    control('toggle-search-panel').click();
    assert(!control('search-panel-body').hidden && control('toggle-search-panel').getAttribute('aria-expanded') === 'true',
      'The collapsed search panel should remain manually expandable.');
    control('toggle-search-panel').click();
    await waitFor(() => control('profile-list').querySelector('option[value="test-profile"]'));
    state.mode = true;
    change('profile-list', 'test-profile');
    await waitFor(() => control('profile-list').value === 'test-profile' && !control('share-location-control').hidden);
    await waitFor(() => frame.document.querySelector('#map .leaflet-marker-pane img.leaflet-marker-icon'));
    const placementMarker = frame.document.querySelector('#map .leaflet-marker-pane img.leaflet-marker-icon');
    const placementBounds = placementMarker.getBoundingClientRect();
    control('add-marker').click();
    control('map').dispatchEvent(new frame.MouseEvent('click', { bubbles: true,
      clientX: placementBounds.left + placementBounds.width / 2,
      clientY: placementBounds.top + placementBounds.height / 2 }));
    await waitFor(() => frame.document.querySelector('#map .leaflet-popup #marker-form'));
    const popupMarkerForm = control('marker-form');
    assert(!popupMarkerForm.hidden && popupMarkerForm.closest('.leaflet-popup') &&
      control('map-surface').contains(popupMarkerForm), 'New marker form should open as a map popup.');
    control('cancel-marker').click();
    await waitFor(() => !frame.document.querySelector('#map .leaflet-popup #marker-form'));
    assert(popupMarkerForm.hidden && popupMarkerForm.parentElement === control('profile-section'),
      'Cancel should close the map popup and restore the hidden marker form.');
    passed.push('New marker form opens on the map and restores cleanly on cancel');
    const addMarkerButton = control('add-marker');
    assert(addMarkerButton.parentElement.classList.contains('map-toolbar') && !addMarkerButton.hidden &&
      !control('profile-section').querySelector('#add-marker'), 'Marker placement should be available from the map toolbar.');
    addMarkerButton.click();
    assert(addMarkerButton.getAttribute('aria-pressed') === 'true', 'Map marker placement did not activate.');
    addMarkerButton.click();
    assert(addMarkerButton.getAttribute('aria-pressed') === 'false', 'Map marker placement did not cancel.');
    passed.push('Marker placement is available from the map toolbar');
    let exportedBlob = null;
    let exportedFilename = '';
    const originalCreateObjectURL = frame.URL.createObjectURL;
    const originalAnchorClick = frame.HTMLAnchorElement.prototype.click;
    frame.URL.createObjectURL = blob => { exportedBlob = blob; return 'blob:test-export'; };
    frame.HTMLAnchorElement.prototype.click = function() { exportedFilename = this.download; };
    try {
      control('download').click();
      await waitFor(() => exportedBlob !== null);
      const exportedProfile = JSON.parse(await exportedBlob.text());
      assert(exportedBlob.type === 'application/octet-stream' &&
        exportedFilename === `${exportedProfile.title}.jwd` &&
        exportedProfile.title === control('selected-name').textContent &&
        exportedProfile.huntingGround.facilities.length === 1 &&
        exportedProfile.huntingGround.facilities[0].title === 'Sonstiges: Testmarker',
      'Selected profile download should include its persistent markers in a named JWD file.');
    } finally {
      frame.URL.createObjectURL = originalCreateObjectURL;
      frame.HTMLAnchorElement.prototype.click = originalAnchorClick;
    }
    passed.push('Selected district download includes persistent profile markers in a named JWD file');
    assert(!control('edit-boundary').hidden, 'An editor should be able to edit an imported boundary.');
    control('edit-boundary').click();
    await waitFor(() => frame.document.querySelector('.boundary-edit-midpoint'));
    frame.document.querySelector('.boundary-edit-midpoint').click();
    assert(frame.document.querySelectorAll('.boundary-edit-midpoint').length === 13,
      'Adding a midpoint should split the imported polygon edge.');
    frame.document.querySelector('.boundary-edit-vertex').click();
    assert(!control('remove-boundary-point').disabled, 'Selecting a boundary vertex should enable point removal.');
    control('remove-boundary-point').click();
    assert(frame.document.querySelectorAll('.boundary-edit-midpoint').length === 12,
      'Removing a vertex should restore the original number of polygon edges.');
    frame.document.querySelectorAll('.boundary-edit-vertex')[4].click();
    assert(control('remove-boundary-part').querySelector('span').textContent === 'Innenfläche entfernen' &&
      !control('remove-boundary-part').disabled, 'A selected interior ring should offer hole removal.');
    control('remove-boundary-part').click();
    assert(frame.document.querySelectorAll('.boundary-edit-midpoint').length === 8,
      'Removing an interior ring should keep its exterior polygon.');
    frame.document.querySelectorAll('.boundary-edit-part')[1]
      .dispatchEvent(new frame.MouseEvent('click', { bubbles: true }));
    assert(control('remove-boundary-part').querySelector('span').textContent === 'Teilfläche entfernen' &&
      !control('remove-boundary-part').disabled, 'Selecting a MultiPolygon component should offer area removal.');
    control('remove-boundary-part').click();
    assert(frame.document.querySelectorAll('.boundary-edit-part').length === 1 &&
      frame.document.querySelectorAll('.boundary-edit-midpoint').length === 4,
    'Removing a MultiPolygon component should retain the remaining component.');
    frame.document.querySelector('.boundary-edit-part')
      .dispatchEvent(new frame.MouseEvent('click', { bubbles: true }));
    assert(control('remove-boundary-part').disabled,
      'The final remaining polygon component should not be removable.');
    control('cancel-boundary').click();
    assert(state.boundaryRequests.length === 1 && state.boundaryGeometry.coordinates.length === 2 &&
      state.boundaryGeometry.coordinates[0].length === 2 &&
      control('edit-boundary').hidden === false, 'Cancel should discard unsaved boundary changes.');
    const importedSource = frame.JAGDKARTE_CONFIG.sources.find(source => source.id === 'user-imports');
    importedSource.type = 'snapshot';
    change('profile-list', 'test-profile');
    await waitFor(() => control('edit-boundary').hidden);
    importedSource.type = 'profile-imports';
    change('profile-list', 'test-profile');
    await waitFor(() => !control('edit-boundary').hidden);
    control('edit-boundary').click();
    await waitFor(() => frame.document.querySelector('.boundary-edit-midpoint'));
    frame.document.querySelector('.boundary-edit-midpoint').click();
    const boundaryRequestCount = state.boundaryRequests.length;
    control('save-boundary').click();
    await waitFor(() => state.boundaryRequests.length === boundaryRequestCount + 1 &&
      control('profile-status').textContent === 'Reviergrenze gespeichert.');
    const savedBoundary = state.boundaryRequests.at(-1);
    assert(savedBoundary.p_profile_id === 'test-profile' && savedBoundary.p_geometry.coordinates[0][0].length === 6,
    'Saving an edited boundary should persist the updated GeoJSON through the boundary RPC.');
    passed.push('Imported boundary editing is source-gated and supports add, cancel, and RPC save');
    assert(state.gpsRequests === 0 && !control('location-consent-dialog'),
      'Selecting a shared profile should not request location or show a blocking consent dialog.');
    await waitFor(() => frame.document.querySelector('#map .leaflet-marker-pane img.leaflet-marker-icon'));
    frame.document.querySelector('#map .leaflet-marker-pane img.leaflet-marker-icon').click();
    await waitFor(() => Array.from(frame.document.querySelectorAll('.profile-marker-popup button'))
      .some(button => button.getAttribute('aria-label') === 'Auf aktuelle Position verschieben'));
    const moveButton = Array.from(frame.document.querySelectorAll('.profile-marker-popup button'))
      .find(button => button.getAttribute('aria-label') === 'Auf aktuelle Position verschieben');
    const removeButton = Array.from(frame.document.querySelectorAll('.profile-marker-popup button'))
      .find(button => button.getAttribute('aria-label') === 'Markierung loeschen');
    assert(moveButton.title === 'Auf aktuelle Position verschieben' && moveButton.querySelector('svg') &&
      moveButton.textContent.trim() === '' && removeButton?.title === 'Markierung loeschen' && removeButton.querySelector('svg'),
    'Marker popup actions should render as accessible icon-only buttons.');
    moveButton.click();
    await waitFor(() => state.moveRequests.length === 1);
    assert(state.moveRequests[0].p_marker_id === 'test-marker' && state.moveRequests[0].p_latitude === 49.5 &&
      state.moveRequests[0].p_longitude === 6.5, 'Editor marker move did not submit the current GPS position.');
    passed.push('Editor can move a marker to the current position');
    await waitFor(() => frame.document.querySelector('#map .leaflet-marker-pane img.leaflet-marker-icon'));
    frame.document.querySelector('#map .leaflet-marker-pane img.leaflet-marker-icon').click();
    await waitFor(() => Array.from(frame.document.querySelectorAll('.profile-marker-popup button'))
      .some(button => button.getAttribute('aria-label') === 'Markertyp ändern'));
    const editTypeButton = Array.from(frame.document.querySelectorAll('.profile-marker-popup button'))
      .find(button => button.getAttribute('aria-label') === 'Markertyp ändern');
    editTypeButton.click();
    const typeForm = frame.document.querySelector('.profile-marker-type-form');
    const typeSelect = typeForm.querySelector('select');
    assert(!typeForm.hidden && !Array.from(typeSelect.options).some(option =>
      ['anschuss', 'wildsichtung', 'standplatz'].includes(option.value)),
    'Marker type editor exposed temporary types or did not open.');
    typeSelect.value = 'erdsitz';
    typeForm.dispatchEvent(new frame.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => state.typeChangeRequests.length === 1 &&
      control('profile-status').textContent === 'Markertyp geändert.');
    await waitFor(() => Array.from(frame.document.querySelectorAll('#map .leaflet-marker-pane img.leaflet-marker-icon'))
      .some(icon => icon.getAttribute('src')?.endsWith('/markers/erdsitz.svg')));
    assert(state.typeChangeRequests[0].p_marker_id === 'test-marker' &&
      state.typeChangeRequests[0].p_type_id === 'erdsitz', 'Marker type editor sent incorrect RPC parameters.');
    passed.push('Editor can change a permanent marker type; temporary types are excluded');
    state.currentPosition = { latitude: 52, longitude: 8 };
    await waitFor(() => frame.document.querySelector('#map .leaflet-marker-pane img.leaflet-marker-icon'));
    frame.document.querySelector('#map .leaflet-marker-pane img.leaflet-marker-icon').click();
    await waitFor(() => Array.from(frame.document.querySelectorAll('.profile-marker-popup button'))
      .some(button => button.getAttribute('aria-label') === 'Auf aktuelle Position verschieben'));
    Array.from(frame.document.querySelectorAll('.profile-marker-popup button'))
      .find(button => button.getAttribute('aria-label') === 'Auf aktuelle Position verschieben').click();
    await waitFor(() => control('profile-status').textContent.includes('ausserhalb des Reviers'));
    assert(state.moveRequests.length === 1, 'Marker move outside the district reached the database.');
    state.currentPosition = { latitude: 49.5, longitude: 6.5 };
    passed.push('Marker move outside the selected district is rejected');
    control('share-location').checked = true;
    control('share-location').dispatchEvent(new frame.Event('change', { bubbles: true }));
    await waitFor(() => state.gpsRequests === 3);
    assert(control('profile-list').value === 'test-profile', 'Location sharing changed the active profile.');
    passed.push('Shared profile location requires explicit opt-in and remains available without it');
    await waitFor(() => frame.document.querySelectorAll('.profile-location-marker').length === 1);
    passed.push('App shows the last known participant position after a long pause');
    control('share-location').checked = false;
    control('share-location').dispatchEvent(new frame.Event('change', { bubbles: true }));
    await waitFor(() => control('profile-list').value === 'test-profile' && !control('share-location').checked);
    assert(state.gpsRequests === 3, 'Stopping location sharing restarted location requests.');
    state.denyLocation = true;
    control('share-location').checked = true;
    control('share-location').dispatchEvent(new frame.Event('change', { bubbles: true }));
    await waitFor(() => control('share-location-status').textContent.includes('Browser-Standortzugriff abgelehnt'));
    assert(control('profile-list').value === 'test-profile' && !control('share-location').checked && state.gpsRequests === 4,
      'Denying browser location access should keep the shared profile available without sharing.');
    state.denyLocation = false;
    assert(JSON.parse(localStorage.getItem(locationConsentStorageKey))['member:test-profile'] === false,
      'Browser location denial did not save a rejection for this user and profile.');
    change('profile-list', '');
    await waitFor(() => control('profile-status').textContent === 'Du siehst dieses Revier wie ein Gast.');
    change('profile-list', 'test-profile');
    await waitFor(() => control('profile-list').value === 'test-profile' &&
      !control('share-location-control').hidden && !control('share-location').checked);
    assert(state.gpsRequests === 4, 'A saved rejection restarted location sharing after a profile switch.');
    control('share-location').checked = true;
    control('share-location').dispatchEvent(new frame.Event('change', { bubbles: true }));
    await waitFor(() => state.gpsRequests === 5);
    assert(JSON.parse(localStorage.getItem(locationConsentStorageKey))['member:test-profile'] === true,
      'Location-sharing approval was not saved for this user and profile.');
    change('profile-list', '');
    await waitFor(() => control('profile-status').textContent === 'Du siehst dieses Revier wie ein Gast.');
    change('profile-list', 'test-profile');
    await waitFor(() => state.gpsRequests === 6 && control('share-location').checked);
    passed.push('Location-sharing approval and rejection persist across profile switches');
    passed.push('Browser location denial keeps the profile available and sharing disabled');

    control('account-button').click();
    await waitFor(() => control('user-label').hidden);
    assert(control('selection').hidden && control('results').children.length === 0 &&
      control('saved-profiles').children.length === 0 && control('result-count').textContent === '0',
    'Logout retained private boundaries or profiles.');
    assert(frame.document.querySelectorAll('.leaflet-overlay-pane path').length === 0, 'Logout retained a private boundary layer.');
    passed.push('App logout clears private import results, selection and map boundary');

    state.signIn('owner');
    await waitFor(() => !control('user-label').hidden);
    await waitFor(() => control('results').querySelector('button'));
    control('results').querySelector('button').click();
    await waitFor(() => control('profile-list').value === 'test-profile' && !control('hunting-mode-control').hidden);
    assert(!control('edit-boundary').hidden, 'The owner should be able to edit an imported boundary.');
    await waitFor(() => state.gpsRequests === 7);
    await waitFor(() => frame.document.querySelector('#map .leaflet-marker-pane img.leaflet-marker-icon'));
    frame.document.querySelector('#map .leaflet-marker-pane img.leaflet-marker-icon').click();
    await waitFor(() => Array.from(frame.document.querySelectorAll('.profile-marker-popup button'))
      .some(button => button.getAttribute('aria-label') === 'Auf aktuelle Position verschieben'));
    passed.push('Owner can move a marker from the popup');
    state.holdMode = true;
    control('hunting-mode').checked = false;
    control('hunting-mode').dispatchEvent(new frame.Event('change', { bubbles: true }));
    await waitFor(() => state.pendingMode);
    control('clear').click();
    state.pendingMode();
    await waitFor(() => !control('hunting-mode').disabled);
    assert(control('selection').hidden && control('presence-status').hidden && state.gpsRequests === 7 &&
      !control('app-layout').classList.contains('has-selection') && !control('search-panel-body').hidden,
    'A stale hunting mode write restarted profile UI or GPS.');
    passed.push('App ignores a pending hunting-mode response after selection changes');

    const importMultiPolygon = async name => {
      const geometry = { type: 'MultiPolygon', coordinates: [
        [[[6, 49], [7, 49], [7, 50], [6, 50], [6, 49]]],
        [[[8, 49], [9, 49], [9, 50], [8, 50], [8, 49]]]
      ] };
      const file = new frame.File([JSON.stringify(geometry)], 'mehrere-reviere.geojson', { type: 'application/geo+json' });
      const fileInput = control('import-profile-file');
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
      fileInput.dispatchEvent(new frame.Event('change', { bubbles: true }));
      await waitFor(() => control('boundary-import-dialog').open);
      assert(control('boundary-import-name').value === 'mehrere-reviere', 'Import should prefill the name from the filename.');
      control('boundary-import-name').value = name;
      control('boundary-import-dialog').querySelector('button[value="import"]').click();
      await waitFor(() => state.createdProfiles.length === (name === 'Nordrevier' ? 1 : 2));
      await waitFor(() => control('saved-status').textContent === 'Revierdatei importiert und geoeffnet.');
    };
    await importMultiPolygon('Nordrevier');
    await importMultiPolygon('Suedrevier');
    assert(state.createdProfiles.map(profile => profile.p_district_name).join('|') === 'Nordrevier|Suedrevier' &&
      state.createdProfiles[0].p_feature_id !== state.createdProfiles[1].p_feature_id,
    'Repeated MultiPolygon imports with different names should create separate profiles.');
    passed.push('Repeated MultiPolygon imports accept distinct district names and create separate profiles');
    return passed;
  } finally {
    iframe.remove();
    if (previousProfileChoice === null) localStorage.removeItem(profileStorageKey);
    else localStorage.setItem(profileStorageKey, previousProfileChoice);
    if (previousLocationConsents === null) localStorage.removeItem(locationConsentStorageKey);
    else localStorage.setItem(locationConsentStorageKey, previousLocationConsents);
  }
}