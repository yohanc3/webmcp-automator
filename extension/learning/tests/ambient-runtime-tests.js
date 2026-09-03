'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ambientRuntime = require('../ambient-runtime.js');
const coordinatorApi = require('../../coordinator/bootstrap.js');
const retrySpool = require('../retry-spool.js');
const privacy = require('../privacy.js');
const semantic = require('../semantic.js');
const policyReview = require('../../ui/policy-review.js');

const policy = (overrides = {}) => ({
  checkedAt: '2026-09-03T12:00:00.000Z',
  decisionId: 'policy_shop_ambient',
  origin: 'https://shop.test',
  revision: 4,
  scopes: ['ambient_learn'],
  status: 'allowed',
  ...overrides,
});
const projection = () => ({
  evidenceIds: ['node_catalog'],
  rawPersisted: false,
  semanticXml: '<semantic-ui schema="semantic-ui/2"><node ref="node_catalog" /></semantic-ui>',
  url: 'https://shop.test/catalog',
});
const completedLayer = ({ id, origin, scopeId }) => ({
  layer: {
    completedAt: '2026-09-03T12:00:00.000Z',
    completionReason: 'initial_document',
    layerId: id,
    semanticXmlVersion: 'semantic-ui/2',
  },
  observation: {},
  policy: {},
  privacy: { rawPersisted: false },
  siteScope: { origin, scopeId },
});
const delay = (milliseconds = 0) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

const coordinatorFixture = ({ activeUrl = 'https://shop.test/catalog', now = () => '2026-09-03T12:00:00.000Z' } = {}) => {
  const areas = { local: { unrelatedLocal: 'kept' }, session: { unrelatedSession: 'kept' } };
  const sideEffects = { fetch: 0, storage: 0, tabs: 0 };
  const chromeApi = {
    storage: Object.fromEntries(['local', 'session'].map((area) => [area, {
      async get(key) { return { [key]: areas[area][key] }; },
      async set(values) { sideEffects.storage += 1; Object.assign(areas[area], values); },
      async remove(keys) { keys.forEach((key) => delete areas[area][key]); },
    }])),
    tabs: {
      async create() { sideEffects.tabs += 1; return { id: 99 }; },
      async query() { sideEffects.tabs += 1; return [{ url: activeUrl }]; },
      async sendMessage() { sideEffects.tabs += 1; return { ok: true }; },
    },
  };
  return { areas, chromeApi, sideEffects, coordinator: coordinatorApi.createCoordinator({ chromeApi, fetchApi: async () => { sideEffects.fetch += 1; throw new Error('fetch should not run'); }, now, retrySpoolApi: retrySpool }) };
};

const eventTarget = (target) => {
  const listeners = new Map();
  return Object.assign(target, {
    addEventListener(type, callback) { listeners.set(type, callback); },
    emit(type, event = {}) { listeners.get(type)?.(event); },
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); },
  });
};
const fakeDocument = () => eventTarget({ documentElement: { dataset: {} } });
const fakeWindow = () => eventTarget({ location: { origin: 'https://shop.test', pathname: '/catalog' } });
const fakeObserver = () => {
  let options;
  let disconnected = 0;
  return {
    attach(value) { options = value; return { disconnect() { disconnected += 1; } }; },
    async captureInitial() { return projection(); },
    get disconnected() { return disconnected; },
    get options() { return options; },
  };
};

const fakeChrome = (policies, outcomes = ['no_change']) => {
  const calls = [];
  const records = new Map();
  let pending = null;
  let sequence = 0;
  let policyIndex = 0;
  return {
    calls,
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        calls.push(message);
        let response = { ok: true };
        if (message.type === 'AMBIENT_POLICY_CURRENT') response.policy = policies[Math.min(policyIndex++, policies.length - 1)];
        if (message.type === 'AMBIENT_NEXT_LAYER_SEQUENCE') response.sequence = ++sequence;
        if (message.type === 'AMBIENT_CONSUME_PENDING') { response.pending = pending; pending = null; }
        if (message.type === 'AMBIENT_PUT_PENDING') { pending = message.pending; response.pending = pending; }
        if (message.type === 'AMBIENT_CLEAR_PENDING') { response.cleared = pending?.observationId === message.observationId; if (response.cleared) pending = null; }
        if (message.type === 'AMBIENT_DELIVER_LAYER') response.receipt = { outcome: 'no_change', receiptId: 'receipt_1' };
        if (message.type === 'AMBIENT_SPOOL_OPERATION') {
          const { operation, payload = {} } = message;
          if (operation === 'enqueue') { const record = { completedLayer: payload.completedLayer, id: payload.completedLayer.layer.layerId, state: 'queued' }; records.set(record.id, record); response.result = record; }
          if (operation === 'next') response.result = [...records.values()][0] || null;
          if (operation === 'markAttempt') response.result = records.get(payload.id) || null;
          if (operation === 'handleReceipt') { if (['applied', 'duplicate', 'no_change', 'rejected'].includes(payload.receipt.outcome)) records.delete(payload.id); response.result = { disposition: 'deleted' }; }
        }
        callback(response);
      },
    },
    storage: { onChanged: { addListener(callback) { this.callback = callback; } } },
    outcomes,
  };
};

test('reads current policy before attaching and every transfer, then revokes queued delivery', async () => {
  const chromeApi = fakeChrome([policy(), policy({ status: 'revoked', scopes: [] })]);
  const observer = fakeObserver();
  const runtime = ambientRuntime.createRuntime({
    chromeApi,
    documentApi: fakeDocument(),
    observer,
    windowApi: fakeWindow(),
  });
  const attached = await runtime.start();
  await runtime.controller.whenIdle();
  assert.equal(attached.attached, true);
  assert.equal(observer.disconnected, 1);
  assert.equal(runtime.controller.status().attached, false);
  assert.equal(chromeApi.calls.filter(({ type }) => type === 'AMBIENT_POLICY_CURRENT').length, 2);
  assert.equal(chromeApi.calls.filter(({ type }) => type === 'AMBIENT_POLICY_CURRENT')[1].revision, 4);
  assert.equal(chromeApi.calls.some(({ type }) => type === 'AMBIENT_SPOOL_OPERATION'), true);
});

test('a policy-change allow attaches automatically after an initial denial', async () => {
  const chromeApi = fakeChrome([policy({ status: 'denied', scopes: [] }), policy()]);
  const observer = fakeObserver();
  const runtime = ambientRuntime.createRuntime({ chromeApi, documentApi: fakeDocument(), observer, windowApi: fakeWindow() });
  assert.equal((await runtime.start()).attached, false);
  chromeApi.storage.onChanged.callback({ 'ambientPolicy:https://shop.test': { newValue: policy() } }, 'local');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.controller.status().attached, true);
});

test('trusted navigation is bridged immediately and consumed once by the recreated document', async () => {
  const chromeApi = fakeChrome([policy(), policy(), policy(), policy()]);
  const firstWindow = fakeWindow();
  let callbacks;
  const firstObserver = {
    attach(value) { callbacks = value; return { disconnect() {} }; },
    async captureInitial() { return projection(); },
  };
  const first = ambientRuntime.createRuntime({ chromeApi, documentApi: fakeDocument(), observer: firstObserver, windowApi: firstWindow });
  await first.start();
  const id = callbacks.onObservation({ kind: 'click', navigation: true, targetEvidenceId: 'node_link', trusted: true });
  await new Promise((resolve) => setImmediate(resolve));
  const second = ambientRuntime.createRuntime({ chromeApi, documentApi: fakeDocument(), observer: fakeObserver(), windowApi: fakeWindow() });
  await second.start();
  const enqueued = chromeApi.calls.filter(({ type, operation }) => type === 'AMBIENT_SPOOL_OPERATION' && operation === 'enqueue');
  assert.equal(enqueued.at(-1).payload.completedLayer.observation.observationId, id);
  assert.equal(enqueued.at(-1).payload.completedLayer.observation.kind, 'click');
  firstWindow.emit('pagehide');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(chromeApi.calls.filter(({ type }) => type === 'AMBIENT_PUT_PENDING').length, 1);
  first.controller.stop();
});

test('denied policy never attaches, while a later fresh allow attaches without reload', async () => {
  const chromeApi = fakeChrome([policy({ status: 'denied', scopes: [] }), policy()]);
  const observer = fakeObserver();
  const runtime = ambientRuntime.createRuntime({ chromeApi, documentApi: fakeDocument(), observer, windowApi: fakeWindow() });
  assert.equal((await runtime.start()).attached, false);
  assert.equal(observer.options, undefined);
  assert.equal((await runtime.start()).attached, true);
  assert.equal(observer.options !== undefined, true);
});


test('manual learning protocol messages are absent as a supplemental source assertion', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../shared/protocol.js'), 'utf8');
  assert.doesNotMatch(source, /START_RECORDING|STOP_RECORDING|RECORDING_START|RECORDING_STOP|DISCOVER/);
});

test('service worker serializes policy revisions and tab-scoped causal lifecycle state', async () => {
  const areas = { local: {}, session: {} };
  const chromeApi = {
    storage: Object.fromEntries(['local', 'session'].map((area) => [area, {
      async get(key) { return { [key]: areas[area][key] }; },
      async set(values) { Object.assign(areas[area], values); },
      async remove(keys) { keys.forEach((key) => delete areas[area][key]); },
    }])),
    tabs: { async query() { return [{ url: 'https://shop.test/catalog' }]; } },
  };
  const coordinator = coordinatorApi.createCoordinator({ chromeApi });
  const sender = { tab: { id: 7, url: 'https://shop.test/catalog' } };
  const saved = await Promise.all([1, 2, 3].map(() => coordinator.handleMessage({
    type: 'SUBMIT_POLICY_DECISION', decision: { decision: 'revoked', scope: 'ambient_learn' },
  })));
  assert.deepEqual(saved.map(({ policy: value }) => value.revision), [1, 2, 3]);
  assert.equal(saved.at(-1).policy.status, 'revoked');
  assert.equal(saved.at(-1).policy.origin, 'https://shop.test');
  const sequences = await Promise.all([1, 2, 3, 4].map(() => coordinator.handleMessage({
    type: 'AMBIENT_NEXT_LAYER_SEQUENCE', scopeId: 'shop_scope',
  }, sender)));
  assert.deepEqual(sequences.map(({ sequence }) => sequence), [1, 2, 3, 4]);
  await coordinator.handleMessage({ type: 'AMBIENT_PUT_PENDING', scopeId: 'shop_scope', documentId: 'ignored', pending: { observationId: 'obs_1' } }, sender);
  assert.equal((await coordinator.handleMessage({ type: 'AMBIENT_CLEAR_PENDING', scopeId: 'shop_scope', documentId: 'ignored', observationId: 'other' }, sender)).cleared, false);
  assert.equal((await coordinator.handleMessage({ type: 'AMBIENT_CLEAR_PENDING', scopeId: 'shop_scope', documentId: 'ignored', observationId: 'obs_1' }, sender)).cleared, true);
  await coordinator.handleMessage({ type: 'AMBIENT_PUT_PENDING', scopeId: 'shop_scope', documentId: 'ignored', pending: { observationId: 'obs_1' } }, sender);
  assert.deepEqual((await coordinator.handleMessage({ type: 'AMBIENT_CONSUME_PENDING', scopeId: 'shop_scope', documentId: 'ignored' }, sender)).pending, { observationId: 'obs_1' });
  assert.equal((await coordinator.handleMessage({ type: 'AMBIENT_CONSUME_PENDING', scopeId: 'shop_scope', documentId: 'ignored' }, sender)).pending, null);
});

test('coordinator AMBIENT_POLICY_CURRENT denies malformed, stale, foreign, unscoped, denied, and revoked records', async () => {
  const { areas, coordinator } = coordinatorFixture();
  const key = 'ambientPolicy:https://shop.test';
  const valid = policy({ expiresAt: '2099-09-03T12:00:00.000Z' });
  const cases = [
    ['missing checkedAt', { ...valid, checkedAt: undefined }], ['malformed checkedAt', { ...valid, checkedAt: 'not-a-time' }],
    ['expired', { ...valid, expiresAt: '2000-09-03T12:00:00.000Z' }], ['wrong origin', { ...valid, origin: 'https://other.test' }],
    ['missing scope', { ...valid, scopes: ['read'] }], ['denied', { ...valid, status: 'denied' }], ['revoked', { ...valid, status: 'revoked' }],
  ];
  for (const [label, stored] of cases) {
    areas.local[key] = stored;
    const response = await coordinator.handleMessage({ type: 'AMBIENT_POLICY_CURRENT', origin: 'https://shop.test', revision: 4, scope: 'ambient_learn' });
    assert.deepEqual(response, { ok: true, policy: { origin: 'https://shop.test', revision: 4, scopes: [], status: 'denied' } }, label);
  }
});

test('only the active owned demo can create an audited ambient override state', async () => {
  const general = coordinatorFixture({ activeUrl: 'https://shop.test/catalog' });
  const enable = { acknowledgedAt: '2026-09-03T12:00:00.000Z', enabled: true, origin: 'http://127.0.0.1:4317', reasonCode: 'OWNED_DEMO_EXPLICIT_OVERRIDE', requestedScope: 'ambient_learn' };
  const forged = await general.coordinator.handleMessage({ type: 'SET_OWNED_DEMO_OVERRIDE', override: enable });
  assert.deepEqual(forged, { ok: false, error: 'Owned demo override is not valid for this active origin' });
  assert.equal(general.areas.local['ambientPolicy:https://shop.test'], undefined);
  const demo = coordinatorFixture({ activeUrl: 'http://127.0.0.1:4317/demo/' });
  assert.equal((await demo.coordinator.handleMessage({ type: 'SET_OWNED_DEMO_OVERRIDE', override: enable })).ok, true);
  assert.deepEqual((await demo.coordinator.handleMessage({ type: 'GET_POLICY_REVIEW_STATE' })).state.overrideAudit, { actor: 'local user', changedAt: '2026-09-03T12:00:00.000Z', enabled: true, reason: 'OWNED_DEMO_EXPLICIT_OVERRIDE' });
  const disable = { ...enable, enabled: false, reasonCode: 'OWNED_DEMO_OVERRIDE_DISABLED' };
  assert.equal((await demo.coordinator.handleMessage({ type: 'SET_OWNED_DEMO_OVERRIDE', override: disable })).ok, true);
  assert.deepEqual((await demo.coordinator.handleMessage({ type: 'GET_POLICY_REVIEW_STATE' })).state.overrideAudit, { actor: 'local user', changedAt: '2026-09-03T12:00:00.000Z', enabled: false, reason: 'OWNED_DEMO_OVERRIDE_DISABLED' });
  assert.deepEqual(await general.coordinator.handleMessage({ type: 'SET_OWNED_DEMO_OVERRIDE', override: disable }), { ok: false, error: 'Owned demo override is not valid for this active origin' });
});

test('scope-specific retry metadata and deletion preserve unrelated stored values and records', async () => {
  const fixture = coordinatorFixture({ activeUrl: 'https://shop.test/catalog' });
  const shopScope = 'site_https___shop_test';
  await fixture.coordinator.handleMessage({ type: 'AMBIENT_SPOOL_OPERATION', operation: 'enqueue', payload: { completedLayer: completedLayer({ id: 'shop_1', origin: 'https://shop.test', scopeId: shopScope }) } });
  await fixture.coordinator.handleMessage({ type: 'AMBIENT_SPOOL_OPERATION', operation: 'enqueue', payload: { completedLayer: completedLayer({ id: 'other_1', origin: 'https://other.test', scopeId: 'site_other_test' }) } });
  const metadata = (await fixture.coordinator.handleMessage({ type: 'GET_POLICY_REVIEW_STATE' })).state.retrySpool;
  assert.equal(metadata.count, 1); assert.equal(metadata.scopeId, shopScope);
  assert.match(metadata.oldestAt, /^\d{4}-\d{2}-\d{2}T/); assert.match(metadata.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  const deletion = await fixture.coordinator.handleMessage({ type: 'REQUEST_RETRY_SPOOL_DELETION', request: { count: 99, origin: 'https://other.test', scopeId: 'site_other_test' } });
  assert.deepEqual(deletion, { deleted: 1, ok: true, scopeId: shopScope });
  assert.deepEqual((await fixture.coordinator.handleMessage({ type: 'AMBIENT_SPOOL_OPERATION', operation: 'list' })).result.map(({ id }) => id), ['other_1']);
  assert.equal(fixture.areas.local.unrelatedLocal, 'kept'); assert.equal(fixture.areas.session.unrelatedSession, 'kept');
  assert.deepEqual(await fixture.coordinator.handleMessage({ type: 'REQUEST_RETRY_SPOOL_DELETION' }), { deleted: 0, ok: true, scopeId: shopScope });
});

test('candidate review and confirmation protocol messages fail closed without side effects', async () => {
  const fixture = coordinatorFixture(); const before = { ...fixture.sideEffects };
  assert.deepEqual(await fixture.coordinator.handleMessage({ type: 'SUBMIT_CANDIDATE_REVIEW' }), { ok: false, error: 'A complete candidate-review decision is required' });
  assert.match((await fixture.coordinator.handleMessage({ type: 'OPEN_CANDIDATE_EVIDENCE' })).error, /explicitly unavailable/);
  assert.match((await fixture.coordinator.handleMessage({ type: 'SUBMIT_RUN_CONFIRMATION' })).error, /exact coordinator run/);
  for (const type of ['GET_POLICY_REVIEW_STATE', 'SUBMIT_CANDIDATE_REVIEW', 'SUBMIT_RUN_CONFIRMATION']) {
    assert.match(
      (await fixture.coordinator.handleMessage({ type }, { tab: { id: 7 } })).error,
      /trusted extension UI/,
    );
  }
  assert.deepEqual(fixture.sideEffects, before);
  assert.deepEqual(fixture.areas, { local: { unrelatedLocal: 'kept' }, session: { unrelatedSession: 'kept' } });
});

test('action-map heads and candidate bindings require the exact current digests', () => {
  const mapDigest = `sha256:${'a'.repeat(64)}`; const listDigest = `sha256:${'b'.repeat(64)}`;
  const actionMap = { head: { digest: mapDigest, revision: 7 } }; const candidate = { actionMap, contentDigest: listDigest, revision: 3 };
  assert.deepEqual(policyReview.actionMapBinding(actionMap), { digest: mapDigest, revision: 7 });
  assert.deepEqual(policyReview.reviewBinding(candidate), { actionMapDigest: mapDigest, actionMapRevision: 7, listDigest, listRevision: 3 });
  assert.deepEqual(policyReview.staleReviewReasons(candidate, { actionMap: { head: { digest: mapDigest } }, listDigest }), []);
  assert.deepEqual(policyReview.staleReviewReasons(candidate, { actionMapDigest: `sha256:${'c'.repeat(64)}`, listDigest }), ['Action-map digest changed.']);
  assert.deepEqual(policyReview.staleConfirmationReasons({ documentId: 'doc_1', listDigest, origin: 'https://shop.test', policyRevision: 5, stepId: 'step_1' }, { documentId: 'doc_1', listDigest, origin: 'https://shop.test', policyRevision: 5, stepId: 'step_1' }), []);
});

test('coordinator preserves backend, adapter, job, page-ready, and status dispatch', async () => {
  const areas = { local: {}, session: {} };
  const chromeApi = {
    storage: Object.fromEntries(['local', 'session'].map((area) => [area, {
      async get(key) { return { [key]: areas[area][key] }; },
      async set(values) { Object.assign(areas[area], values); },
      async remove() {},
    }])),
    tabs: {
      async create() { return { id: 9 }; },
      async update() {},
      async query() { return [{ url: 'https://shop.test/catalog' }]; },
      async sendMessage() { return { ok: true }; },
    },
  };
  const manifest = { manifestMatchesLocation: () => true, validateManifest: (value) => ({ manifest: value, valid: true }) };
  const coordinator = coordinatorApi.createCoordinator({
    chromeApi,
    fetchApi: async (url) => ({ json: async () => (url.endsWith('/health') ? { ready: true } : { adapters: ['a'] }), ok: true }),
    manifest,
  });
  const sender = { tab: { id: 4 } };
  assert.deepEqual(await coordinator.handleMessage({ type: 'GET_BACKEND_HEALTH' }, sender), { ok: true, health: { ready: true } });
  assert.deepEqual(await coordinator.handleMessage({ type: 'GET_ADAPTERS', origin: 'https://shop.test' }, sender), { ok: true, adapters: ['a'], stale: false });
  const jobId = (await coordinator.handleMessage({ type: 'START_JOB', adapter: { manifest: { tool: { steps: [] } } }, args: {}, sourceUrl: 'https://shop.test/catalog' }, sender)).jobId;
  assert.equal((await coordinator.handleMessage({ type: 'GET_JOB', jobId }, sender)).ok, true);
  assert.equal((await coordinator.handleMessage({ type: 'PAGE_READY' }, sender)).recordingActive, false);
  assert.deepEqual(await coordinator.handleMessage({ type: 'WEBMCP_STATUS', available: true, registered: 2 }, sender), { ok: true });
  assert.equal(areas.session.webMcpStatus.registered, 2);
});

test('coordinator executes fill then navigation click, resumes on PAGE_READY, extracts, reports, and closes the execution tab', async () => {
  const areas = { local: {}, session: {} };
  const commands = [];
  const reports = [];
  const removed = [];
  const chromeApi = {
    storage: Object.fromEntries(['local', 'session'].map((area) => [area, {
      async get(key) { return { [key]: areas[area][key] }; },
      async set(values) { Object.assign(areas[area], values); },
      async remove() {},
    }])),
    tabs: {
      async create() { return { id: 17 }; },
      async update() {},
      async remove(tabId) { removed.push(tabId); },
      async sendMessage(tabId, message) {
        commands.push({ tabId, op: message.step.op });
        if (message.step.op === 'click') return { navigating: true, ok: true };
        if (message.step.op === 'extract') return { ok: true, result: { products: ['headphones'] } };
        return { ok: true };
      },
    },
  };
  const manifest = { manifestMatchesLocation: () => true, validateManifest: (value) => ({ manifest: value, valid: true }) };
  const coordinator = coordinatorApi.createCoordinator({
    chromeApi,
    fetchApi: async (url, options) => {
      if (url.endsWith('/api/runs')) reports.push(JSON.parse(options.body));
      return { json: async () => ({}), ok: true };
    },
    manifest,
  });
  const adapter = {
    manifest: {
      tool: { steps: [{ op: 'fill' }, { op: 'click' }] },
    },
    versionId: 'version_1',
  };
  const started = await coordinator.handleMessage({ type: 'START_JOB', adapter, args: { query: 'headphones' }, sourceUrl: 'https://shop.test/catalog' }, { tab: { id: 4 } });
  await coordinator.handleMessage({ type: 'PAGE_READY' }, { tab: { id: 17 } });
  await delay(5);
  assert.deepEqual(commands.map(({ op }) => op), ['fill', 'click']);
  assert.equal(areas.session.jobs[started.jobId].status, 'waiting-navigation');
  await coordinator.handleMessage({ type: 'PAGE_READY' }, { tab: { id: 17 } });
  await delay(5);
  assert.equal(areas.session.jobs[started.jobId].status, 'completed');
  assert.deepEqual(areas.session.jobs[started.jobId].result, { products: ['headphones'] });
  assert.deepEqual(commands.map(({ op }) => op), ['fill', 'click', 'extract']);
  assert.deepEqual(reports, [{ error: null, failedStep: null, observed: null, outcome: 'success', url: 'https://shop.test/catalog', versionId: 'version_1' }]);
  assert.deepEqual(removed, [17]);
});

test('coordinator retries startup transport failures and GET_JOB nudges a nonterminal job', async () => {
  const areas = { local: {}, session: {} };
  let attempts = 0;
  const chromeApi = {
    storage: Object.fromEntries(['local', 'session'].map((area) => [area, {
      async get(key) { return { [key]: areas[area][key] }; }, async set(values) { Object.assign(areas[area], values); }, async remove() {},
    }])),
    tabs: {
      async create() { return { id: 18 }; },
      async update() {},
      async remove() {},
      async sendMessage() {
        attempts += 1;
        if (attempts === 1) throw new Error('content script is not ready');
        if (attempts === 2) return { ok: true };
        return { ok: true, result: { ready: true } };
      },
    },
  };
  const manifest = { manifestMatchesLocation: () => true, validateManifest: (value) => ({ manifest: value, valid: true }) };
  const coordinator = coordinatorApi.createCoordinator({ chromeApi, fetchApi: async () => ({ json: async () => ({}), ok: true }), manifest });
  const started = await coordinator.handleMessage({ type: 'START_JOB', adapter: { manifest: { tool: { steps: [{ op: 'wait' }] } }, versionId: 'version_2' }, args: {}, sourceUrl: 'https://shop.test/catalog' }, { tab: { id: 4 } });
  await coordinator.handleMessage({ type: 'GET_JOB', jobId: started.jobId });
  await delay(270);
  assert.equal(attempts >= 2, true);
  await coordinator.handleMessage({ type: 'GET_JOB', jobId: started.jobId });
  await delay(5);
  assert.equal(areas.session.jobs[started.jobId].status, 'completed');
});

test('coordinator serializes concurrent advances and fails a nonterminal job when its execution tab closes', async () => {
  const areas = { local: {}, session: {} };
  let sends = 0;
  const chromeApi = {
    storage: Object.fromEntries(['local', 'session'].map((area) => [area, {
      async get(key) { return { [key]: areas[area][key] }; }, async set(values) { Object.assign(areas[area], values); }, async remove() {},
    }])),
    tabs: {
      async create() { return { id: 19 }; },
      async update() {},
      async remove() {},
      async sendMessage() { sends += 1; await delay(5); return { navigating: true, ok: true }; },
    },
  };
  const manifest = { manifestMatchesLocation: () => true, validateManifest: (value) => ({ manifest: value, valid: true }) };
  const coordinator = coordinatorApi.createCoordinator({ chromeApi, fetchApi: async () => ({ json: async () => ({}), ok: true }), manifest });
  const started = await coordinator.handleMessage({ type: 'START_JOB', adapter: { manifest: { tool: { steps: [{ op: 'click' }] } }, versionId: 'version_3' }, args: {}, sourceUrl: 'https://shop.test/catalog' }, { tab: { id: 4 } });
  await Promise.all([
    coordinator.handleMessage({ type: 'PAGE_READY' }, { tab: { id: 19 } }),
    coordinator.handleMessage({ type: 'PAGE_READY' }, { tab: { id: 19 } }),
  ]);
  await delay(15);
  assert.equal(sends, 1);
  coordinator.onTabRemoved(19);
  await delay(5);
  assert.equal(areas.session.jobs[started.jobId].status, 'failed');
  assert.equal(areas.session.jobs[started.jobId].failedStep, 1);
  assert.match(areas.session.jobs[started.jobId].error, /closed/);
});

test('content forwards ambient delivery while the service worker adds the internal header and classifies receipts', async () => {
  const areas = { local: {}, session: {} };
  const chromeApi = { storage: Object.fromEntries(['local', 'session'].map((area) => [area, {
    async get(key) { return { [key]: areas[area][key] }; }, async set(value) { Object.assign(areas[area], value); }, async remove() {},
  }])) };
  const calls = [];
  const responseFor = (status, body) => async (url, options) => {
    calls.push({ options, url });
    return { json: async () => body, ok: status >= 200 && status < 300, status };
  };
  const coordinator = coordinatorApi.createCoordinator({ chromeApi, fetchApi: responseFor(200, { outcome: 'applied', requestId: 'r1' }), retrySpoolApi: {} });
  assert.equal(coordinator.retrySpoolReady, true);
  assert.deepEqual(await coordinator.handleMessage({ type: 'AMBIENT_DELIVER_LAYER', completedLayer: { layer: { layerId: 'layer_1' } } }), { ok: true, receipt: { actionListCandidate: null, outcome: 'applied', receiptId: 'r1' } });
  assert.equal(calls[0].url, 'http://127.0.0.1:4317/v1/ambient/layers');
  assert.equal(calls[0].options.headers['X-WebMCP-Internal'], 'ambient-v1');
  const conflict = coordinatorApi.createCoordinator({ chromeApi, fetchApi: responseFor(409, {}), retrySpoolApi: {} });
  assert.equal((await conflict.handleMessage({ type: 'AMBIENT_DELIVER_LAYER', completedLayer: {} })).receipt.outcome, 'conflict');
  const retryable = coordinatorApi.createCoordinator({ chromeApi, fetchApi: responseFor(503, {}), retrySpoolApi: {} });
  await assert.rejects(() => retryable.handleMessage({ type: 'AMBIENT_DELIVER_LAYER', completedLayer: {} }), /retryable/);
});

test('persists the exact accepted action-list candidate pointer by ambient site scope', async () => {
  const areas = { local: {}, session: {} };
  const chromeApi = { storage: Object.fromEntries(['local', 'session'].map((area) => [area, {
    async get(key) { return { [key]: areas[area][key] }; }, async set(value) { Object.assign(areas[area], value); }, async remove() {},
  }])) };
  const digest = `sha256:${'a'.repeat(64)}`;
  const candidate = { digest, listId: 'ambient_site_shop_test', revision: 3, status: 'candidate' };
  const fetchApi = async () => ({
    json: async () => ({ actionListCandidate: candidate, outcome: 'applied', requestId: 'receipt_1' }), ok: true, status: 201,
  });
  const coordinator = coordinatorApi.createCoordinator({ chromeApi, fetchApi, retrySpoolApi: {} });
  const completedLayer = { siteScope: { scopeId: 'site_shop_test' } };
  const response = await coordinator.handleMessage({ type: 'AMBIENT_DELIVER_LAYER', completedLayer });
  assert.deepEqual(response.receipt.actionListCandidate, candidate);
  assert.deepEqual(areas.session['ambientActionListCandidate:site_shop_test'], candidate);
});

test('preserves applied and duplicate candidate pointers without persisting unaccepted receipts', async () => {
  const areas = { local: {}, session: {} };
  const chromeApi = { storage: Object.fromEntries(['local', 'session'].map((area) => [area, {
    async get(key) { return { [key]: areas[area][key] }; }, async set(value) { Object.assign(areas[area], value); }, async remove() {},
  }])) };
  const pointer = { digest: `sha256:${'b'.repeat(64)}`, listId: 'ambient_site_shop_test', revision: 4, status: 'candidate' };
  const outcomes = ['duplicate', 'no_change'];
  const coordinator = coordinatorApi.createCoordinator({
    chromeApi,
    fetchApi: async () => ({ json: async () => ({ actionListCandidate: pointer, outcome: outcomes.shift(), requestId: 'receipt_2' }), ok: true, status: 200 }),
    retrySpoolApi: {},
  });
  const completedLayer = { siteScope: { scopeId: 'site_shop_test' } };
  await coordinator.handleMessage({ type: 'AMBIENT_DELIVER_LAYER', completedLayer });
  assert.deepEqual(areas.session['ambientActionListCandidate:site_shop_test'], pointer);
  await coordinator.handleMessage({ type: 'AMBIENT_DELIVER_LAYER', completedLayer });
  assert.deepEqual(areas.session['ambientActionListCandidate:site_shop_test'], pointer);
});

test('loads only exact authoritative action-map context and candidate bindings for policy review', async () => {
  const areas = { local: {}, session: {} };
  const scopeId = 'site_https___shop_test';
  const mapDigest = `sha256:${'c'.repeat(64)}`;
  const listDigest = `sha256:${'d'.repeat(64)}`;
  areas.session[`ambientActionListCandidate:${scopeId}`] = { digest: listDigest, listId: 'ambient_site_https_shop_test', revision: 2, status: 'candidate' };
  const chromeApi = {
    storage: Object.fromEntries(['local', 'session'].map((area) => [area, {
      async get(key) { return { [key]: areas[area][key] }; }, async set(value) { Object.assign(areas[area], value); }, async remove() {},
    }])),
    tabs: { async query() { return [{ url: 'https://shop.test/catalog' }]; } },
  };
  const calls = [];
  const response = (body, { etag = null, status = 200 } = {}) => ({
    headers: { get: (name) => (name === 'ETag' ? etag : null) }, json: async () => body, ok: status >= 200 && status < 300, status,
  });
  const coordinator = coordinatorApi.createCoordinator({
    chromeApi,
    fetchApi: async (url) => {
      calls.push(url);
      if (url.endsWith('/head')) return response({ digest: mapDigest, revision: 2, siteScopeId: scopeId });
      if (url.includes('/context?revision=2')) return response({ actions: [{ actionId: 'search', evidenceHandles: ['layer_1:node_1'] }], digest: mapDigest, revision: 2, siteScopeId: scopeId });
      if (url.endsWith('/candidate-review')) return response({ binding: { actionMapDigest: mapDigest, actionMapRevision: 2, candidateDigest: listDigest }, status: 'candidate' });
      return response({ actions: [{ id: 'search' }], listId: 'ambient_site_https_shop_test', publication: { revision: 2, status: 'candidate' } }, { etag: `"${listDigest}"` });
    },
    retrySpoolApi: { createChromeEncryptedStorage: async () => ({}), createRetrySpool: () => ({ list: async () => [] }) },
  });
  const result = await coordinator.handleMessage({ type: 'GET_POLICY_REVIEW_STATE' });
  assert.deepEqual(calls, [
    'http://127.0.0.1:4317/v1/action-maps/site_https___shop_test/head',
    'http://127.0.0.1:4317/v1/action-maps/site_https___shop_test/context?revision=2',
    'http://127.0.0.1:4317/v1/action-lists/ambient_site_https_shop_test/revisions/2',
    'http://127.0.0.1:4317/v1/action-lists/ambient_site_https_shop_test/revisions/2/candidate-review',
  ]);
  assert.equal(result.state.actionMap.digest, mapDigest);
  assert.deepEqual(result.state.actionMap.actions, [{ actionId: 'search', evidenceHandles: ['layer_1:node_1'] }]);
  assert.equal(result.state.context.listDigest, listDigest);
  assert.equal(result.state.context.listRevision, 2);
  assert.deepEqual(result.state.candidate, {
    actionMapDigest: mapDigest, actionMapRevision: 2, actions: [{ id: 'search' }], contentDigest: listDigest, listDigest, listId: 'ambient_site_https_shop_test', listRevision: 2, publication: { revision: 2, status: 'candidate' }, revision: 2, review: { binding: { actionMapDigest: mapDigest, actionMapRevision: 2, candidateDigest: listDigest }, status: 'candidate' }, status: 'candidate', title: 'ambient_site_https_shop_test',
  });
});

test('fails closed for absent, offline, malformed, and mismatched policy-review action maps', async () => {
  const scopeId = 'site_https___shop_test';
  const chromeApi = {
    storage: Object.fromEntries(['local', 'session'].map((area) => [area, { async get() { return {}; }, async set() {}, async remove() {} }])),
    tabs: { async query() { return [{ url: 'https://shop.test/catalog' }]; } },
  };
  const cases = [
    { name: 'not found', fetchApi: async () => ({ json: async () => ({}), ok: false, status: 404 }), status: 'no_map' },
    { name: 'offline', fetchApi: async () => { throw new Error('offline'); }, status: 'unavailable' },
    { name: 'malformed', fetchApi: async () => ({ json: async () => ({ siteScopeId: scopeId }), ok: true, status: 200 }), status: 'unavailable' },
    {
      name: 'mismatched context',
      fetchApi: async (url) => (url.endsWith('/head')
        ? { json: async () => ({ digest: `sha256:${'e'.repeat(64)}`, revision: 2, siteScopeId: scopeId }), ok: true, status: 200 }
        : { json: async () => ({ actions: [], digest: `sha256:${'f'.repeat(64)}`, revision: 2, siteScopeId: scopeId }), ok: true, status: 200 }),
      status: 'unavailable',
    },
  ];
  for (const scenario of cases) {
    const coordinator = coordinatorApi.createCoordinator({
      chromeApi,
      fetchApi: scenario.fetchApi,
      retrySpoolApi: { createChromeEncryptedStorage: async () => ({}), createRetrySpool: () => ({ list: async () => [] }) },
    });
    const result = await coordinator.handleMessage({ type: 'GET_POLICY_REVIEW_STATE' });
    assert.equal(result.state.actionMap, null, scenario.name);
    assert.equal(result.state.candidate, null, scenario.name);
    assert.equal(result.state.actionMapStatus.status, scenario.status, scenario.name);
  }
});

test('omits candidates whose ETag or document bindings are not exact', async () => {
  const scopeId = 'site_https___shop_test';
  const mapDigest = `sha256:${'e'.repeat(64)}`;
  const listDigest = `sha256:${'f'.repeat(64)}`;
  const areas = { local: {}, session: { [`ambientActionListCandidate:${scopeId}`]: { digest: listDigest, listId: 'candidate_list', revision: 2 } } };
  const chromeApi = {
    storage: Object.fromEntries(['local', 'session'].map((area) => [area, { async get(key) { return { [key]: areas[area][key] }; }, async set(value) { Object.assign(areas[area], value); }, async remove() {} }])),
    tabs: { async query() { return [{ url: 'https://shop.test/catalog' }]; } },
  };
  const coordinator = coordinatorApi.createCoordinator({
    chromeApi,
    fetchApi: async (url) => {
      if (url.endsWith('/head')) return { json: async () => ({ digest: mapDigest, revision: 2, siteScopeId: scopeId }), ok: true, status: 200 };
      if (url.includes('/context?')) return { json: async () => ({ actions: [], digest: mapDigest, revision: 2, siteScopeId: scopeId }), ok: true, status: 200 };
      return { headers: { get: () => `"sha256:${'0'.repeat(64)}"` }, json: async () => ({ listId: 'candidate_list', publication: { revision: 2, status: 'candidate' } }), ok: true, status: 200 };
    },
    retrySpoolApi: { createChromeEncryptedStorage: async () => ({}), createRetrySpool: () => ({ list: async () => [] }) },
  });
  const result = await coordinator.handleMessage({ type: 'GET_POLICY_REVIEW_STATE' });
  assert.equal(result.state.actionMap.digest, mapDigest);
  assert.equal(result.state.candidate, null);
});

test('missing review bindings fail closed without fetch, tabs, jobs, or storage effects', async () => {
  let fetches = 0;
  let tabCalls = 0;
  let storageWrites = 0;
  const chromeApi = {
    storage: Object.fromEntries(['local', 'session'].map((area) => [area, { async get() { return {}; }, async set() { storageWrites += 1; }, async remove() { storageWrites += 1; } }])),
    tabs: { async create() { tabCalls += 1; }, async query() { tabCalls += 1; }, async sendMessage() { tabCalls += 1; } },
  };
  const coordinator = coordinatorApi.createCoordinator({ chromeApi, fetchApi: async () => { fetches += 1; }, retrySpoolApi: {} });
  const review = await coordinator.handleMessage({ type: 'SUBMIT_CANDIDATE_REVIEW' });
  const evidence = await coordinator.handleMessage({ type: 'OPEN_CANDIDATE_EVIDENCE' });
  const confirmation = await coordinator.handleMessage({ type: 'SUBMIT_RUN_CONFIRMATION' });
  assert.match(review.error, /complete candidate-review decision/);
  assert.match(evidence.error, /explicitly unavailable/);
  assert.match(confirmation.error, /exact coordinator run/);
  assert.deepEqual({ fetches, storageWrites, tabCalls }, { fetches: 0, storageWrites: 0, tabCalls: 0 });
});

test('content runtime never fetches ambient layers directly', async () => {
  const chromeApi = fakeChrome([policy(), policy()]);
  const observer = fakeObserver();
  const runtime = ambientRuntime.createRuntime({ chromeApi, documentApi: fakeDocument(), observer, windowApi: fakeWindow() });
  await runtime.start();
  await runtime.controller.whenIdle();
  assert.equal(chromeApi.calls.some(({ type }) => type === 'AMBIENT_DELIVER_LAYER'), true);
});

test('encrypted retry storage keeps only JWK session material and ciphertext local, then purges after key rotation', async () => {
  const values = { local: {}, session: {} };
  const chromeApi = { storage: Object.fromEntries(['local', 'session'].map((area) => [area, {
    async get(key) { return { [key]: values[area][key] }; },
    async set(next) { Object.assign(values[area], next); },
    async remove(keys) { keys.forEach((key) => delete values[area][key]); },
  }])) };
  const storage = await retrySpool.createChromeEncryptedStorage({ chromeApi });
  const record = { id: 'layer_1', completedLayer: { secret: 'must-not-persist' } };
  await storage.put(record);
  assert.equal(values.session.ambientRetryKey.kty, 'oct');
  assert.equal(typeof values.local.ambientRetryRecords.layer_1.data, 'string');
  assert.equal(JSON.stringify(values.local.ambientRetryRecords).includes('must-not-persist'), false);
  delete values.session.ambientRetryKey;
  const rotated = await retrySpool.createChromeEncryptedStorage({ chromeApi });
  assert.deepEqual(await rotated.list(), []);
  assert.deepEqual(values.local.ambientRetryRecords, undefined);
});

test('semantic XML retains deterministic sanitized allowlisted attributes without a privacy canary', () => {
  const ledger = privacy.createLedger();
  const attributes = privacy.sanitizeAttributes({
    href: 'https://shop.test/orders?token=canary-secret-12345',
    placeholder: 'Order number',
    'data-field': 'orderId',
    itemprop: 'order',
    type: 'search',
    'aria-expanded': 'false',
    'data-private': 'canary-secret-12345',
  }, { ledger });
  const xml = semantic.nodesToXml([{
    attributes,
    css: '#orders',
    id: 'node_orders',
    name: 'Open orders',
    role: 'link',
    tag: 'a',
    text: null,
  }], 'https://shop.test/catalog', 'Store');
  assert.match(xml, /href="https:\/\/shop.test\/orders"/);
  assert.match(xml, /data-field="orderId"/);
  assert.match(xml, /placeholder="Order number"/);
  assert.equal(xml.includes('data-private'), false);
  assert.equal(xml.includes('canary-secret-12345'), false);
  assert.equal(ledger.summary().total > 0, true);
});

test('runtime projection attaches the real nonzero privacy ledger summary', async () => {
  const observer = ambientRuntime.defaultObserver({
    documentApi: fakeDocument(),
    privacyApi: privacy,
    semanticApi: {
      capturePageState({ ledger }) {
        ledger.record('credential', 2);
        return { nodes: [{ id: 'node_safe' }], semanticXml: '<semantic-ui schema="semantic-ui/2" />' };
      },
    },
    windowApi: fakeWindow(),
  });
  const captured = await observer.captureInitial();
  assert.deepEqual(captured.redactions, {
    schemaVersion: 'redaction-ledger/1', total: 2, counts: { credential: 2 },
  });
  assert.equal(captured.rawPersisted, false);
});

test('default observer records trusted event kinds, route hooks, and removes the exact popstate callback', () => {
  class Element {
    constructor({ form = null, navigation = false } = {}) { this.form = form; this.navigation = navigation; }
    closest() { return this.navigation ? this : null; }
  }
  const documentApi = fakeDocument();
  const windowApi = fakeWindow();
  windowApi.Element = Element;
  windowApi.MutationObserver = class { disconnect() {} observe() {} };
  windowApi.history = { pushState() {}, replaceState() {} };
  const seen = [];
  const observer = ambientRuntime.defaultObserver({
    documentApi,
    windowApi,
  });
  const connection = observer.attach({
    onObservation(value) { seen.push(value.kind); return `obs_${seen.length}`; },
    onSettled() {},
  });
  const event = (target, extra = {}) => ({ isTrusted: true, target, ...extra });
  documentApi.emit('click', event(new Element({ navigation: true })));
  documentApi.emit('focusin', event(new Element()));
  documentApi.emit('input', event(new Element()));
  documentApi.emit('keydown', event(new Element({ form: {} }), { key: 'Enter' }));
  documentApi.emit('submit', event(new Element({ form: {} })));
  windowApi.history.pushState({}, '', '/next');
  windowApi.history.replaceState({}, '', '/again');
  windowApi.emit('popstate');
  assert.deepEqual(seen, ['click', 'other', 'fill', 'press', 'submit']);
  connection.disconnect();
  windowApi.emit('popstate');
});

test('empty-spool policy revocation detaches synchronously before another event', async () => {
  const chromeApi = fakeChrome([policy()]);
  const observer = fakeObserver();
  const runtime = ambientRuntime.createRuntime({
    chromeApi,
    documentApi: fakeDocument(),
    observer,
    windowApi: fakeWindow(),
  });
  await runtime.start();
  await runtime.controller.whenIdle();
  const enqueueCount = () => chromeApi.calls.filter(({ operation, type }) => (
    type === 'AMBIENT_SPOOL_OPERATION' && operation === 'enqueue'
  )).length;
  const enqueuedBeforeRevocation = enqueueCount();
  const disconnectedBeforeRevocation = observer.disconnected;
  const { onObservation } = observer.options;

  chromeApi.storage.onChanged.callback({
    'ambientPolicy:https://shop.test': { newValue: policy({ scopes: [], status: 'revoked' }) },
  }, 'local');

  assert.equal(runtime.controller.status().attached, false);
  assert.equal(observer.disconnected, disconnectedBeforeRevocation + 1);
  onObservation({
    kind: 'click',
    navigation: false,
    targetEvidenceId: 'node_catalog',
    trusted: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(enqueueCount(), enqueuedBeforeRevocation);
});

test('polling and startup timers cannot cross waiting-navigation before PAGE_READY', async () => {
  const areas = { local: {}, session: {} };
  const commands = [];
  const chromeApi = {
    storage: Object.fromEntries(['local', 'session'].map((area) => [area, {
      async get(key) { return { [key]: areas[area][key] }; },
      async set(values) { Object.assign(areas[area], values); },
      async remove() {},
    }])),
    tabs: {
      async create() { return { id: 20 }; },
      async update() {},
      async remove() {},
      async sendMessage(tabId, message) {
        commands.push({ op: message.step.op, tabId });
        if (message.step.op === 'click') return { navigating: true, ok: true };
        return { ok: true, result: { products: ['headphones'] } };
      },
    },
  };
  const manifest = {
    manifestMatchesLocation: () => true,
    validateManifest: (value) => ({ manifest: value, valid: true }),
  };
  const coordinator = coordinatorApi.createCoordinator({
    chromeApi,
    fetchApi: async () => ({ json: async () => ({}), ok: true }),
    manifest,
  });
  const adapter = {
    manifest: { tool: { steps: [{ op: 'click' }] } },
    versionId: 'version_navigation_guard',
  };
  const started = await coordinator.handleMessage({
    type: 'START_JOB',
    adapter,
    args: {},
    sourceUrl: 'https://shop.test/catalog',
  }, { tab: { id: 4 } });

  await coordinator.handleMessage({ type: 'PAGE_READY' }, { tab: { id: 20 } });
  await delay(5);
  assert.deepEqual(commands.map(({ op }) => op), ['click']);
  assert.equal(areas.session.jobs[started.jobId].status, 'waiting-navigation');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await coordinator.handleMessage({ type: 'GET_JOB', jobId: started.jobId });
    assert.equal(response.job.status, 'waiting-navigation');
  }
  await delay(320);
  assert.deepEqual(commands.map(({ op }) => op), ['click']);
  assert.equal(areas.session.jobs[started.jobId].status, 'waiting-navigation');

  await coordinator.handleMessage({ type: 'PAGE_READY' }, { tab: { id: 20 } });
  await delay(5);
  assert.deepEqual(commands.map(({ op }) => op), ['click', 'extract']);
  assert.equal(commands.filter(({ op }) => op === 'extract').length, 1);
  assert.equal(areas.session.jobs[started.jobId].status, 'completed');
});

test('execution tab ownership precedes navigation and rejects ambient startup', async () => {
  const lifecycleKey = 'ambientLifecycle:shop_scope';
  const executionTabId = 21;
  const sourceTabId = 4;
  const sourceUrl = 'https://shop.test/catalog';
  const areas = {
    local: {},
    session: {
      [lifecycleKey]: {
        nextLayerSequence: 7,
        pending: { [executionTabId]: { observationId: 'obs_execution' } },
      },
    },
  };
  const createdUrls = [];
  const navigatedUrls = [];
  let coordinator;
  let executionResponses;
  let ownershipObserved = false;
  let sourceSequence;
  const chromeApi = {
    storage: Object.fromEntries(['local', 'session'].map((area) => [area, {
      async get(key) { return { [key]: areas[area][key] }; },
      async set(values) { Object.assign(areas[area], values); },
      async remove() {},
    }])),
    tabs: {
      async create(options) {
        createdUrls.push(options.url);
        return { id: executionTabId };
      },
      async update(tabId, options) {
        const ownedJob = Object.values(areas.session.jobs).find((job) => job.tabId === tabId);
        assert.equal(ownedJob?.status, 'starting');
        ownershipObserved = true;
        const lifecycleBeforeExecutionMessages = JSON.parse(JSON.stringify(areas.session[lifecycleKey]));
        const executionSender = { tab: { id: executionTabId } };
        executionResponses = await Promise.all([
          coordinator.handleMessage({
            type: 'AMBIENT_CONSUME_PENDING',
            documentId: 'ignored',
            scopeId: 'shop_scope',
          }, executionSender),
          coordinator.handleMessage({
            type: 'AMBIENT_POLICY_CURRENT',
            origin: 'https://shop.test',
            scope: 'ambient_learn',
          }, executionSender),
        ]);
        assert.deepEqual(areas.session[lifecycleKey], lifecycleBeforeExecutionMessages);
        sourceSequence = await coordinator.handleMessage({
          type: 'AMBIENT_NEXT_LAYER_SEQUENCE',
          scopeId: 'shop_scope',
        }, { tab: { id: sourceTabId } });
        navigatedUrls.push(options.url);
      },
      async remove() {},
      async sendMessage() { return { ok: true, result: {} }; },
    },
  };
  const manifest = {
    manifestMatchesLocation: () => true,
    validateManifest: (value) => ({ manifest: value, valid: true }),
  };
  coordinator = coordinatorApi.createCoordinator({
    chromeApi,
    fetchApi: async () => ({ json: async () => ({}), ok: true }),
    manifest,
  });

  const started = await coordinator.handleMessage({
    type: 'START_JOB',
    adapter: { manifest: { tool: { steps: [] } }, versionId: 'version_execution_ownership' },
    args: {},
    sourceUrl,
  }, { tab: { id: sourceTabId } });

  assert.deepEqual(createdUrls, ['about:blank']);
  assert.equal(ownershipObserved, true);
  assert.equal(areas.session.jobs[started.jobId].tabId, executionTabId);
  assert.deepEqual(navigatedUrls, [sourceUrl]);
  assert.deepEqual(executionResponses, [
    { error: 'Ambient capture is disabled in execution tabs', ok: false },
    { error: 'Ambient capture is disabled in execution tabs', ok: false },
  ]);
  assert.deepEqual(sourceSequence, { ok: true, sequence: 8 });
  assert.deepEqual(areas.session[lifecycleKey], {
    nextLayerSequence: 8,
    pending: { [executionTabId]: { observationId: 'obs_execution' } },
  });
  coordinator.onTabRemoved(executionTabId);
  await delay(5);
});
