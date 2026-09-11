const databaseName = 'hikmah-workspace';
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  if (!database)
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('state'))
          request.result.createObjectStore('state');
        if (!request.result.objectStoreNames.contains('media'))
          request.result.createObjectStore('media');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
    });
  return database;
}
export async function readWorkspaceSession(): Promise<string | null> {
  try {
    if (localStorage.getItem('hikmah-session-store') === 'legacy')
      return localStorage.getItem('hikmah-playground-v1');
  } catch {
    /* IndexedDB can still be available when localStorage is disabled. */
  }
  try {
    const db = await open();
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('state').objectStore('state').get('session');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (typeof value === 'string') return value;
  } catch {
    /* Older/private browsers can retain the legacy local-storage session. */
  }
  return localStorage.getItem('hikmah-playground-v1');
}
export async function saveWorkspaceSession(text: string): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put(text, 'session');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    try {
      localStorage.removeItem('hikmah-session-store');
    } catch {
      /* The IndexedDB transaction succeeded. */
    }
  } catch {
    localStorage.setItem('hikmah-playground-v1', text);
    localStorage.setItem('hikmah-session-store', 'legacy');
  }
}

export async function saveMediaAsset(id: string, blob: Blob): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('media', 'readwrite');
    tx.objectStore('media').put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function readMediaAsset(id: string): Promise<Blob | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction('media').objectStore('media').get(id);
    request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : undefined);
    request.onerror = () => reject(request.error);
  });
}
