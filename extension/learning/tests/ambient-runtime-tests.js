'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ambientRuntime = require('../ambient-runtime.js');
const coordinatorApi = require('../../coordinator/bootstrap.js');
const retrySpool = require('../retry-spool.js');

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
    fetchApi: async () => ({ json: async () => ({ outcome: 'no_change', requestId: 'receipt_1' }), ok: true, status: 200 }),
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
  const runtime = ambientRuntime.createRuntime({ chromeApi, documentApi: fakeDocument(), fetchApi: async () => null, observer, windowApi: fakeWindow() });
  assert.equal((await runtime.start()).attached, false);
  chromeApi.storage.onChanged.callback({ 'ambientPolicy:https://shop.test': { newValue: policy() } }, 'local');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.controller.status().attached, true);
});

test('pagehide carries only an unresolved trusted navigation once into the recreated document', async () => {
  const chromeApi = fakeChrome([policy(), policy(), policy(), policy()]);
  const firstWindow = fakeWindow();
  let navigation = { kind: 'click', observationId: 'obs_real', targetEvidenceId: 'node_link' };
  const firstObserver = {
    attach() { return { consumeNavigation: () => { const value = navigation; navigation = null; return value; }, disconnect() {} }; },
    async captureInitial() { return projection(); },
  };
  const first = ambientRuntime.createRuntime({ chromeApi, documentApi: fakeDocument(), fetchApi: async () => null, observer: firstObserver, windowApi: firstWindow });
  await first.start();
  firstWindow.emit('pagehide');
  await new Promise((resolve) => setImmediate(resolve));
  const second = ambientRuntime.createRuntime({ chromeApi, documentApi: fakeDocument(), fetchApi: async () => null, observer: fakeObserver(), windowApi: fakeWindow() });
  await second.start();
  const enqueued = chromeApi.calls.filter(({ type, operation }) => type === 'AMBIENT_SPOOL_OPERATION' && operation === 'enqueue');
  assert.equal(enqueued.at(-1).payload.completedLayer.observation.observationId, 'obs_real');
  assert.equal(enqueued.at(-1).payload.completedLayer.observation.kind, 'click');
  firstWindow.emit('pagehide');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(chromeApi.calls.filter(({ type }) => type === 'AMBIENT_PUT_PENDING').length, 1);
});

test('denied policy never attaches, while a later fresh allow attaches without reload', async () => {
  const chromeApi = fakeChrome([policy({ status: 'denied', scopes: [] }), policy()]);
  const observer = fakeObserver();
  const runtime = ambientRuntime.createRuntime({ chromeApi, documentApi: fakeDocument(), fetchApi: async () => null, observer, windowApi: fakeWindow() });
  assert.equal((await runtime.start()).attached, false);
  assert.equal(observer.options, undefined);
  assert.equal((await runtime.start()).attached, true);
  assert.equal(observer.options !== undefined, true);
});

test('classifies only explicit terminal delivery receipts as deletable', async () => {
  for (const outcome of ['applied', 'duplicate', 'no_change', 'rejected']) {
    assert.deepEqual(await ambientRuntime.classify({ json: async () => ({ outcome }), ok: true, status: 200 }), { outcome, receiptId: null });
  }
  assert.deepEqual(await ambientRuntime.classify({ json: async () => ({}), ok: false, status: 409 }), { outcome: 'conflict', receiptId: null });
  await assert.rejects(() => ambientRuntime.classify({ json: async () => null, ok: false, status: 500 }));
  await assert.rejects(() => ambientRuntime.classify({ json: async () => ({}), ok: true, status: 200 }));
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
    type: 'SET_OWNED_DEMO_OVERRIDE', override: { enabled: false, origin: 'https://wrong.test' },
  }, sender)));
  assert.deepEqual(saved.map(({ policy: value }) => value.revision), [1, 2, 3]);
  assert.equal(saved.at(-1).policy.status, 'revoked');
  assert.equal(saved.at(-1).policy.origin, 'https://shop.test');
  const sequences = await Promise.all([1, 2, 3, 4].map(() => coordinator.handleMessage({
    type: 'AMBIENT_NEXT_LAYER_SEQUENCE', scopeId: 'shop_scope',
  }, sender)));
  assert.deepEqual(sequences.map(({ sequence }) => sequence), [1, 2, 3, 4]);
  await coordinator.handleMessage({ type: 'AMBIENT_PUT_PENDING', scopeId: 'shop_scope', documentId: 'ignored', pending: { observationId: 'obs_1' } }, sender);
  assert.deepEqual((await coordinator.handleMessage({ type: 'AMBIENT_CONSUME_PENDING', scopeId: 'shop_scope', documentId: 'ignored' }, sender)).pending, { observationId: 'obs_1' });
  assert.equal((await coordinator.handleMessage({ type: 'AMBIENT_CONSUME_PENDING', scopeId: 'shop_scope', documentId: 'ignored' }, sender)).pending, null);
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
  assert.equal(connection.consumeNavigation().kind, 'submit');
  assert.equal(connection.consumeNavigation(), null);
  connection.disconnect();
  windowApi.emit('popstate');
});
