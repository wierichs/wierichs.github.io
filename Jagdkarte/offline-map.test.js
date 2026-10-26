import { loadOfflineMap, removeOfflineMap, saveOfflineMap } from './offline-map-storage.js';

export async function runOfflineMapTests() {
  const preferenceKey = 'jagdkarte-offline-map-enabled-v1';
  const previous = await loadOfflineMap();
  const previousPreference = localStorage.getItem(preferenceKey);
  try {
    const file = new File(['local pmtiles test archive'], 'testregion.pmtiles', { type: 'application/octet-stream' });
    await saveOfflineMap(file);
    const saved = await loadOfflineMap();
    if (saved?.name !== file.name || saved.file.size !== file.size || await saved.file.text() !== await file.text()) {
      throw new Error('Offline PMTiles package did not survive IndexedDB storage.');
    }
    await removeOfflineMap();
    if (await loadOfflineMap()) throw new Error('Offline PMTiles package was not removed.');
    return ['Offline PMTiles package persists locally and can be removed'];
  } finally {
    await removeOfflineMap();
    if (previous) await saveOfflineMap(previous.file);
    if (previousPreference === null) localStorage.removeItem(preferenceKey);
    else localStorage.setItem(preferenceKey, previousPreference);
  }
}