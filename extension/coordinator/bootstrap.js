(function initializeCoordinatorBootstrap(root, factory) {
  const api = factory(
    root.WebMcpAmbientRetrySpool,
    root.WebMcpErrors,
    root.WebMcpProtocol || (typeof module === 'object' && module.exports ? require('../shared/protocol.js') : null),
  );
  root.WebMcpCoordinatorBootstrap = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'undefined' ? this : globalThis, (retrySpool, publicErrors, protocol) => {
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

  const createCoordinator = ({
    chromeApi = chrome,
    fetchApi = fetch,
    manifest = globalThis.WebMcpManifest,
    now = () => new Date().toISOString(),
    retrySpoolApi = retrySpool,
  } = {}) => {
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

    const requestBackend = async (path, options = {}) => {
      const response = await fetchApi(`http://127.0.0.1:4317${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Backend request failed with status ${response.status}`);
      return body;
    };
    const deliverAmbientLayer = async (completedLayer) => {
      const response = await fetchApi('http://127.0.0.1:4317/v1/ambient/layers', {
        body: JSON.stringify(completedLayer),
        headers: { 'Content-Type': 'application/json', 'X-WebMCP-Internal': 'ambient-v1' },
        method: 'POST',
      });
      const body = await response.json().catch(() => null);
      if (response.status === 409) return { outcome: 'conflict', receiptId: body?.requestId || null };
      if (!response.ok || !body || typeof body.outcome !== 'string') throw new Error(`Ambient delivery retryable: ${response.status}`);
      if (!['applied', 'duplicate', 'no_change', 'rejected'].includes(body.outcome)) throw new Error('Ambient delivery returned an invalid receipt');
      return { outcome: body.outcome, receiptId: body.requestId || null };
    };
    const tabMessage = (tabId, value) => chromeApi.tabs.sendMessage(tabId, value);
    const getJobs = () => get('session', 'jobs', {});
    const changeJob = (id, mutate) => serial(async () => {
      const jobs = await getJobs();
      if (!jobs[id]) return null;
      mutate(jobs[id]);
      jobs[id].updatedAt = now();
      await set('session', 'jobs', jobs);
      return jobs[id];
    });
    const advanceJob = async (id) => {
      const job = (await getJobs())[id];
      if (!job || ['completed', 'failed'].includes(job.status)) return;
      const step = job.adapter.manifest.tool.steps[job.stepIndex];
      if (!step) {
        await changeJob(id, (current) => { current.status = 'completed'; });
        return;
      }
      const response = await tabMessage(job.tabId, { type: 'EXECUTE_STEP', step, args: job.args, tool: job.adapter.manifest.tool });
      if (!response?.ok) {
        await changeJob(id, (current) => { current.error = response?.error || 'Adapter step failed'; current.status = 'failed'; });
        return;
      }
      await changeJob(id, (current) => { current.stepIndex += 1; current.status = response.navigating ? 'waiting-navigation' : 'running'; });
    };
    const getAdapters = async (origin) => {
      const cache = await get('local', 'adapterCache', {});
      try {
        const body = await requestBackend(`/api/adapters?origin=${encodeURIComponent(origin)}`);
        cache[origin] = { adapters: body.adapters, fetchedAt: now() };
        await set('local', 'adapterCache', cache);
        return { adapters: body.adapters, stale: false };
      } catch (error) {
        if (cache[origin]) return { adapters: cache[origin].adapters, error: error.message, stale: true };
        throw error;
      }
    };
    const startJob = async (adapter, args, sourceUrl, sourceTabId) => {
      const validation = manifest.validateManifest(adapter.manifest);
      if (!validation.valid || !manifest.manifestMatchesLocation(validation.manifest, sourceUrl)) throw new Error('This adapter is not valid for the current page');
      const tab = await chromeApi.tabs.create({ active: false, url: sourceUrl });
      const job = { adapter: { ...adapter, manifest: validation.manifest }, args, createdAt: now(), error: null, id: crypto.randomUUID(), result: null, sourceTabId, sourceUrl, status: 'starting', stepIndex: 0, tabId: tab.id, updatedAt: now() };
      await serial(async () => { const jobs = await getJobs(); jobs[job.id] = job; await set('session', 'jobs', jobs); });
      return job.id;
    };
    const pageReady = async (sender) => {
      const tabId = sender.tab?.id;
      const job = Object.values(await getJobs()).find((candidate) => candidate.tabId === tabId && !['completed', 'failed'].includes(candidate.status));
      if (job) await advanceJob(job.id);
      return { recordingActive: false, recordingId: null };
    };

    const ownedSpool = async () => {
      if (!retrySpoolApi) throw new Error('Ambient retry spool was unavailable during coordinator initialization');
      if (!storage) storage = await retrySpoolApi.createChromeEncryptedStorage({ chromeApi, keyName: KEY_NAME, recordKey: RECORD_KEY });
      return retrySpoolApi.createRetrySpool({ storage });
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
        case 'AMBIENT_CLEAR_PENDING': return { ok: true, cleared: await lifecycle(message.scopeId, (state) => { const key = String(sender.tab?.id ?? message.documentId); if (state.pending[key]?.observationId !== message.observationId) return false; delete state.pending[key]; return true; }) };
        case 'AMBIENT_CONSUME_PENDING': return { ok: true, pending: await lifecycle(message.scopeId, (state) => { const key = String(sender.tab?.id ?? message.documentId); const pending = state.pending[key] || null; delete state.pending[key]; return pending; }) };
        case 'AMBIENT_SPOOL_OPERATION': return { ok: true, result: await spool(message.operation, message.payload) };
        case 'AMBIENT_DELIVER_LAYER': return { ok: true, receipt: await deliverAmbientLayer(message.completedLayer) };
        case 'GET_POLICY_REVIEW_STATE': {
          const tabs = sender.tab ? [sender.tab] : await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
          const origin = originFromUrl(tabs[0]?.url);
          if (!origin) return { ok: true, state: { context: { origin: null, requestedScope: 'ambient_learn' }, policy: { status: 'denied', scopes: [] }, retrySpool: { count: 0 } } };
          const stored = await get('local', policyKey(origin));
          const policy = await currentPolicy({ origin, scope: 'ambient_learn', revision: stored?.revision ?? null });
          return { ok: true, state: { context: { origin, policyRevision: policy?.revision ?? null, requestedScope: 'ambient_learn' }, policy, retrySpool: await retryMetadata() } };
        }
        case 'SET_OWNED_DEMO_OVERRIDE':
        {
          const tabs = sender.tab ? [sender.tab] : await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
          const override = message.override;
          const origin = originFromUrl(tabs[0]?.url);
          if (!override?.enabled || origin !== 'http://127.0.0.1:4317' || override.origin !== origin || override.requestedScope !== 'ambient_learn' || override.reasonCode !== 'OWNED_DEMO_EXPLICIT_OVERRIDE' || Number.isNaN(Date.parse(override.acknowledgedAt || ''))) return { ok: false, error: 'Owned demo override is not valid for this active origin' };
          return { ok: true, policy: await savePolicy({ ...override, decision: 'allowed', scope: 'ambient_learn', source: 'owned_demo_override' }, tabs[0]?.url) };
        }
        case 'SUBMIT_POLICY_DECISION': {
          const tabs = sender.tab ? [sender.tab] : await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
          const decision = message.decision || {};
          if (!['denied', 'revoked'].includes(decision.decision) || decision.scope !== 'ambient_learn') return { ok: false, error: 'Only ambient deny or revoke decisions are supported' };
          return { ok: true, policy: await savePolicy(decision, tabs[0]?.url) };
        }
        case 'REQUEST_RETRY_SPOOL_DELETION': await serial(() => chromeApi.storage.local.remove([RECORD_KEY])); return { ok: true };
        case 'SUBMIT_CANDIDATE_REVIEW':
        case 'OPEN_CANDIDATE_EVIDENCE':
        case 'SUBMIT_RUN_CONFIRMATION':
          return { ok: false, error: 'Unsupported: ambient candidates are read-only until an authoritative review resolver exists' };
        case protocol.MESSAGE_TYPES.pageReady:
          return pageReady(sender);
        case protocol.MESSAGE_TYPES.getBackendHealth:
          return { ok: true, health: await requestBackend('/health') };
        case protocol.MESSAGE_TYPES.getAdapters:
          return { ok: true, ...(await getAdapters(message.origin)) };
        case protocol.MESSAGE_TYPES.startJob:
          return { ok: true, jobId: await startJob(message.adapter, message.args, message.sourceUrl, sender.tab?.id) };
        case protocol.MESSAGE_TYPES.getJob: {
          const job = (await getJobs())[message.jobId];
          if (!job) return { ok: false, error: 'Job not found' };
          return { ok: true, job };
        }
        case protocol.MESSAGE_TYPES.webMcpStatus:
          await set('session', 'webMcpStatus', { available: message.available, registered: message.registered || 0, tabId: sender.tab?.id || null, updatedAt: now() });
          return { ok: true };
        default: return { ok: false, error: 'Unknown extension message' };
      }
    };
    return Object.freeze({ handleMessage, retryMetadata, retrySpoolReady: Boolean(retrySpoolApi) });
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
