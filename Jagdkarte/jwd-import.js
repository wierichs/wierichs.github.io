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

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const start = ring[previous];
    const end = ring[index];
    const crosses = (start[1] > point[1]) !== (end[1] > point[1]) &&
      point[0] < (end[0] - start[0]) * (point[1] - start[1]) / (end[1] - start[1]) + start[0];
    if (crosses) inside = !inside;
  }
  return inside;
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
    const polygonIndex = polygons.findIndex(polygon => ring.slice(0, -1).every(point => pointInRing(point, polygon[0])));
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
      title: typeof facility.title === 'string' ? facility.title.trim() : ''
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

function normalizeType(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('de-DE');
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
    return {
      typeId: knownType?.id || fallbackType,
      title: facility.title || `${knownType?.label || originalType || 'Einrichtung'} ${index + 1}`,
      notes: knownType ? '' : `Importierter Originaltyp: ${originalType || 'nicht angegeben'}`,
      latitude: facility.latitude,
      longitude: facility.longitude
    };
  });
}