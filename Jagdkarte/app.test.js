export async function initializeAppFixture() {
  const parsed = new DOMParser().parseFromString(await (await fetch('./index.html')).text(), 'text/html');
  document.body.replaceChildren(...parsed.body.childNodes);
  for (const stylesheet of parsed.querySelectorAll('link[rel="stylesheet"]')) document.head.append(stylesheet);
  const geometry = { type: 'Polygon', coordinates: [[[6, 49], [7, 49], [7, 50], [6, 50], [6, 49]]] };
  const state = { user: null, mode: false, gpsRequests: 0, modeRequests: 0, pendingMode: null, holdMode: false, denyLocation: false };
  let authCallback = () => {};
  const profile = () => ({ id: 'test-profile', source_id: 'user-imports', feature_id: 'jwd-test',
    district_name: 'Privates Testrevier', owner_id: 'owner', created_at: '2026-01-01',
    hunting_mode: state.mode, boundary_geojson: geometry });
  const rowsFor = table => {
    if (table === 'hunting_temporary_marker_types') return [
      { type_id: 'anschuss', requires_current_location: true, editors_only: false },
      { type_id: 'wildsichtung', requires_current_location: true, editors_only: false },
      { type_id: 'standplatz', requires_current_location: false, editors_only: true }
    ];
    if (!state.user) return [];
    if (table === 'hunting_profiles') return [profile()];
    if (table === 'hunting_profile_members') return [{ profile_id: 'test-profile', user_id: 'member', role: 'guest' }];
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
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(success, error) {
      state.gpsRequests += 1;
      if (state.denyLocation) { error({ code: 1 }); return; }
      success({ coords: { latitude: 49.5, longitude: 6.5, accuracy: 5 } });
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
  const previousProfileChoice = localStorage.getItem(profileStorageKey);
  localStorage.removeItem(profileStorageKey);
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
    legendButton.click();
    assert(control('map-key').hidden && legendButton.getAttribute('aria-expanded') === 'false' &&
      legendButton.getAttribute('aria-label') === 'Legende anzeigen', 'Legend did not collapse accessibly.');
    legendButton.click();
    assert(!control('map-key').hidden && legendButton.getAttribute('aria-expanded') === 'true' &&
      legendButton.getAttribute('aria-label') === 'Legende ausblenden', 'Legend did not expand accessibly.');
    passed.push('App legend can be collapsed and expanded accessibly');
    const change = (id, value) => {
      control(id).value = value;
      control(id).dispatchEvent(new frame.Event('change', { bubbles: true }));
    };
    state.signIn('member');
    await waitFor(() => !control('user-label').hidden);
    change('source', 'user-imports');
    await waitFor(() => control('results').querySelector('button'));
    control('results').querySelector('button').click();
    await waitFor(() => control('profile-list').querySelector('option[value="test-profile"]'));
    state.mode = true;
    change('profile-list', 'test-profile');
    await waitFor(() => control('profile-list').value === 'test-profile' && !control('share-location-control').hidden);
    assert(state.gpsRequests === 0 && !control('location-consent-dialog'),
      'Selecting a shared profile should not request location or show a blocking consent dialog.');
    control('share-location').checked = true;
    control('share-location').dispatchEvent(new frame.Event('change', { bubbles: true }));
    await waitFor(() => state.gpsRequests === 1);
    assert(control('profile-list').value === 'test-profile', 'Location sharing changed the active profile.');
    passed.push('Shared profile location requires explicit opt-in and remains available without it');
    await waitFor(() => frame.document.querySelectorAll('.profile-location-marker').length === 1);
    passed.push('App shows the last known participant position after a long pause');
    control('share-location').checked = false;
    control('share-location').dispatchEvent(new frame.Event('change', { bubbles: true }));
    await waitFor(() => control('profile-list').value === 'test-profile' && !control('share-location').checked);
    assert(state.gpsRequests === 1, 'Stopping location sharing restarted location requests.');
    state.denyLocation = true;
    control('share-location').checked = true;
    control('share-location').dispatchEvent(new frame.Event('change', { bubbles: true }));
    await waitFor(() => control('share-location-status').textContent.includes('Browser-Standortzugriff abgelehnt'));
    assert(control('profile-list').value === 'test-profile' && !control('share-location').checked && state.gpsRequests === 2,
      'Denying browser location access should keep the shared profile available without sharing.');
    state.denyLocation = false;
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
    change('source', 'user-imports');
    await waitFor(() => control('results').querySelector('button'));
    control('results').querySelector('button').click();
    await waitFor(() => control('profile-list').value === 'test-profile' && !control('hunting-mode-control').hidden);
    await waitFor(() => state.gpsRequests === 3);
    state.holdMode = true;
    control('hunting-mode').checked = false;
    control('hunting-mode').dispatchEvent(new frame.Event('change', { bubbles: true }));
    await waitFor(() => state.pendingMode);
    control('clear').click();
    state.pendingMode();
    await waitFor(() => !control('hunting-mode').disabled);
    assert(control('selection').hidden && control('presence-status').hidden && state.gpsRequests === 3,
    'A stale hunting mode write restarted profile UI or GPS.');
    passed.push('App ignores a pending hunting-mode response after selection changes');
    return passed;
  } finally {
    iframe.remove();
    if (previousProfileChoice === null) localStorage.removeItem(profileStorageKey);
    else localStorage.setItem(profileStorageKey, previousProfileChoice);
  }
}