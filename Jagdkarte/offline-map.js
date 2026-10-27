import { loadOfflineMap, removeOfflineMap, saveOfflineMap } from './offline-map-storage.js';

const preferenceKey = 'jagdkarte-offline-map-enabled-v1';
const archiveFilename = 'jagdkarte-offline-basemap.pmtiles';
const basemapSourceId = 'jagdkarte-offline';
const attribution = '<a href="https://protomaps.com/" target="_blank" rel="noopener">Protomaps</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap-Mitwirkende</a>';
let protocol;

function savedPreference() {
  try { return localStorage.getItem(preferenceKey) !== 'false'; }
  catch { return true; }
}

function storePreference(enabled) {
  try { localStorage.setItem(preferenceKey, String(enabled)); }
  catch {}
}

function formatSize(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function prepareArchive(file) {
  if (!(file instanceof Blob) || !file.size || !file.name?.toLowerCase().endsWith('.pmtiles')) {
    throw new Error('Bitte eine nicht-leere PMTiles-Datei auswaehlen.');
  }
  const archiveFile = new File([file], archiveFilename, { type: 'application/octet-stream' });
  const archive = new window.pmtiles.PMTiles(new window.pmtiles.FileSource(archiveFile));
  const header = await archive.getHeader();
  if (header.tileType !== window.pmtiles.TileType.Mvt) {
    throw new Error('Das Paket enthaelt keine Vektorkarte im PMTiles-Format.');
  }
  const metadata = await archive.getMetadata();
  const availableLayers = new Set((metadata?.vector_layers || []).map(layer => layer.id));
  const isProtomaps = ['earth', 'roads', 'water'].every(layer => availableLayers.has(layer));
  const isShortbread = ['land', 'streets', 'water_polygons'].every(layer => availableLayers.has(layer));
  if (!isProtomaps && !isShortbread) {
    throw new Error('Das Paket braucht Protomaps- oder Shortbread-Kartenebenen.');
  }
  return { archive, archiveFile, header, metadata, availableLayers,
    styleType: isShortbread ? 'shortbread' : 'protomaps' };
}

function createStyle(prepared) {
  const assetRoot = new URL('./vendor/protomaps/', location.href).href;
  const source = {
    type: 'vector',
    url: `pmtiles://${prepared.archiveFile.name}`,
    attribution
  };
  if (prepared.styleType === 'shortbread') {
    const layers = [{ id: 'background', type: 'background', paint: { 'background-color': '#f4f3ee' } }];
    const addLayer = (id, type, sourceLayer, paint, extra = {}) => {
      if (prepared.availableLayers.has(sourceLayer)) layers.push({
        id, type, source: basemapSourceId, 'source-layer': sourceLayer, paint, ...extra
      });
    };
    addLayer('shortbread-land', 'fill', 'land', { 'fill-color': '#e9e9df' });
    addLayer('shortbread-water', 'fill', 'water_polygons', { 'fill-color': '#b9dbe7' });
    addLayer('shortbread-sites', 'fill', 'sites', { 'fill-color': '#dce7d6', 'fill-opacity': 0.8 });
    addLayer('shortbread-boundaries', 'line', 'boundaries', {
      'line-color': '#aa8c84', 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 12, 1]
    });
    addLayer('shortbread-water-lines', 'line', 'water_lines', {
      'line-color': '#8ec5d8', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 14, 2]
    });
    addLayer('shortbread-street-polygons', 'fill', 'street_polygons', { 'fill-color': '#c9c4ba' });
    addLayer('shortbread-streets', 'line', 'streets', {
      'line-color': '#b8b2a7', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.35, 14, 2]
    });
    addLayer('shortbread-buildings', 'fill', 'buildings', { 'fill-color': '#d4d0c8' }, { minzoom: 13 });
    const labelLayout = {
      'text-field': ['coalesce', ['get', 'name'], ['get', 'ref']],
      'text-font': ['Noto Sans Medium'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 14, 14],
      'text-max-width': 8
    };
    addLayer('shortbread-place-labels', 'symbol', 'place_labels', {
      'text-color': '#404942', 'text-halo-color': '#f5f4ef', 'text-halo-width': 1.2
    }, { layout: { ...labelLayout, 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 14, 15] } });
    addLayer('shortbread-street-labels', 'symbol', 'street_labels', {
      'text-color': '#5e5b54', 'text-halo-color': '#f7f6f2', 'text-halo-width': 1
    }, { layout: labelLayout, minzoom: 11 });
    addLayer('shortbread-pois', 'circle', 'pois', {
      'circle-radius': 2.5, 'circle-color': '#ad7550', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1
    }, { minzoom: 13 });
    return {
      version: 8,
      glyphs: `${assetRoot}fonts/{fontstack}/{range}.pbf`,
      sprite: `${assetRoot}sprites/light`,
      sources: { [basemapSourceId]: source },
      layers
    };
  }
  const layers = window.basemaps.layers(basemapSourceId, window.basemaps.namedFlavor('light'), { lang: 'de' })
    .filter(layer => !layer['source-layer'] || prepared.availableLayers.has(layer['source-layer']));
  return {
    version: 8,
    glyphs: `${assetRoot}fonts/{fontstack}/{range}.pbf`,
    sprite: `${assetRoot}sprites/light`,
    sources: {
      [basemapSourceId]: {
        ...source
      }
    },
    layers
  };
}

export function createOfflineBasemap(leafletMap, onActiveChange = () => {}) {
  const host = document.getElementById('offline-basemap');
  const dialog = document.getElementById('offline-map-dialog');
  const fileInput = document.getElementById('offline-map-file');
  const current = document.getElementById('offline-map-current');
  const status = document.getElementById('offline-map-status');
  const enabledInput = document.getElementById('offline-map-enabled');
  const removeButton = document.getElementById('remove-offline-map');
  const extractButton = document.getElementById('extract-offline-map');
  const extractName = document.getElementById('offline-map-extract-name');
  const extractEmail = document.getElementById('offline-map-extract-email');
  const extractNote = document.getElementById('offline-map-extract-note');
  let record = null;
  let maplibreMap = null;
  let archive = null;
  let active = false;
  let visible = false;
  let revision = 0;
  let preference = savedPreference();

  function setStatus(message) {
    status.textContent = message;
  }

  function renderStatus() {
    current.textContent = record
      ? `${record.name} (${formatSize(record.file.size)})`
      : 'Keine Offline-Karte installiert.';
    enabledInput.disabled = !record;
    enabledInput.checked = active;
    removeButton.disabled = !record;
    document.getElementById('offline-map-button').setAttribute('aria-pressed', String(active));
  }

  function syncCamera() {
    if (!maplibreMap) return;
    const center = leafletMap.getCenter();
    maplibreMap.jumpTo({ center: [center.lng, center.lat], zoom: leafletMap.getZoom() - 1 });
  }

  function setVisible(nextVisible) {
    visible = Boolean(nextVisible && active);
    host.hidden = !visible;
    host.setAttribute('aria-hidden', String(!visible));
    if (visible && maplibreMap) {
      maplibreMap.resize();
      syncCamera();
    }
  }

  function disposeRenderer() {
    if (maplibreMap) {
      maplibreMap.remove();
      maplibreMap = null;
    }
    if (archive && protocol) protocol.tiles.delete(archive.source.getKey());
    archive = null;
  }

  async function mount(prepared) {
    if (!window.maplibregl || !window.pmtiles || !window.basemaps) {
      throw new Error('Der Offline-Kartenrenderer ist nicht verfuegbar. App aktualisieren.');
    }
    if (!protocol) {
      protocol = new window.pmtiles.Protocol();
      window.maplibregl.addProtocol('pmtiles', protocol.tile);
    }
    protocol.add(prepared.archive);
    archive = prepared.archive;
    host.hidden = false;
    maplibreMap = new window.maplibregl.Map({
      container: host,
      style: createStyle(prepared),
      center: [leafletMap.getCenter().lng, leafletMap.getCenter().lat],
      zoom: leafletMap.getZoom() - 1,
      interactive: false,
      attributionControl: false,
      maplibreLogo: false,
      maxPitch: 0,
      fadeDuration: 0,
      renderWorldCopies: false
    });
    maplibreMap.on('error', event => {
      if (active && event.error) setStatus(`Offline-Karte: ${event.error.message}`);
    });
    maplibreMap.once('load', () => {
      syncCamera();
      setStatus('Offline-Karte ist bereit.');
    });
    leafletMap.on('move zoom resize', syncCamera);
  }

  async function setActive(nextActive, prepared = null) {
    const nextRevision = ++revision;
    if (!nextActive) {
      active = false;
      preference = false;
      storePreference(false);
      setVisible(false);
      renderStatus();
      onActiveChange(false);
      return;
    }
    if (!record) {
      enabledInput.checked = false;
      setStatus('Zuerst ein PMTiles-Kartenpaket importieren.');
      return;
    }
    try {
      const currentArchive = prepared || await prepareArchive(record.file);
      if (!maplibreMap) await mount(currentArchive);
      if (nextRevision !== revision) return;
      active = true;
      preference = true;
      storePreference(true);
      setVisible(true);
      renderStatus();
      onActiveChange(true);
      if (currentArchive) {
        const { minLon, minLat, maxLon, maxLat } = currentArchive.header;
        const center = leafletMap.getCenter();
        if (center.lng < minLon || center.lng > maxLon || center.lat < minLat || center.lat > maxLat) {
          leafletMap.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [24, 24], maxZoom: 12 });
        }
      }
    } catch (error) {
      if (nextRevision !== revision) return;
      active = false;
      preference = false;
      storePreference(false);
      setVisible(false);
      renderStatus();
      setStatus(error.message || 'Offline-Karte konnte nicht geladen werden.');
      onActiveChange(false);
      return false;
    }
  }

  async function installFile(file) {
    setStatus('Kartenpaket wird geprueft ...');
    try {
      const prepared = await prepareArchive(file);
      await saveOfflineMap(file);
      revision += 1;
      disposeRenderer();
      record = { name: file.name, file };
      preference = true;
      storePreference(true);
      renderStatus();
      await setActive(true, prepared);
      return active && record?.file === file;
    } catch (error) {
      setStatus(error.message || 'Kartenpaket konnte nicht importiert werden.');
    } finally {
      fileInput.value = '';
    }
  }

  async function extractCurrentView() {
    extractButton.disabled = true;
    try {
      const bounds = leafletMap.getBounds();
      const city = extractName.value.trim();
      const email = extractEmail.value.trim();
      if (!city || city.length > 60) throw new Error('Bitte einen Namen mit 1 bis 60 Zeichen eingeben.');
      if (email && !extractEmail.validity.valid) throw new Error('Bitte eine gültige E-Mail-Adresse eingeben oder das Feld leer lassen.');

      const fields = {
        sw_lng: bounds.getWest().toFixed(6),
        sw_lat: bounds.getSouth().toFixed(6),
        ne_lng: bounds.getEast().toFixed(6),
        ne_lat: bounds.getNorth().toFixed(6),
        format: 'pmtiles-shortbread',
        email: email || 'nobody',
        as: '1',
        city
      };
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = 'https://extract.bbbike.org/';
      form.target = '_blank';
      form.rel = 'noopener noreferrer';
      form.hidden = true;
      for (const [name, value] of Object.entries(fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.append(input);
      }
      document.body.append(form);
      form.submit();
      form.remove();
      extractNote.textContent = email
        ? 'BBBike sendet den Downloadlink nach der Verarbeitung an die angegebene Adresse.'
        : 'Ohne E-Mail erscheint der Download nach der Verarbeitung auf der BBBike-Statusseite.';
      setStatus(email
        ? 'BBBike-Auftrag gesendet. Der Downloadlink wird per E-Mail zugeschickt.'
        : 'BBBike-Auftrag gesendet. Öffne nach der Verarbeitung die Statusseite und importiere die PMTiles-Datei hier.');
    } catch (error) {
      setStatus(error.message || 'Offline-Kartenausschnitt konnte nicht erstellt werden.');
    } finally {
      extractButton.disabled = false;
    }
  }

  document.getElementById('offline-map-button').addEventListener('click', () => dialog.showModal());
  document.getElementById('close-offline-map').addEventListener('click', () => dialog.close());
  extractButton.addEventListener('click', () => void extractCurrentView());
  document.getElementById('choose-offline-map').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) void installFile(fileInput.files[0]);
  });
  enabledInput.addEventListener('change', () => { void setActive(enabledInput.checked); });
  removeButton.addEventListener('click', async () => {
    if (!record || !window.confirm('Die Offline-Karte von diesem Geraet entfernen?')) return;
    revision += 1;
    active = false;
    preference = false;
    storePreference(false);
    setVisible(false);
    disposeRenderer();
    try {
      await removeOfflineMap();
      record = null;
      setStatus('Offline-Karte wurde entfernt.');
    } catch (error) {
      setStatus(error.message || 'Offline-Karte konnte nicht entfernt werden.');
    }
    renderStatus();
    onActiveChange(false);
  });
  leafletMap.on('move zoom resize', syncCamera);
  host.hidden = true;
  renderStatus();

  const ready = loadOfflineMap().then(async saved => {
    record = saved;
    renderStatus();
    if (record && preference) await setActive(true);
  }).catch(error => setStatus(error.message || 'Offline-Kartenspeicher ist nicht verfuegbar.'));

  return {
    isActive: () => active,
    setVisible,
    setActive: async nextActive => {
      await ready;
      return setActive(nextActive);
    }
  };
}