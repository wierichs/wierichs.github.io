import { loadBoundaries } from './data.js';

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