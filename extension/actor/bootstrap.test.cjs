'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const protocol = require('../shared/protocol.js');
const bootstrap = require('./bootstrap.js');

const FIXED_TIME = '2026-09-03T12:00:00.000Z';

const createChannel = () => {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    emit(value) { listeners.forEach((listener) => listener(value)); },
  };
};

const createPort = () => ({
  onDisconnect: createChannel(),
  onMessage: createChannel(),
  posted: [],
  disconnect() {},
  postMessage(message) { this.posted.push(structuredClone(message)); },
});

const createRuntime = () => ({
  ports: [],
  connect() {
    const port = createPort();
    this.ports.push(port);
    return port;
  },
});

const action = {
  id: 'search_products',
  version: 1,
  precondition: { checks: { mode: 'all', checks: [] } },
  runtime: { maxDurationMs: 5000 },
  steps: [{
    id: 'fill_query',
    op: 'fill',
    expect: { mode: 'all', checks: [] },
    timeoutMs: 250,
  }],
};

const binding = (lastAcceptedSequence = 7) => ({
  protocol: bootstrap.BINDING_PROTOCOL,
  type: bootstrap.BINDING_TYPE,
  requestId: 'request_1',
  runId: 'run_1',
  payload: {
    action,
    actionStartedAt: FIXED_TIME,
    arguments: { query: 'headphones' },
    documentId: 'document_1',
    lastAcceptedSequence,
    navigationSequence: 0,
    pendingStep: null,
    requiresPrecondition: true,
    states: [],
    tabId: 101,
  },
});

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

test('pins the coordinator binding and continues its durable actor sequence', async () => {
  const runtime = createRuntime();
  const calls = [];
  const actor = {
    async detectStateId() { calls.push('state'); return 'catalog'; },
    async evaluateConditionSet() { calls.push('condition'); return true; },
    async executeStep({ command }) {
      calls.push(command.payload.commandId);
      return {
        type: protocol.RUN_MESSAGE_TYPES.stepCompleted,
        payload: {
          commandId: command.payload.commandId,
          effect: {
            navigationExpected: false,
            navigationObserved: false,
            postconditionSatisfied: true,
            stateAfter: 'catalog',
            stateBefore: 'catalog',
            urlAfter: 'https://shop.example/catalog',
            urlBefore: 'https://shop.example/catalog',
            urlChanged: false,
          },
          result: null,
          stepId: 'fill_query',
          stepIndex: 0,
        },
      };
    },
  };
  const documentObject = {
    location: { href: 'https://shop.example/catalog' },
    title: 'Catalog',
  };
  const bridge = bootstrap.createActorBridge({
    actor,
    documentObject,
    now: () => FIXED_TIME,
    runtime,
  });
  bridge.start();
  const port = runtime.ports[0];
  port.onMessage.emit(binding());
  await flush();

  const ready = port.posted[0];
  assert.equal(ready.type, protocol.RUN_MESSAGE_TYPES.pageReady);
  assert.equal(ready.sequence, 8);
  assert.deepEqual(ready.payload, {
    navigationSequence: 0,
    pageRevision: 0,
    pendingStepSatisfied: null,
    preconditionSatisfied: true,
    stateId: 'catalog',
    title: 'Catalog',
    url: 'https://shop.example/catalog',
  });

  port.onMessage.emit(protocol.createEnvelope({
    type: protocol.RUN_MESSAGE_TYPES.stepCommand,
    requestId: 'request_1',
    runId: 'run_1',
    sequence: 2,
    sentAt: FIXED_TIME,
    sender: { context: 'service_worker', documentId: null, tabId: null },
    payload: {
      arguments: { query: 'headphones' },
      commandId: 'command_1',
      deadlineAt: '2026-09-03T12:00:01.000Z',
      step: action.steps[0],
      stepIndex: 0,
    },
  }));
  await flush();

  assert.equal(port.posted[1].type, protocol.RUN_MESSAGE_TYPES.stepCompleted);
  assert.equal(port.posted[1].sequence, 9);
  assert.equal(port.posted[1].payload.effect.pageRevisionAfter, 0);
  assert.deepEqual(calls, ['state', 'condition', 'command_1']);
});

test('a same-document reconnect resumes from the new durable sequence baseline', async () => {
  const runtime = createRuntime();
  const scheduled = [];
  const actor = {
    async detectStateId() { return null; },
    async evaluateConditionSet() { return true; },
    async executeStep() { throw new Error('unexpected command'); },
  };
  const bridge = bootstrap.createActorBridge({
    actor,
    documentObject: { location: { href: 'https://shop.example/' }, title: 'Shop' },
    runtime,
    schedule(callback) { scheduled.push(callback); return scheduled.length; },
  });
  bridge.start();
  runtime.ports[0].onMessage.emit(binding(3));
  await flush();
  assert.equal(runtime.ports[0].posted[0].sequence, 4);

  runtime.ports[0].onDisconnect.emit();
  scheduled.shift()();
  runtime.ports[1].onMessage.emit(binding(11));
  await flush();
  assert.equal(runtime.ports[1].posted[0].sequence, 12);
});

test('reports a document-local revision after observed DOM mutations', async () => {
  const runtime = createRuntime();
  let observer;
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observer = this;
    }

    observe() {}

    disconnect() {}
  }
  const bridge = bootstrap.createActorBridge({
    actor: {
      async detectStateId() { return 'catalog'; },
      async evaluateConditionSet() { return true; },
      async executeStep() { throw new Error('unexpected command'); },
    },
    documentObject: {
      documentElement: {},
      location: { href: 'https://shop.example/catalog' },
      title: 'Catalog',
    },
    MutationObserver: FakeMutationObserver,
    runtime,
  });
  bridge.start();
  observer.callback();
  runtime.ports[0].onMessage.emit(binding());
  await flush();

  assert.equal(runtime.ports[0].posted[0].payload.pageRevision, 1);
});
