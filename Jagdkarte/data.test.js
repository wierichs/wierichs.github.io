import { loadBoundaries } from './data.js';
import { pointInFeature, pointInRing } from './geometry.js';
import { applyMarkerRules, canShareProfileLocation, fetchAllRows, importJwdProfileData } from './profile-data.js';
import { createJwdExport, findJwdFacilityAdditions, mapJwdFacilities, matchingEditableProfiles, parseJwdImport, parseProfileImport } from './jwd-import.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function feature(id) {
  return {
    type: 'Feature',
    id,
    properties: { id },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }
  };
}

function response(features, properties = {}) {
  return new Response(JSON.stringify({ type: 'FeatureCollection', features, ...properties }), {
    status: 200,
    headers: { 'Content-Type': 'application/geo+json' }
  });
}

async function withFetch(mock, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await action(); }
  finally { globalThis.fetch = originalFetch; }
}

export async function runDataTests() {
  const passed = [];

  const rowOffsets = [];
  const allRows = await fetchAllRows(() => ({ async range(start) {
    rowOffsets.push(start);
    return { data: [0, 1, 2, 3, 4].slice(start, start + 2), error: null };
  } }));
  assert(allRows.data.join(',') === '0,1,2,3,4' && rowOffsets.join(',') === '0,2,4,5',
    'Pagination stopped at a server-side page cap.');
  const failedRows = await fetchAllRows(() => ({ async range(start) {
    return start ? { data: null, error: { message: 'Failed page' } } : { data: [1], error: null };
  } }));
  assert(failedRows.data === null && failedRows.error.message === 'Failed page', 'Pagination exposed an incomplete result.');
  let current = true;
  const cancelledRows = await fetchAllRows(() => ({ async range() {
    current = false;
    return { data: [1], error: null };
  } }), () => current);
  assert(cancelledRows.data === null && cancelledRows.error === null, 'Pagination exposed results after cancellation.');
  passed.push('Profile pagination handles server caps, later-page errors and cancellation');

  const sharedProfile = { id: 'shared', owner_id: 'owner', hunting_mode: true };
  const member = { id: 'member' };
  assert(!canShareProfileLocation(sharedProfile, member, null), 'Shared GPS started without consent.');
  assert(canShareProfileLocation(sharedProfile, member, { profileId: 'shared', userId: 'member' }), 'Bound consent was rejected.');
  assert(!canShareProfileLocation(sharedProfile, member, { profileId: 'other', userId: 'member' }), 'Consent leaked across profiles.');
  assert(!canShareProfileLocation(sharedProfile, member, { profileId: 'shared', userId: 'other' }), 'Consent leaked across users.');
  assert(!canShareProfileLocation({ ...sharedProfile, hunting_mode: false }, { id: 'owner' }), 'GPS started with hunting mode off.');
  assert(canShareProfileLocation(sharedProfile, { id: 'owner' }), 'Owner GPS was unexpectedly blocked.');
  passed.push('Location consent is bound to user, profile and current hunting mode');

  const importCalls = [];
  const importResult = await importJwdProfileData({ async rpc(name, parameters) {
    importCalls.push({ name, parameters });
    return { data: { profile_id: 'imported', inserted_count: 1, duplicate_count: 0, outside_count: 0 }, error: null };
  } }, { name: 'Revier', featureId: 'jwd-test', geometry: feature('test').geometry,
    facilities: [{ typeId: 'bock', title: 'Bock', notes: 'Notiz', latitude: 1, longitude: 1 }] });
  assert(importCalls.length === 1 && importCalls[0].name === 'import_hunting_profile' &&
    importCalls[0].parameters.p_profile_id === null && importCalls[0].parameters.p_facilities[0].notes === 'Notiz' &&
    importResult.profile_id === 'imported', 'JWD import did not use one transactional RPC.');
  let importFailed = false;
  try {
    await importJwdProfileData({ async rpc() { return { data: null, error: { message: 'Import rejected' } }; } },
      { name: 'Revier', facilities: [] });
  } catch (error) { importFailed = error.message === 'Import rejected'; }
  assert(importFailed, 'JWD import hid a database failure.');
  passed.push('JWD persistence uses one RPC and propagates database failures');

  const ruledTypes = applyMarkerRules([{ id: 'bock' }, { id: 'standplatz' }], [
    { type_id: 'standplatz', requires_current_location: false, editors_only: true }
  ]);
  assert(!ruledTypes[0].temporary && ruledTypes[1].temporary && ruledTypes[1].editorsOnly &&
    !ruledTypes[1].requiresCurrentLocation, 'Marker catalog did not use database rules.');
  let invalidRulesRejected = false;
  try { applyMarkerRules([{ id: 'bock' }], [{ type_id: 'missing', requires_current_location: true, editors_only: false }]); }
  catch { invalidRulesRejected = true; }
  assert(invalidRulesRejected, 'Unknown database marker rules were silently ignored.');
  passed.push('Database marker rules control expiry category, editor rights and GPS requirements');

  const imported = parseJwdImport({
    title: ' Test Revier ',
    huntingGround: {
      borders: [[
        { latitude: 0, longitude: 0 }, { latitude: 0, longitude: 2 },
        { latitude: 2, longitude: 2 }, { latitude: 2, longitude: 0 }
      ]],
      pacifiedAreas: [[
        { latitude: 0.5, longitude: 0.5 }, { latitude: 0.5, longitude: 1 },
        { latitude: 1, longitude: 0.5 }
      ]],
      facilities: [{ coordinate: { latitude: 1.5, longitude: 1.5 }, type: 'Bock' }]
    }
  });
  assert(imported.name === 'Test Revier', 'JWD import did not trim the district name.');
  assert(imported.geometry.type === 'Polygon' && imported.geometry.coordinates.length === 2,
    'JWD import did not preserve the pacified area as a polygon hole.');
  assert(imported.geometry.coordinates.every(ring => ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]),
    'JWD import did not close every polygon ring.');
  assert(imported.facilities.length === 1 && imported.facilities[0].type === 'Bock',
    'JWD import did not preserve facility data.');
  passed.push('JWD converts boundaries, pacified areas, and facilities');

  const municipalityImport = parseProfileImport(JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { GEN: 'Temmels' }, geometry: { type: 'Polygon', coordinates: [
      [[6.45, 49.65], [6.5, 49.65], [6.5, 49.7], [6.45, 49.7]]
    ] } },
    { type: 'Feature', properties: { gemeinde: 'Nittel' }, geometry: { type: 'MultiPolygon', coordinates: [
      [[[6.5, 49.6], [6.55, 49.6], [6.55, 49.65], [6.5, 49.6]]]
    ] } }
  ] }), 'gemeinden_simplify200.geojson');
  assert(municipalityImport.candidates.length === 2 && municipalityImport.name === 'gemeinden_simplify200' &&
    municipalityImport.candidates[0].name === 'Temmels' && municipalityImport.candidates[1].name === 'Nittel' &&
    municipalityImport.candidates[0].geometry.coordinates[0].at(-1).join(',') === '6.45,49.65' &&
    municipalityImport.candidates[1].geometry.type === 'MultiPolygon',
    'GeoJSON municipality import did not expose named polygon boundaries with closed rings.');
  const singleGeoJson = parseProfileImport(JSON.stringify({ type: 'Feature', properties: { name: 'Testgemeinde' },
    geometry: { type: 'Polygon', coordinates: [[[6, 49], [7, 49], [7, 50]]] } }), 'boundary.geojson');
  assert(singleGeoJson.name === 'Testgemeinde' && singleGeoJson.geometry.coordinates[0].length === 4,
    'Single-feature GeoJSON did not import directly with a closed polygon ring.');
  const bareGeometry = parseProfileImport({ type: 'Polygon', coordinates: [[[6, 49], [7, 49], [7, 50]]] }, 'direkt.geojson');
  assert(bareGeometry.name === 'direkt' && bareGeometry.geometry.type === 'Polygon',
    'Bare GeoJSON Polygon geometry was not accepted.');
  let invalidGeoJsonRejected = false;
  try {
    parseProfileImport({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [
      [[181, 49], [7, 49], [7, 50]]
    ] } }, 'invalid.geojson');
  } catch (error) { invalidGeoJsonRejected = error.message.includes('ungueltige Koordinaten'); }
  assert(invalidGeoJsonRejected, 'GeoJSON import accepted out-of-range coordinates.');
  passed.push('GeoJSON imports individual municipality Polygon and MultiPolygon boundaries');

  const exportTypes = [{ id: 'bock', label: 'Bock' }, { id: 'anschuss', label: 'Anschuss', temporary: true }];
  const exportMarkers = [
    { type_id: 'bock', title: 'Bock 1', notes: 'Am Waldrand', latitude: 1.5, longitude: 1.5, expires_at: null },
    { type_id: 'anschuss', title: 'Temporary type', latitude: 1, longitude: 1, expires_at: null },
    { type_id: 'bock', title: 'Expiring marker', latitude: 1, longitude: 1, expires_at: '2099-01-01' },
    { type_id: 'unknown', title: 'Other permanent', latitude: 1.2, longitude: 1.2, expires_at: null }
  ];
  const boundaryOnly = parseJwdImport(JSON.stringify(createJwdExport(imported.name, imported.geometry,
    exportMarkers, exportTypes)));
  assert(boundaryOnly.facilities.length === 0 && JSON.stringify(boundaryOnly.geometry) === JSON.stringify(imported.geometry),
    'JWD boundary-only export leaked markers or changed the polygon holes.');
  passed.push('JWD boundary-only export excludes all markers and preserves polygon holes');

  const fullExport = createJwdExport(imported.name, imported.geometry, exportMarkers, exportTypes, true);
  assert(fullExport.title === imported.name && fullExport.lat === 1 && fullExport.lng === 1 &&
    JSON.stringify(fullExport.huntingGround.borders[0][1]) === JSON.stringify({ latitude: 0, longitude: 2 }) &&
    JSON.stringify(fullExport.huntingGround.facilities[0].coordinate) === JSON.stringify({ latitude: 1.5, longitude: 1.5 }),
    'JWD export did not match title, named coordinates, and root reference point of the sample format.');
  passed.push('JWD export uses title, explicit latitude/longitude and root lat/lng');
  const roundTrip = parseJwdImport(JSON.stringify(fullExport));
  assert(roundTrip.facilities.length === 2 && roundTrip.facilities[0].type === 'Bock' &&
    roundTrip.facilities[1].type === 'Hochsitz' && roundTrip.facilities[0].notes === 'Am Waldrand' &&
    mapJwdFacilities(roundTrip.facilities, exportTypes)[0].notes === 'Am Waldrand',
    'JWD full export lost persistent markers or included temporary markers.');
  passed.push('JWD full export includes all persistent types, titles, coordinates and notes, but no temporary markers');

  const catalog = await fetch('./marker-types.json').then(response => response.json());
  const catalogMarkers = catalog.types.map(type => ({
    type_id: type.id, title: type.label, notes: `Notes: ${type.id}`,
    latitude: 1.5, longitude: 1.5, expires_at: null
  }));
  const catalogExport = createJwdExport(imported.name, imported.geometry, catalogMarkers, catalog.types, true);
  const permanentTypes = catalog.types.filter(type => !type.temporary);
  const supportedIds = new Set(['hochsitz', 'bock', 'erdsitz', 'kirrung', 'leiter', 'salzlecke']);
  assert(catalogExport.huntingGround.facilities.length === permanentTypes.length &&
    catalogExport.huntingGround.facilities.every((facility, index) => {
      const type = permanentTypes[index];
      return facility.type === (supportedIds.has(type.id) ? type.label : 'Hochsitz') &&
        facility.title === type.label && facility.notes === `Notes: ${type.id}` &&
        facility.coordinate.latitude === 1.5 && facility.coordinate.longitude === 1.5;
    }), 'JWD export did not map unsupported types to Hochsitz while preserving marker data.');
  passed.push('JWD export preserves supported types and maps unsupported permanent types to Hochsitz');

  const multiGeometry = { type: 'MultiPolygon', coordinates: [imported.geometry.coordinates,
    [[[3, 3], [4, 3], [4, 4], [3, 3]]]] };
  const multiExport = createJwdExport('Multi', multiGeometry);
  assert(JSON.stringify(parseJwdImport(multiExport).geometry) === JSON.stringify(multiGeometry),
    'JWD export did not preserve all MultiPolygon components and holes.');
  passed.push('JWD export preserves MultiPolygon boundaries');

  assert(multiExport.lat === 2 && multiExport.lng === 2,
    'JWD reference point did not include all MultiPolygon components.');
  const asymmetricExport = createJwdExport('Asymmetric', { type: 'Polygon', coordinates: [
    [[-8, 48], [-2, 48], [-2, 50], [-8, 48]]
  ] });
  assert(asymmetricExport.lat === 49 && asymmetricExport.lng === -5,
    'JWD reference point swapped latitude/longitude or used a vertex average instead of the bounds center.');
  passed.push('JWD reference point uses the bounds center of all boundary components');

  const mappedFacilities = mapJwdFacilities([
    { latitude: 1, longitude: 1, type: 'Bock', title: '' },
    { latitude: 1, longitude: 1, type: 'Unbekannt', title: 'Sonderpunkt' }
  ], [{ id: 'bock', label: 'Bock' }, { id: 'sonstiges', label: 'Sonstiges' }]);
  assert(mappedFacilities[0].typeId === 'bock' && mappedFacilities[0].title === 'Bock 1',
    'JWD import did not map a known marker type.');
  assert(mappedFacilities[1].typeId === 'sonstiges' && mappedFacilities[1].notes.includes('Unbekannt'),
    'JWD import did not preserve an unknown marker type with the fallback icon type.');
  passed.push('JWD maps known types and preserves unknown types with the fallback');

  const unknownWithNotes = { latitude: 1, longitude: 1, type: 'Unbekannt', title: 'Sonderpunkt', notes: ' Erste Zeile\nZweite Zeile ' };
  const mappedUnknown = mapJwdFacilities([unknownWithNotes], exportTypes)[0];
  assert(mappedUnknown.notes.endsWith(unknownWithNotes.notes), 'JWD mapping changed original note whitespace.');
  assert(mapJwdFacilities([{ ...unknownWithNotes, notes: mappedUnknown.notes }], exportTypes)[0].notes === mappedUnknown.notes,
    'JWD mapping duplicated the original-type note.');
  passed.push('JWD preserves multiline notes and does not duplicate original-type annotations');

  const polygonWithHole = { geometry: { type: 'Polygon', coordinates: [
    [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
    [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]
  ] } };
  assert(pointInFeature({ lat: 0, lng: 2 }, polygonWithHole), 'Outer polygon boundary should be covered.');
  assert(pointInFeature({ lat: 1, lng: 2 }, polygonWithHole), 'Hole boundary should match PostGIS ST_Covers.');
  assert(!pointInFeature({ lat: 2, lng: 2 }, polygonWithHole), 'Polygon hole interior should not be covered.');
  assert(!pointInRing({ lat: 0, lng: 2 }, polygonWithHole.geometry.coordinates[0], false),
    'Strict containment accepted a boundary point.');
  passed.push('Shared geometry checks handle polygon and hole boundaries consistently');

  const matchingProfiles = matchingEditableProfiles([
    { id: 'owner', district_name: ' Temmels ', owner_id: 'user-1', member_role: 'owner' },
    { id: 'editor', district_name: 'TEMMELS', owner_id: 'user-2', member_role: 'editor' },
    { id: 'guest', district_name: 'Temmels', owner_id: 'user-3', member_role: 'guest' },
    { id: 'other', district_name: 'Trier', owner_id: 'user-1', member_role: 'owner' }
  ], 'temmels', 'user-1');
  assert(matchingProfiles.map(profile => profile.id).join(',') === 'owner,editor',
    'JWD import did not restrict name matches to owner/editor profiles.');
  passed.push('JWD matches same-name owner and editor profiles only');

  const incomingFacilities = [
    { typeId: 'bock', title: 'Bock 1', latitude: 49.67, longitude: 6.47 },
    { typeId: 'hochsitz', title: 'Neue Kanzel', latitude: 49.68, longitude: 6.48 }
  ];
  const merge = findJwdFacilityAdditions(incomingFacilities, [
    { type_id: 'bock', title: 'Bock 1', latitude: 49.6700001, longitude: 6.4700001 }
  ]);
  assert(merge.additions.length === 1 && merge.additions[0].title === 'Neue Kanzel' && merge.duplicateCount === 1,
    'JWD merge did not ignore existing facilities and retain only additions.');
  passed.push('JWD repeated imports retain only new facilities');

  let invalidJwdRejected = false;
  try {
    parseJwdImport({ title: 'Invalid', huntingGround: { borders: [[
      { latitude: 91, longitude: 0 }, { latitude: 0, longitude: 1 }, { latitude: 1, longitude: 0 }
    ]] } });
  } catch (error) { invalidJwdRejected = error.message.includes('ungueltige Koordinaten'); }
  assert(invalidJwdRejected, 'JWD import accepted out-of-range coordinates.');
  passed.push('JWD rejects invalid coordinate ranges');

  await withFetch(async () => response([feature('snapshot-1')]), async () => {
    const result = await loadBoundaries({ type: 'snapshot', url: '/snapshot.geojson' });
    assert(result.length === 1 && result[0].id === 'snapshot-1', 'Snapshot did not load its feature.');
  });
  passed.push('snapshot loads one GeoJSON collection');

  const wfsCalls = [];
  await withFetch(async input => {
    const url = new URL(input);
    wfsCalls.push(url.searchParams.get('STARTINDEX'));
    const start = Number(url.searchParams.get('STARTINDEX'));
    const features = start === 0
      ? Array.from({ length: 500 }, (_, index) => feature(`wfs-${index}`))
      : [feature('wfs-500')];
    return response(features, { numberMatched: 501 });
  }, async () => {
    const result = await loadBoundaries({ type: 'wfs', url: 'https://wfs.example/features', typeName: 'districts' });
    assert(result.length === 501, 'WFS pagination did not load all features.');
  });
  assert(wfsCalls.join(',') === '0,500', 'WFS pagination used unexpected offsets.');
  passed.push('WFS loads all pages of 500 features');

  const ogcCalls = [];
  await withFetch(async input => {
    const url = new URL(input);
    ogcCalls.push(url.href);
    if (url.searchParams.get('offset') === '2') return response([feature('ogc-3')], { numberReturned: 1, numberMatched: 3 });
    return response([feature('ogc-1'), feature('ogc-2')], {
      numberReturned: 2,
      numberMatched: 3,
      links: [{ rel: 'next', href: '/items?offset=2' }]
    });
  }, async () => {
    const result = await loadBoundaries({ type: 'ogcapi', url: 'https://ogc.example/items?limit=2' });
    assert(result.length === 3, 'OGC API pagination did not follow its next link.');
  });
  assert(ogcCalls.length === 2, 'OGC API pagination did not request exactly two pages.');
  passed.push('OGC API follows next links');

  const exactMatchCalls = [];
  await withFetch(async input => {
    exactMatchCalls.push(String(input));
    return response([feature('ogc-1'), feature('ogc-2')], {
      numberReturned: 2,
      numberMatched: 2,
      links: [{ rel: 'next', href: '/items?offset=2' }]
    });
  }, async () => {
    const result = await loadBoundaries({ type: 'ogcapi', url: 'https://ogc.example/items' });
    assert(result.length === 2, 'OGC API did not return the matched features.');
  });
  assert(exactMatchCalls.length === 1, 'OGC API followed a next link after reaching numberMatched.');
  passed.push('OGC API stops when numberMatched is reached');

  const arcgisOffsets = [];
  await withFetch(async input => {
    const url = new URL(input);
    arcgisOffsets.push(url.searchParams.get('resultOffset'));
    assert(url.searchParams.get('f') === 'geojson', 'ArcGIS did not request GeoJSON.');
    assert(url.searchParams.get('outSR') === '4326', 'ArcGIS did not request geographic coordinates.');
    return url.searchParams.get('resultOffset') === '0'
      ? response([feature('arcgis-1'), feature('arcgis-2')], { exceededTransferLimit: true })
      : response([feature('arcgis-3')]);
  }, async () => {
    const result = await loadBoundaries({
      type: 'arcgis', url: 'https://arcgis.example/MapServer', layerId: 5, pageSize: 2
    });
    assert(result.length === 3, 'ArcGIS pagination did not load all features.');
  });
  assert(arcgisOffsets.join(',') === '0,2', 'ArcGIS pagination used unexpected offsets.');
  passed.push('ArcGIS loads all GeoJSON pages');

  await withFetch(async () => response([feature('ogc-1')], { numberReturned: 1, numberMatched: 2 }), async () => {
    let rejected = false;
    try { await loadBoundaries({ type: 'ogcapi', url: 'https://ogc.example/items' }); }
    catch (error) { rejected = error.message.includes('Unvollstaendige OGC-API-Antwort'); }
    assert(rejected, 'Incomplete OGC API response was not rejected.');
  });
  passed.push('OGC API rejects truncated collections');

  return passed;
}