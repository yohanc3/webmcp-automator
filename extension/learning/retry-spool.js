(function initializeAmbientRetrySpool(root, factory) {
  const retrySpool = factory();
  root.WebMcpAmbientRetrySpool = retrySpool;
  if (typeof module === 'object' && module.exports) {
    module.exports = retrySpool;
  }
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const HARD_TTL_MS = 24 * 60 * 60 * 1000;
  const DELETE_OUTCOMES = new Set(['applied', 'duplicate', 'no_change', 'rejected']);
  const FORBIDDEN_KEYS = new Set([
    'cookies',
    'headers',
    'history',
    'html',
    'rawDom',
    'rawEvent',
    'screenshot',
    'storage',
  ]);

  const clone = (value) => JSON.parse(JSON.stringify(value));

  const assertSafeShape = (value) => {
    const visit = (current) => {
      if (Array.isArray(current)) {
        current.forEach(visit);
        return;
      }
      if (!current || typeof current !== 'object') return;
      Object.entries(current).forEach(([key, child]) => {
        if (FORBIDDEN_KEYS.has(key)) {
          throw new Error(`Retry source contains forbidden field: ${key}`);
        }
        visit(child);
      });
    };
    visit(value);
  };

  const assertCompletedLayer = (completedLayer) => {
    if (!completedLayer || typeof completedLayer !== 'object') {
      throw new TypeError('A CompletedLayer object is required');
    }
    const keys = Object.keys(completedLayer).sort();
    const expected = ['layer', 'observation', 'policy', 'privacy', 'siteScope'];
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      throw new Error('Retry source must contain only CompletedLayer fields');
    }
    if (completedLayer.layer?.semanticXmlVersion !== 'semantic-ui/2') {
      throw new Error('Retry source must carry semantic-ui/2 XML');
    }
    if (!completedLayer.layer.completedAt || !completedLayer.layer.completionReason) {
      throw new Error('Retry source must carry a completed semantic layer boundary');
    }
    if (completedLayer.privacy?.rawPersisted !== false) {
      throw new Error('Retry source must attest that raw material was not persisted');
    }
    assertSafeShape(completedLayer);
  };

  const createMemoryStorage = () => {
    const records = new Map();
    return Object.freeze({
      encrypted: true,
      async delete(id) {
        records.delete(id);
      },
      async get(id) {
        return records.has(id) ? clone(records.get(id)) : null;
      },
      async list() {
        return [...records.values()].map(clone);
      },
      async put(record) {
        records.set(record.id, clone(record));
      },
    });
  };

  // The key is a non-extractable CryptoKey held only in extension session storage;
  // local storage contains ciphertext, IV, and record identifier, never layer text.
  const createChromeEncryptedStorage = async ({ chromeApi = globalThis.chrome, keyName = 'ambientRetryKey', recordKey = 'ambientRetryRecords' } = {}) => {
    if (!chromeApi?.storage?.local || !chromeApi?.storage?.session || !globalThis.crypto?.subtle) {
      throw new Error('Chrome local/session storage and Web Crypto are required for the ambient retry spool');
    }
    const session = await chromeApi.storage.session.get(keyName);
    let key = session[keyName];
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await chromeApi.storage.session.set({ [keyName]: key });
    }
    const encode = (value) => btoa(String.fromCharCode(...new Uint8Array(value)));
    const decode = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const read = async () => (await chromeApi.storage.local.get(recordKey))[recordKey] || {};
    const write = (records) => chromeApi.storage.local.set({ [recordKey]: records });
    const decrypt = async (ciphertext) => {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(ciphertext.iv) }, key, decode(ciphertext.data));
      return JSON.parse(new TextDecoder().decode(plain));
    };
    return Object.freeze({
      encrypted: true,
      async delete(id) { const records = await read(); delete records[id]; await write(records); },
      async get(id) { const value = (await read())[id]; return value ? decrypt(value) : null; },
      async list() { return Promise.all(Object.values(await read()).map(decrypt)); },
      async put(record) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plain = new TextEncoder().encode(JSON.stringify(record));
        const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
        const records = await read(); records[record.id] = { iv: encode(iv), data: encode(data) }; await write(records);
      },
    });
  };

  const createRetrySpool = ({
    storage,
    now = () => Date.now(),
    ttlMs = HARD_TTL_MS,
  } = {}) => {
    if (!storage || storage.encrypted !== true) {
      throw new Error('Ambient retry storage must declare encrypted: true');
    }
    ['delete', 'get', 'list', 'put'].forEach((method) => {
      if (typeof storage[method] !== 'function') {
        throw new TypeError(`Ambient retry storage requires ${method}()`);
      }
    });
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > HARD_TTL_MS) {
      throw new RangeError('Retry TTL must be positive and no longer than 24 hours');
    }

    let operations = Promise.resolve();
    const serialize = (operation) => {
      const result = operations.then(operation, operation);
      operations = result.catch(() => {});
      return result;
    };

    const purgeExpiredUnsafe = async () => {
      const timestamp = now();
      const records = await storage.list();
      const expired = records.filter(({ expiresAt }) => expiresAt <= timestamp);
      await Promise.all(expired.map(({ id }) => storage.delete(id)));
      return expired.map(({ id }) => id);
    };

    const enqueue = (completedLayer) => serialize(async () => {
      assertCompletedLayer(completedLayer);
      await purgeExpiredUnsafe();
      const id = completedLayer.layer.layerId;
      const existing = await storage.get(id);
      if (existing) {
        if (JSON.stringify(existing.completedLayer) !== JSON.stringify(completedLayer)) {
          throw new Error(`Layer ID reused with different source: ${id}`);
        }
        return existing;
      }
      const enqueuedAt = now();
      const record = {
        id,
        state: 'queued',
        attempts: 0,
        enqueuedAt,
        expiresAt: enqueuedAt + ttlMs,
        completedLayer: clone(completedLayer),
        conflict: null,
      };
      await storage.put(record);
      return clone(record);
    });

    const next = () => serialize(async () => {
      await purgeExpiredUnsafe();
      const records = await storage.list();
      const record = records
        .filter(({ state }) => state === 'queued')
        .sort((left, right) => (
          left.enqueuedAt - right.enqueuedAt || left.id.localeCompare(right.id)
        ))[0];
      return record ? clone(record) : null;
    });

    const markAttempt = (id) => serialize(async () => {
      await purgeExpiredUnsafe();
      const record = await storage.get(id);
      if (!record) return null;
      const updated = { ...record, attempts: record.attempts + 1 };
      await storage.put(updated);
      return clone(updated);
    });

    const handleReceipt = (id, receipt) => serialize(async () => {
      await purgeExpiredUnsafe();
      const record = await storage.get(id);
      if (!record) return { disposition: 'missing', id };
      const outcome = receipt?.outcome || receipt?.status;
      if (DELETE_OUTCOMES.has(outcome)) {
        await storage.delete(id);
        return { disposition: 'deleted', id, outcome };
      }
      if (outcome === 'conflict') {
        const updated = {
          ...record,
          state: 'reparse',
          conflict: {
            receivedAt: now(),
            receiptId: receipt.receiptId || null,
          },
        };
        await storage.put(updated);
        return { disposition: 'retained_for_reparse', id, outcome };
      }
      return { disposition: 'retained_for_retry', id, outcome: outcome || 'transport_error' };
    });

    const requeueAfterConflict = (id) => serialize(async () => {
      await purgeExpiredUnsafe();
      const record = await storage.get(id);
      if (!record || record.state !== 'reparse') return null;
      const updated = { ...record, state: 'queued', conflict: null };
      await storage.put(updated);
      return clone(updated);
    });

    const list = () => serialize(async () => {
      await purgeExpiredUnsafe();
      return (await storage.list()).sort((left, right) => (
        left.enqueuedAt - right.enqueuedAt || left.id.localeCompare(right.id)
      )).map(clone);
    });

    const remove = (id) => serialize(async () => {
      await storage.delete(id);
    });

    return Object.freeze({
      enqueue,
      handleReceipt,
      list,
      markAttempt,
      next,
      purgeExpired: () => serialize(purgeExpiredUnsafe),
      remove,
      requeueAfterConflict,
    });
  };

  return Object.freeze({
    HARD_TTL_MS,
    createChromeEncryptedStorage,
    createMemoryStorage,
    createRetrySpool,
  });
}));
