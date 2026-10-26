const databaseName = 'jagdkarte-offline-map-v1';
const storeName = 'maps';
let databasePromise;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Offline-Kartenspeicher konnte nicht geoeffnet werden.'));
      request.onblocked = () => reject(new Error('Offline-Kartenspeicher ist durch einen anderen App-Tab blockiert.'));
    }).catch(error => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Offline-Kartenspeicher ist nicht verfuegbar.'));
  });
}

export async function loadOfflineMap() {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  const record = await requestResult(transaction.objectStore(storeName).get('basemap'));
  return record || null;
}

export async function saveOfflineMap(file) {
  if (!(file instanceof Blob) || !file.size) throw new Error('Bitte eine nicht-leere PMTiles-Datei auswaehlen.');
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  const completion = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Offline-Karte konnte nicht gespeichert werden.'));
    transaction.onabort = () => reject(transaction.error || new Error('Speichern der Offline-Karte wurde abgebrochen.'));
  });
  transaction.objectStore(storeName).put({ id: 'basemap', name: file.name || 'offline.pmtiles', file });
  await completion;
  return { name: file.name || 'offline.pmtiles', size: file.size };
}

export async function removeOfflineMap() {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  const completion = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Offline-Karte konnte nicht entfernt werden.'));
    transaction.onabort = () => reject(transaction.error || new Error('Entfernen der Offline-Karte wurde abgebrochen.'));
  });
  transaction.objectStore(storeName).delete('basemap');
  await completion;
}