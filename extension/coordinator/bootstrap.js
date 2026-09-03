(function initializeCoordinatorBootstrap(root, factory) {
  const api = factory(root.WebMcpAmbientRetrySpool, root.WebMcpErrors);
  root.WebMcpCoordinatorBootstrap = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'undefined' ? this : globalThis, (retrySpool, publicErrors) => {
  'use strict';

  const POLICY_PREFIX = 'ambientPolicy:';
  const LIFECYCLE_PREFIX = 'ambientLifecycle:';
  const RECORD_KEY = 'ambientRetryRecords';
  const KEY_NAME = 'ambientRetryKey';

  const explicitOrigin = (value) => {
    try {
      const origin = new URL(value).origin;
      return origin === value ? origin : null;
    } catch (error) {
      return null;
    }
  };
  const originFromUrl = (value) => {
    try { return new URL(value).origin; } catch (error) { return null; }
  };

  const createCoordinator = ({ chromeApi = chrome, now = () => new Date().toISOString() } = {}) => {
    let queue = Promise.resolve();
    let storage = null;
    const serial = (work) => {
      const result = queue.then(work, work);
      queue = result.catch(() => {});
      return result;
    };
    const get = async (area, key, fallback = null) => {
      const values = await chromeApi.storage[area].get(key);
      return values[key] ?? fallback;
    };
    const set = (area, key, value) => chromeApi.storage[area].set({ [key]: value });
    const policyKey = (origin) => `${POLICY_PREFIX}${origin}`;
    const lifecycleKey = (scopeId) => `${LIFECYCLE_PREFIX}${scopeId}`;

    const currentPolicy = async ({ origin, scope, revision = null }) => {
      const normalized = explicitOrigin(origin);
      const policy = normalized ? await get('local', policyKey(normalized)) : null;
      const valid = policy?.status === 'allowed'
        && policy.origin === normalized
        && Array.isArray(policy.scopes)
        && policy.scopes.includes(scope)
        && typeof policy.checkedAt === 'string'
        && !Number.isNaN(Date.parse(policy.checkedAt))
        && policy.revision !== undefined
        && (!policy.expiresAt || Date.parse(policy.expiresAt) > Date.now())
        && (revision === null || policy.revision === revision);
      return valid ? policy : { origin: normalized, revision: policy?.revision ?? null, scopes: [], status: 'denied' };
    };

    const savePolicy = (incoming, activeOrigin = null) => serial(async () => {
      const origin = originFromUrl(activeOrigin) || explicitOrigin(incoming?.origin);
      if (!origin) throw new Error('An explicit origin is required');
      const existing = await get('local', policyKey(origin));
      const policy = {
        checkedAt: now(),
        decisionId: incoming.decisionId || `policy_${Date.now()}`,
        expiresAt: incoming.expiresAt || null,
        origin,
        revision: (Number.isInteger(existing?.revision) ? existing.revision : 0) + 1,
        scopes: Array.isArray(incoming.scopes) ? incoming.scopes : [incoming.scope || 'ambient_learn'],
        source: incoming.source || 'local_policy_review',
        status: incoming.enabled === false ? 'revoked' : (incoming.decision || incoming.status || 'allowed'),
      };
      await set('local', policyKey(origin), policy);
      return policy;
    });

    const lifecycle = (scopeId, mutate) => serial(async () => {
      const key = lifecycleKey(scopeId);
      const state = await get('session', key, { nextLayerSequence: 0, pending: {} });
      const result = mutate(state);
      await set('session', key, state);
      return result;
    });

    const ownedSpool = async () => {
      if (!storage) storage = await retrySpool.createChromeEncryptedStorage({ chromeApi, keyName: KEY_NAME, recordKey: RECORD_KEY });
      return retrySpool.createRetrySpool({ storage });
    };
    const spool = (operation, payload = {}) => serial(async () => {
      const instance = await ownedSpool();
      switch (operation) {
        case 'enqueue': return instance.enqueue(payload.completedLayer);
        case 'next': return instance.next();
        case 'markAttempt': return instance.markAttempt(payload.id);
        case 'handleReceipt': return instance.handleReceipt(payload.id, payload.receipt);
        case 'list': return instance.list();
        case 'remove': return instance.remove(payload.id);
        default: throw new Error('Unknown ambient spool operation');
      }
    });
    const retryMetadata = async () => {
      const records = await spool('list');
      const oldest = [...records].sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0];
      return { count: records.length, expiresAt: oldest ? new Date(oldest.expiresAt).toISOString() : null, oldestAt: oldest ? new Date(oldest.enqueuedAt).toISOString() : null };
    };

    const handleMessage = async (message, sender = {}) => {
      switch (message?.type) {
        case 'AMBIENT_POLICY_CURRENT': return { ok: true, policy: await currentPolicy(message) };
        case 'AMBIENT_NEXT_LAYER_SEQUENCE': return { ok: true, sequence: await lifecycle(message.scopeId, (state) => { state.nextLayerSequence += 1; return state.nextLayerSequence; }) };
        case 'AMBIENT_PUT_PENDING': return { ok: true, pending: await lifecycle(message.scopeId, (state) => { const key = String(sender.tab?.id ?? message.documentId); state.pending[key] = message.pending; return state.pending[key]; }) };
        case 'AMBIENT_CONSUME_PENDING': return { ok: true, pending: await lifecycle(message.scopeId, (state) => { const key = String(sender.tab?.id ?? message.documentId); const pending = state.pending[key] || null; delete state.pending[key]; return pending; }) };
        case 'AMBIENT_SPOOL_OPERATION': return { ok: true, result: await spool(message.operation, message.payload) };
        case 'GET_POLICY_REVIEW_STATE': {
          const tabs = sender.tab ? [sender.tab] : await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
          const origin = originFromUrl(tabs[0]?.url) || 'http://127.0.0.1:4317';
          const policy = await get('local', policyKey(origin));
          return { ok: true, state: { context: { origin, policyRevision: policy?.revision ?? null }, policy, retrySpool: await retryMetadata() } };
        }
        case 'SET_OWNED_DEMO_OVERRIDE':
        case 'SUBMIT_POLICY_DECISION': {
          const tabs = sender.tab ? [sender.tab] : await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
          return { ok: true, policy: await savePolicy(message.override || message.decision, tabs[0]?.url) };
        }
        case 'REQUEST_RETRY_SPOOL_DELETION': await serial(() => chromeApi.storage.local.remove([RECORD_KEY])); return { ok: true };
        default: return { ok: false, error: 'Unknown extension message' };
      }
    };
    return Object.freeze({ handleMessage, retryMetadata });
  };

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    const coordinator = createCoordinator();
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      coordinator.handleMessage(message, sender).then(sendResponse).catch((error) => sendResponse(publicErrors?.legacyResponseFor?.(error) || { ok: false, error: error.message }));
      return true;
    });
  };
  return Object.freeze({ createCoordinator, start });
}));
