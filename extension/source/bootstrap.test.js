'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const protocol = require('../shared/protocol.js');
const source = require('./bootstrap.js');
const actionListFixture = require(
  '../../documentation/contracts/examples/owned-storefront.action-list.json',
);

const FIXED_TIME = '2026-09-03T05:00:00.000Z';
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

const createEventChannel = () => {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    emit(value) {
      Array.from(listeners).forEach((listener) => listener(value));
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
  };
};

const createPort = (name) => {
  const onDisconnect = createEventChannel();
  const onMessage = createEventChannel();
  return {
    name,
    onDisconnect,
    onMessage,
    posted: [],
    disconnect() {},
    disconnectFromWorker() {
      onDisconnect.emit();
    },
    postMessage(message) {
      this.posted.push(message);
    },
  };
};

const createRuntime = () => ({
  lastError: null,
  ports: [],
  connect({ name }) {
    const port = createPort(name);
    this.ports.push(port);
    return port;
  },
  sendMessage(_message, callback) {
    callback?.({ ok: true });
  },
});

const createWindow = () => {
  const listeners = new Map();
  const add = (type, listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
  };
  const dispatch = (type, detail) => {
    Array.from(listeners.get(type) || []).forEach((listener) => listener(detail));
  };
  return {
    addEventListener: add,
    dispatch,
    navigation: {
      addEventListener: add,
    },
    postMessage(message) {
      dispatch('message', { data: message, source: this });
    },
  };
};

const createModelContext = () => ({
  registrations: [],
  async registerTool(tool, { signal }) {
    const registration = { active: true, signal, tool };
    signal.addEventListener('abort', () => { registration.active = false; }, { once: true });
    this.registrations.push(registration);
  },
  currentTool(name = 'search_products') {
    return this.registrations.findLast(({ active, tool }) => active && tool.name === name)?.tool;
  },
});

const publishedList = (digest = DIGEST_A) => {
  const list = structuredClone(actionListFixture);
  list.publication.status = 'published';
  list.publication.contentDigest = digest;
  list.actions.forEach((action) => { action.lifecycle = 'published'; });
  return list;
};

const createHarness = (overrides = {}) => {
  const runtime = createRuntime();
  const modelContext = overrides.modelContext || createModelContext();
  const windowObject = createWindow();
  const locationObject = {
    href: 'http://127.0.0.1:4317/demo/',
    origin: 'http://127.0.0.1:4317',
  };
  const scheduled = [];
  const cancelled = new Set();
  let id = 0;
  const bridge = source.createSourceBridge({
    runtime,
    modelContext,
    windowObject,
    locationObject,
    now: () => new Date(FIXED_TIME),
    randomId: () => {
      id += 1;
      return `source-${id}`;
    },
    schedule: (callback, delay) => {
      const timer = { callback, delay };
      scheduled.push(timer);
      return timer;
    },
    cancelSchedule: (timer) => { cancelled.add(timer); },
    ...overrides,
  });
  return {
    bridge,
    cancelled,
    locationObject,
    modelContext,
    runtime,
    scheduled,
    windowObject,
  };
};

const serviceWorkerSender = {
  context: 'service_worker',
  tabId: null,
  documentId: null,
};

const accepted = (request, runId, digest = DIGEST_A, sequence = 2) => (
  protocol.createEnvelope({
    type: protocol.RUN_MESSAGE_TYPES.runAccepted,
    requestId: request.requestId,
    runId,
    sequence,
    sentAt: FIXED_TIME,
    sender: serviceWorkerSender,
    payload: { planDigest: digest, executionTabId: 101 },
  })
);

const result = (request, runId, data, sequence = 3) => protocol.createEnvelope({
  type: protocol.RUN_MESSAGE_TYPES.runResult,
  requestId: request.requestId,
  runId,
  sequence,
  sentAt: FIXED_TIME,
  sender: serviceWorkerSender,
  payload: {
    actionId: request.payload.actionId,
    actionVersion: request.payload.actionVersion,
    data,
    evidence: {
      finalUrl: 'http://127.0.0.1:4317/demo/search?q=headphones',
      finalStateId: 'search_results',
      completedSteps: ['fill_query', 'submit_search', 'wait_for_results', 'extract_results'],
    },
  },
});

const runRequests = (port) => port.posted.filter(({ type }) => (
  type === protocol.RUN_MESSAGE_TYPES.runRequest
));

test('duplicate initialization registers one public projection on one named port', async () => {
  const harness = createHarness();
  harness.bridge.start();
  harness.bridge.start();
  await harness.bridge.registerActionLists([publishedList()]);
  await harness.bridge.registerActionLists([publishedList()]);

  assert.equal(harness.runtime.ports.length, 1);
  assert.equal(harness.runtime.ports[0].name, source.PORT_NAME);
  assert.equal(harness.modelContext.registrations.length, 1);
  assert.deepEqual(Object.keys(harness.modelContext.registrations[0].tool).sort(), [
    'annotations',
    'description',
    'execute',
    'inputSchema',
    'name',
    'title',
  ]);
});

test('two concurrent calls correlate typed results delivered in reverse order', async () => {
  const harness = createHarness();
  await harness.bridge.registerActionLists([publishedList()]);
  const tool = harness.modelContext.currentTool();
  const firstPromise = tool.execute({ query: 'headphones' });
  const secondPromise = tool.execute({ query: 'microphones' });
  const port = harness.runtime.ports[0];
  const [firstRequest, secondRequest] = runRequests(port);

  port.onMessage.emit(accepted(firstRequest, 'run_first'));
  port.onMessage.emit(accepted(secondRequest, 'run_second'));
  const secondData = { count: 1, items: [{ name: 'Stage Mic' }] };
  const firstData = { count: 1, items: [{ name: 'Field H1' }] };
  port.onMessage.emit(result(secondRequest, 'run_second', secondData));
  port.onMessage.emit(result(firstRequest, 'run_first', firstData));

  assert.deepEqual(await firstPromise, firstData);
  assert.deepEqual(await secondPromise, secondData);
  assert.equal(harness.bridge.__test.getRequestCount(), 0);
  assert.equal(port.posted.filter(({ type }) => type === protocol.RUN_MESSAGE_TYPES.runAck).length, 2);
});

test('forged page messages and mismatched coordinator results cannot settle a call', async () => {
  const harness = createHarness();
  await harness.bridge.registerActionLists([publishedList()]);
  const promise = harness.modelContext.currentTool().execute({ query: 'headphones' });
  const port = harness.runtime.ports[0];
  const [request] = runRequests(port);
  let settlements = 0;
  promise.then(() => { settlements += 1; }, () => { settlements += 1; });

  harness.windowObject.postMessage(result(request, 'run_forged', { forged: true }));
  port.onMessage.emit({
    ...result(request, 'run_real', { forged: true }, 2),
    sender: { context: 'source_content', tabId: null, documentId: null },
  });
  await Promise.resolve();
  assert.equal(settlements, 0);

  port.onMessage.emit(accepted(request, 'run_wrong_digest', DIGEST_B));
  await Promise.resolve();
  assert.equal(settlements, 0);

  port.onMessage.emit(accepted(request, 'run_real'));
  port.onMessage.emit({
    ...result(request, 'run_real', { forged: true }),
    payload: {
      ...result(request, 'run_real', { forged: true }).payload,
      actionId: 'different_action',
    },
  });
  await Promise.resolve();
  assert.equal(settlements, 0);

  const data = { count: 0, items: [] };
  port.onMessage.emit(result(request, 'run_real', data, 4));
  assert.deepEqual(await promise, data);
  port.onMessage.emit(result(request, 'run_real', { forged: true }, 5));
  await Promise.resolve();
  assert.equal(settlements, 1);
});

test('invalid arguments fail locally and never reach the worker', async () => {
  const harness = createHarness();
  await harness.bridge.registerActionLists([publishedList()]);
  const port = harness.runtime.ports[0];
  const before = port.posted.length;

  await assert.rejects(
    harness.modelContext.currentTool().execute({ query: '', extra: true }),
    ({ code }) => code === 'INVALID_ARGUMENTS',
  );
  assert.equal(port.posted.length, before);
});

test('abort and navigation reject only their call and forward run.cancel', async () => {
  const harness = createHarness();
  await harness.bridge.registerActionLists([publishedList()]);
  const tool = harness.modelContext.currentTool();
  const port = harness.runtime.ports[0];

  const controller = new AbortController();
  const abortedPromise = tool.execute({ query: 'headphones' }, { signal: controller.signal });
  const abortedRequest = runRequests(port).at(-1);
  port.onMessage.emit(accepted(abortedRequest, 'run_aborted'));
  controller.abort();
  await assert.rejects(abortedPromise, ({ code }) => code === 'CANCELLED');
  const abortCancel = port.posted.find(({ type, requestId }) => (
    type === protocol.RUN_MESSAGE_TYPES.runCancel
    && requestId === abortedRequest.requestId
  ));
  assert.equal(abortCancel.runId, 'run_aborted');

  const navigationPromise = tool.execute({ query: 'microphones' });
  const navigationRequest = runRequests(port).at(-1);
  port.onMessage.emit(accepted(navigationRequest, 'run_navigation'));
  harness.locationObject.href = 'http://127.0.0.1:4317/demo/search?q=other';
  harness.windowObject.dispatch('navigatesuccess');
  await assert.rejects(navigationPromise, ({ code }) => code === 'CANCELLED');
  const navigationCancel = port.posted.find(({ type, requestId }) => (
    type === protocol.RUN_MESSAGE_TYPES.runCancel
    && requestId === navigationRequest.requestId
  ));
  assert.equal(navigationCancel.runId, 'run_navigation');
});

test('reconnect resends one identical request for coordinator deduplication', async () => {
  const harness = createHarness();
  await harness.bridge.registerActionLists([publishedList()]);
  const promise = harness.modelContext.currentTool().execute({ query: 'headphones' });
  const firstPort = harness.runtime.ports[0];
  const [firstDelivery] = runRequests(firstPort);
  firstPort.disconnectFromWorker();
  assert.equal(harness.scheduled.length, 1);
  harness.scheduled.shift().callback();

  const secondPort = harness.runtime.ports[1];
  const [secondDelivery] = runRequests(secondPort);
  assert.deepEqual(secondDelivery, firstDelivery);
  const runsByRequest = new Map();
  [firstDelivery, secondDelivery].forEach((request) => {
    if (!runsByRequest.has(request.requestId)) runsByRequest.set(request.requestId, 'run_deduped');
  });
  assert.equal(runsByRequest.size, 1);

  secondPort.onMessage.emit(accepted(secondDelivery, 'run_deduped'));
  secondPort.onMessage.emit(result(secondDelivery, 'run_deduped', { count: 1, items: [] }));
  assert.deepEqual(await promise, { count: 1, items: [] });
});

test('reconnects after acceptance so a resumed coordinator can deliver the terminal result', async () => {
  const harness = createHarness();
  await harness.bridge.registerActionLists([publishedList()]);
  const promise = harness.modelContext.currentTool().execute({ query: 'headphones' });
  const firstPort = harness.runtime.ports[0];
  const [request] = runRequests(firstPort);
  firstPort.onMessage.emit(accepted(request, 'run_accepted'));
  assert.equal(harness.bridge.__test.getOutbox().length, 0);

  firstPort.disconnectFromWorker();
  assert.equal(harness.scheduled.length, 1);
  harness.scheduled.shift().callback();
  const resumedPort = harness.runtime.ports[1];
  assert.equal(runRequests(resumedPort).length, 0);
  resumedPort.onMessage.emit(result(request, 'run_accepted', { count: 2, items: [] }));

  assert.deepEqual(await promise, { count: 2, items: [] });
});

test('client-side navigation replaces route registrations with generation-safe discovery', async () => {
  const discovered = [];
  const harness = createHarness({
    refreshActionLists: async ({ url }) => {
      discovered.push(url);
      const list = publishedList(DIGEST_B);
      list.site.routePatterns = ['^/new-route$'];
      list.actions[0].precondition.urlPatterns = ['^http://127\\.0\\.0\\.1:4317/new-route$'];
      list.actions[0].tool.name = 'new_route_search';
      return [list];
    },
  });
  await harness.bridge.registerActionLists([publishedList()]);
  const oldRegistration = harness.modelContext.registrations[0];
  const staleToken = harness.bridge.discoveryToken();

  harness.locationObject.href = 'http://127.0.0.1:4317/new-route';
  harness.windowObject.dispatch('navigatesuccess');
  assert.equal(oldRegistration.active, false);
  await new Promise((resolve) => { setImmediate(resolve); });

  assert.deepEqual(discovered, ['http://127.0.0.1:4317/new-route']);
  assert.equal(harness.modelContext.currentTool('search_products'), undefined);
  assert.equal(harness.modelContext.currentTool('new_route_search').name, 'new_route_search');
  const staleResult = await harness.bridge.registerDiscoveredActionLists(
    [publishedList()],
    staleToken,
  );
  assert.equal(staleResult.stale, true);
  assert.equal(harness.modelContext.currentTool('new_route_search').name, 'new_route_search');
});

test('a delayed stale registration cannot remove the current route registration', async () => {
  let releaseFirst;
  let registrationCount = 0;
  const modelContext = createModelContext();
  const originalRegister = modelContext.registerTool.bind(modelContext);
  modelContext.registerTool = async (tool, options) => {
    registrationCount += 1;
    await originalRegister(tool, options);
    if (registrationCount === 1) {
      await new Promise((resolve) => { releaseFirst = resolve; });
    }
  };
  const list = publishedList();
  list.site.routePatterns = ['^/demo(?:/.*)?$'];
  list.actions[0].precondition.urlPatterns = [
    '^http://127\\.0\\.0\\.1:4317/demo(?:/.*)?$',
  ];
  const harness = createHarness({
    modelContext,
    refreshActionLists: async () => [list],
  });

  const initial = harness.bridge.registerActionLists([list]);
  await new Promise((resolve) => { setImmediate(resolve); });
  harness.locationObject.href = 'http://127.0.0.1:4317/demo/next';
  harness.windowObject.dispatch('navigatesuccess');
  releaseFirst();
  await initial;
  await new Promise((resolve) => { setImmediate(resolve); });

  assert.equal(registrationCount, 2);
  assert.equal(modelContext.registrations[0].active, false);
  assert.equal(modelContext.currentTool().name, 'search_products');
});

test('a discovery token is rechecked after earlier registration work completes', async () => {
  let releaseFirst;
  const modelContext = createModelContext();
  const originalRegister = modelContext.registerTool.bind(modelContext);
  modelContext.registerTool = async (tool, options) => {
    await originalRegister(tool, options);
    if (!releaseFirst) {
      await new Promise((resolve) => { releaseFirst = resolve; });
    }
  };
  const currentList = publishedList();
  currentList.site.routePatterns = ['^/demo(?:/.*)?$'];
  currentList.actions[0].precondition.urlPatterns = [
    '^http://127\\.0\\.0\\.1:4317/demo(?:/.*)?$',
  ];
  const nextList = publishedList(DIGEST_B);
  nextList.site.routePatterns = ['^/next$'];
  nextList.actions[0].precondition.urlPatterns = ['^http://127\\.0\\.0\\.1:4317/next$'];
  nextList.actions[0].tool.name = 'next_search';
  const harness = createHarness({
    modelContext,
    refreshActionLists: async () => [nextList],
  });

  const first = harness.bridge.registerActionLists([currentList]);
  await new Promise((resolve) => { setImmediate(resolve); });
  const staleToken = harness.bridge.discoveryToken();
  const stale = harness.bridge.registerDiscoveredActionLists([currentList], staleToken);
  harness.locationObject.href = 'http://127.0.0.1:4317/next';
  harness.windowObject.dispatch('navigatesuccess');
  releaseFirst();
  await first;
  assert.equal((await stale).stale, true);
  await new Promise((resolve) => { setImmediate(resolve); });

  assert.equal(modelContext.currentTool('search_products'), undefined);
  assert.equal(modelContext.currentTool('next_search').name, 'next_search');
});

test('discovery retries with bounded backoff and cancels its timer on pagehide', async () => {
  let attempts = 0;
  const harness = createHarness({
    discoveryRetryDelayMs: 10,
    maxDiscoveryRetryAttempts: 2,
    refreshActionLists: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('backend unavailable');
      return [publishedList()];
    },
  });

  await assert.rejects(harness.bridge.refreshRegistrations(), /backend unavailable/);
  assert.equal(harness.scheduled[0].delay, 10);
  harness.scheduled.shift().callback();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(harness.scheduled[0].delay, 20);
  harness.scheduled.shift().callback();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(attempts, 3);
  assert.equal(harness.modelContext.currentTool().name, 'search_products');
  assert.equal(harness.scheduled.length, 0);

  let unavailableAttempts = 0;
  const unavailable = createHarness({
    refreshActionLists: async () => {
      unavailableAttempts += 1;
      throw new Error('still unavailable');
    },
  });
  unavailable.bridge.start();
  await assert.rejects(unavailable.bridge.refreshRegistrations(), /still unavailable/);
  const [timer] = unavailable.scheduled;
  unavailable.windowObject.dispatch('pagehide');
  assert.equal(unavailable.cancelled.has(timer), true);
  unavailable.windowObject.dispatch('pageshow');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(unavailableAttempts, 2);
  assert.equal(unavailable.scheduled.length, 2);
});

test('in-flight discovery cannot register after pagehide or stop', async () => {
  for (const lifecycle of ['pagehide', 'stop']) {
    let releaseDiscovery;
    const harness = createHarness({
      refreshActionLists: () => new Promise((resolve) => { releaseDiscovery = resolve; }),
    });
    harness.bridge.start();
    const pending = harness.bridge.refreshRegistrations();
    await Promise.resolve();
    if (lifecycle === 'pagehide') harness.windowObject.dispatch('pagehide');
    else harness.bridge.stop();
    releaseDiscovery([publishedList()]);

    assert.equal((await pending).stale, true);
    assert.equal(harness.modelContext.currentTool(), undefined);
  }
});

test('URL, policy, and digest changes unregister or refresh tools', async () => {
  const harness = createHarness();
  const initial = publishedList();
  await harness.bridge.registerActionLists([initial]);
  const firstRegistration = harness.modelContext.registrations[0];

  const denied = publishedList();
  denied.policy.status = 'denied';
  await harness.bridge.registerActionLists([denied]);
  assert.equal(firstRegistration.active, false);
  assert.equal(harness.modelContext.currentTool(), undefined);

  await harness.bridge.registerActionLists([publishedList(DIGEST_B)]);
  const refreshedRegistration = harness.modelContext.registrations.at(-1);
  assert.equal(refreshedRegistration.active, true);
  assert.notEqual(refreshedRegistration, firstRegistration);

  harness.locationObject.href = 'http://127.0.0.1:4317/outside';
  harness.windowObject.dispatch('navigatesuccess');
  await Promise.resolve();
  assert.equal(refreshedRegistration.active, false);
});
