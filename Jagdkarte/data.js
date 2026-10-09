export function featureName(feature, source) {
  const properties = feature.properties || {};
  const value = source.nameFields.map(field => properties[field]).find(value => value !== undefined && value !== null && String(value).trim());
  return value === undefined ? String(feature.id || 'Unbenannter Jagdbezirk') : String(value);
}

export function boundaries(collection) {
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('Der Dienst hat keine GeoJSON-FeatureCollection geliefert.');
  }
  return collection.features.filter(feature => feature.type === 'Feature' &&
    ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type) &&
    Array.isArray(feature.geometry.coordinates) && feature.geometry.coordinates.length);
}

export function wfsUrl(source, startIndex = 0) {
  const url = new URL(source.url);
  Object.entries({ SERVICE: 'WFS', VERSION: '2.0.0', REQUEST: 'GetFeature',
    TYPENAMES: source.typeName, OUTPUTFORMAT: source.outputFormat || 'application/json',
    SRSNAME: source.srsName || 'EPSG:4326', COUNT: '500', STARTINDEX: String(startIndex)
  }).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

async function fetchCollection(url, signal) {
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Datendienst: HTTP ${response.status}`);
  try { return await response.json(); }
  catch { throw new Error('Der Datendienst liefert kein GeoJSON. Format und Dienstkonfiguration pruefen.'); }
}

async function loadOgcApi(source, signal) {
  const origin = new URL(source.url).origin;
  const visited = new Set();
  const features = [];
  let requestUrl = new URL(source.url);
  let received = 0;
  for (let page = 0; page < 40; page += 1) {
    if (visited.has(requestUrl.href)) throw new Error('Der OGC-API-Dienst wiederholt einen Paginierungslink.');
    visited.add(requestUrl.href);
    const collection = await fetchCollection(requestUrl, signal);
    features.push(...boundaries(collection));
    received += collection.features.length;
    const matched = Number(collection.numberMatched);
    const hasMatched = collection.numberMatched != null && Number.isFinite(matched);
    if (hasMatched && received >= matched) return features;
    const next = collection.links?.find(link => link.rel === 'next' && link.href)?.href;
    if (next) {
      const nextUrl = new URL(next, requestUrl);
      if (nextUrl.origin !== origin) throw new Error('Der OGC-API-Paginierungslink verweist auf einen anderen Dienst.');
      requestUrl = nextUrl;
      continue;
    }
    if (hasMatched && received < matched) {
      throw new Error(`Unvollstaendige OGC-API-Antwort: ${received} von ${matched} Features.`);
    }
    return features;
  }
  throw new Error('Der OGC-API-Datensatz ist zu gross. Bitte eine regionale Datenquelle konfigurieren.');
}

export async function loadBoundaries(source, signal) {
  if (source.type === 'snapshot') return boundaries(await fetchCollection(source.url, signal));
  if (source.type === 'ogcapi') return loadOgcApi(source, signal);
  if (source.type !== 'wfs') throw new Error(`Unbekannter Datendiensttyp: ${source.type}`);
  const features = [];
  for (let page = 0; page < 40; page += 1) {
    const collection = await fetchCollection(wfsUrl(source, page * 500), signal);
    features.push(...boundaries(collection));
    if (collection.features.length < 500 || Number(collection.numberMatched) <= (page + 1) * 500) return features;
  }
  throw new Error('Der Datensatz ist zu gross. Bitte eine regionale Datenquelle konfigurieren.');
}