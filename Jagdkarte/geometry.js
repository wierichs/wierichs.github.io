function pointOnSegment(point, start, end) {
  const cross = (point.lng - start[0]) * (end[1] - start[1]) - (point.lat - start[1]) * (end[0] - start[0]);
  if (Math.abs(cross) > 1e-10) return false;
  return point.lng >= Math.min(start[0], end[0]) - 1e-10 && point.lng <= Math.max(start[0], end[0]) + 1e-10 &&
    point.lat >= Math.min(start[1], end[1]) - 1e-10 && point.lat <= Math.max(start[1], end[1]) + 1e-10;
}

export function pointInRing(point, ring, includeBoundary = true) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const start = ring[previous];
    const end = ring[index];
    if (pointOnSegment(point, start, end)) return includeBoundary;
    const crosses = (start[1] > point.lat) !== (end[1] > point.lat) &&
      point.lng < (end[0] - start[0]) * (point.lat - start[1]) / (end[1] - start[1]) + start[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointInFeature(point, feature) {
  const geometry = feature?.geometry;
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(polygon => pointInRing(point, polygon[0]) &&
    !polygon.slice(1).some(ring => pointInRing(point, ring, false)));
}