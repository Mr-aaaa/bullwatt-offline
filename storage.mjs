export function openStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('bullwatt-offline', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'id' });
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('请关闭其他 BullWatt 页面后重试'));
    request.onsuccess = () => resolve(request.result);
  });
}

export async function dbRequest(database, mode, action) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('sessions', mode);
    const request = action(transaction.objectStore('sessions'));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onabort = () => reject(transaction.error ?? new Error('数据事务已中止'));
  });
}

export async function restore(database, rides) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('sessions', 'readwrite');
    const store = transaction.objectStore('sessions');
    const keys = store.getAllKeys();
    let added = 0;
    keys.onsuccess = () => {
      const existing = new Set(keys.result);
      for (const ride of rides) {
        if (existing.has(ride.id)) continue;
        store.add(ride);
        existing.add(ride.id);
        added++;
      }
    };
    transaction.oncomplete = () => resolve(added);
    transaction.onabort = () => reject(transaction.error ?? new Error('导入已中止'));
  });
}
