import { pointInRing } from './geometry.js';

function pointFromJwd(value, label) {
  const latitude = value?.latitude;
  const longitude = value?.longitude;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error(`${label}: ungueltige Koordinaten.`);
  }
  return [longitude, latitude];
}

function closeRing(points, label) {
  if (!Array.isArray(points) || points.length < 3) throw new Error(`${label}: mindestens drei Punkte erforderlich.`);
  const ring = points.map((point, index) => pointFromJwd(point, `${label}, Punkt ${index + 1}`));
  const uniquePoints = new Set(ring.map(point => `${point[0]},${point[1]}`));
  if (uniquePoints.size < 3) throw new Error(`${label}: mindestens drei unterschiedliche Punkte erforderlich.`);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  return ring;
}

export function parseJwdImport(text) {
  let data;
  try { data = typeof text === 'string' ? JSON.parse(text) : text; }
  catch { throw new Error('Die Datei enthaelt kein gueltiges JSON.'); }
  const name = typeof data?.title === 'string' ? data.title.trim() : '';
  const huntingGround = data?.huntingGround;
  if (!name || !huntingGround || !Array.isArray(huntingGround.borders) || !huntingGround.borders.length) {
    throw new Error('Die Datei enthaelt keinen Reviertitel oder keine Reviergrenze.');
  }

  const polygons = huntingGround.borders.map((border, index) => [closeRing(border, `Grenze ${index + 1}`)]);
  const pacifiedAreas = huntingGround.pacifiedAreas || [];
  if (!Array.isArray(pacifiedAreas)) throw new Error('Die befriedeten Bereiche haben ein ungueltiges Format.');
  pacifiedAreas.forEach((area, index) => {
    const ring = closeRing(area, `Befriedeter Bereich ${index + 1}`);
    const polygonIndex = polygons.findIndex(polygon => ring.slice(0, -1).every(([longitude, latitude]) =>
      pointInRing({ lat: latitude, lng: longitude }, polygon[0], false)));
    if (polygonIndex < 0) throw new Error(`Befriedeter Bereich ${index + 1} liegt nicht vollstaendig innerhalb einer Reviergrenze.`);
    polygons[polygonIndex].push(ring);
  });

  const rawFacilities = huntingGround.facilities || [];
  if (!Array.isArray(rawFacilities)) throw new Error('Die Einrichtungen haben ein ungueltiges Format.');
  const facilities = rawFacilities.map((facility, index) => {
    const [longitude, latitude] = pointFromJwd(facility?.coordinate, `Einrichtung ${index + 1}`);
    return {
      latitude,
      longitude,
      type: typeof facility.type === 'string' ? facility.type.trim() : '',
      title: typeof facility.title === 'string' ? facility.title.trim() : '',
      notes: typeof facility.notes === 'string' ? facility.notes : ''
    };
  });
  return {
    name,
    geometry: polygons.length === 1
      ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons },
    facilities
  };
}

export function createJwdExport(name, geometry, markers = [], markerTypes = [], includeMarkers = false) {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
    throw new Error('Die Reviergrenze ist kein Polygon.');
  }
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let minLatitude = Infinity;
  let maxLatitude = -Infinity;
  let minLongitude = Infinity;
  let maxLongitude = -Infinity;
  for (const polygon of polygons) {
    for (const [longitude, latitude] of polygon[0]) {
      minLatitude = Math.min(minLatitude, latitude);
      maxLatitude = Math.max(maxLatitude, latitude);
      minLongitude = Math.min(minLongitude, longitude);
      maxLongitude = Math.max(maxLongitude, longitude);
    }
  }
  const lat = (minLatitude + maxLatitude) / 2;
  const lng = (minLongitude + maxLongitude) / 2;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('Die Reviergrenze enthaelt keine gueltigen Koordinaten.');
  }
  const convertRing = ring => ring.map(([longitude, latitude]) => ({ latitude, longitude }));
  const typesById = new Map(markerTypes.map(type => [type.id, type]));
  return {
    lat,
    lng,
    title: name,
    huntingGround: {
      borders: polygons.map(polygon => convertRing(polygon[0])),
      pacifiedAreas: polygons.flatMap(polygon => polygon.slice(1).map(convertRing)),
      facilities: includeMarkers ? markers.filter(marker => marker.expires_at == null &&
        !typesById.get(marker.type_id)?.temporary).map(marker => ({
        coordinate: { latitude: marker.latitude, longitude: marker.longitude },
        type: typesById.get(marker.type_id)?.label || marker.type_id,
        title: marker.title || '',
        notes: marker.notes || ''
      })) : []
    }
  };
}

function normalizeType(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('de-DE');
}

function normalizeName(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('de-DE');
}

export function matchingEditableProfiles(profiles, name, userId) {
  const normalizedName = normalizeName(name);
  return profiles.filter(profile => normalizeName(profile.district_name) === normalizedName &&
    (profile.owner_id === userId || profile.member_role === 'editor'));
}

function facilityKey(facility) {
  return [
    facility.typeId || facility.type_id,
    normalizeName(facility.title),
    Math.round(Number(facility.latitude) * 1e6),
    Math.round(Number(facility.longitude) * 1e6)
  ].join('|');
}

export function findJwdFacilityAdditions(incoming, existing) {
  const existingKeys = new Set(existing.map(facilityKey));
  const additions = [];
  let duplicateCount = 0;
  for (const facility of incoming) {
    const key = facilityKey(facility);
    if (existingKeys.has(key)) {
      duplicateCount += 1;
    } else {
      existingKeys.add(key);
      additions.push(facility);
    }
  }
  return { additions, duplicateCount };
}

export function mapJwdFacilities(facilities, markerTypes, fallbackType = 'sonstiges') {
  const typesByName = new Map();
  markerTypes.forEach(type => {
    typesByName.set(normalizeType(type.id), type);
    typesByName.set(normalizeType(type.label), type);
  });
  return facilities.map((facility, index) => {
    const originalType = facility.type.trim();
    const knownType = typesByName.get(normalizeType(originalType));
    const notes = facility.notes || '';
    const originalTypeNote = `Importierter Originaltyp: ${originalType || 'nicht angegeben'}`;
    return {
      typeId: knownType?.id || fallbackType,
      title: facility.title || `${knownType?.label || originalType || 'Einrichtung'} ${index + 1}`,
      notes: knownType || notes.startsWith(originalTypeNote) ? notes : [originalTypeNote, notes].filter(Boolean).join('\n'),
      latitude: facility.latitude,
      longitude: facility.longitude
    };
  });
}