/**
 * Storage interface (§27).
 *
 * V1 uses IndexedDB in the browser and an in-memory/JSON-file driver in Node.
 * The core only ever talks to this interface, so V2 can move to Cloudflare
 * KV/D1/DO without changing business logic (§28).
 */

export class MemoryStorage {
  constructor(seed = {}) {
    this.data = new Map(Object.entries(structuredCloneSafe(seed)));
  }

  async get(collection, id) {
    const bucket = this.data.get(collection) ?? new Map();
    return bucket.get(id) ?? null;
  }

  async list(collection) {
    const bucket = this.data.get(collection) ?? new Map();
    return [...bucket.values()];
  }

  async put(collection, record) {
    if (!this.data.has(collection)) this.data.set(collection, new Map());
    this.data.get(collection).set(record.id, structuredCloneSafe(record));
    return record;
  }

  async remove(collection, id) {
    const bucket = this.data.get(collection);
    if (bucket) bucket.delete(id);
  }

  async clear(collection) {
    if (collection) this.data.delete(collection);
    else this.data.clear();
  }

  async exportAll() {
    const out = {};
    for (const [collection, bucket] of this.data.entries()) {
      out[collection] = [...bucket.values()];
    }
    return out;
  }

  async importAll(payload, { merge = true } = {}) {
    for (const [collection, records] of Object.entries(payload ?? {})) {
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (!merge || !record?.id) await this.put(collection, record);
        else {
          const existing = await this.get(collection, record.id);
          await this.put(collection, { ...existing, ...record });
        }
      }
    }
  }
}

function structuredCloneSafe(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * IndexedDB driver for the browser (§21, §27).
 * Falls back to MemoryStorage when IndexedDB is unavailable (Node, tests).
 */
export class IndexedDbStorage {
  constructor(dbName = 'smart-api-registry', version = 1) {
    this.dbName = dbName;
    this.version = version;
    this._db = null;
    this._fallback = new MemoryStorage();
  }

  async _open() {
    if (this._db) return this._db;
    const hasIdb = typeof indexedDB !== 'undefined';
    if (!hasIdb) throw new Error('IndexedDB unavailable');
    this._db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of ['providers', 'models', 'keys', 'mappings', 'unresolved', 'events', 'meta']) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this._db;
  }

  async _tx(collection, mode = 'readonly') {
    const db = await this._open();
    return db.transaction(collection, mode).objectStore(collection);
  }

  async get(collection, id) {
    try {
      const store = await this._tx(collection);
      return await new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return this._fallback.get(collection, id);
    }
  }

  async list(collection) {
    try {
      const store = await this._tx(collection);
      return await new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result ?? []);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return this._fallback.list(collection);
    }
  }

  async put(collection, record) {
    try {
      const store = await this._tx(collection, 'readwrite');
      await new Promise((resolve, reject) => {
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      return record;
    } catch {
      return this._fallback.put(collection, record);
    }
  }

  async remove(collection, id) {
    try {
      const store = await this._tx(collection, 'readwrite');
      await new Promise((resolve, reject) => {
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      return this._fallback.remove(collection, id);
    }
  }

  async clear(collection) {
    try {
      const store = await this._tx(collection, 'readwrite');
      await new Promise((resolve, reject) => {
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      return this._fallback.clear(collection);
    }
  }

  async exportAll() {
    const out = {};
    for (const collection of ['providers', 'models', 'keys', 'mappings', 'unresolved', 'meta']) {
      out[collection] = await this.list(collection);
    }
    return out;
  }

  async importAll(payload, { merge = true } = {}) {
    for (const [collection, records] of Object.entries(payload ?? {})) {
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (!record?.id) continue;
        const existing = merge ? await this.get(collection, record.id) : null;
        await this.put(collection, existing ? { ...existing, ...record } : record);
      }
    }
  }
}

/** Pick the best available storage for the current runtime. */
export function createStorage(driver) {
  if (driver instanceof MemoryStorage || driver instanceof IndexedDbStorage) return driver;
  if (typeof indexedDB !== 'undefined') return new IndexedDbStorage();
  return new MemoryStorage();
}
