'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createExecutionClient, PORT_NAME } = require('./client.js');

const listeners = () => {
  const values = new Set();
  return {
    addListener(value) { values.add(value); },
    emit(value) { values.forEach((listener) => listener(value)); },
    removeListener(value) { values.delete(value); },
  };
};

const harness = () => {
  const onMessage = listeners();
  const onDisconnect = listeners();
  const sent = [];
  const port = { disconnect() {}, onDisconnect, onMessage, postMessage(value) { sent.push(value); } };
  const calls = [];
  const actor = {
    async detectStateId(input) { calls.push(['state', input.states]); return 'search_results'; },
    async executeStep(input) {
      calls.push(['step', input.command.payload.commandId]);
      return {
        type: 'step.completed',
        payload: {
          commandId: input.command.payload.commandId,
          stepId: input.command.payload.step.id,
          stepIndex: input.command.payload.stepIndex,
          effect: {
            navigationExpected: false, navigationObserved: false,
            postconditionSatisfied: true, stateAfter: 'basket_added',
            stateBefore: 'search_results', urlAfter: 'http://127.0.0.1:4317/demo/search?q=headphones',
            urlBefore: 'http://127.0.0.1:4317/demo/search?q=headphones', urlChanged: false,
          },
          result: null,
        },
      };
    },
  };
  const runtime = { connect(options) { calls.push(['connect', options.name]); return port; } };
  const client = createExecutionClient({
    actor,
    documentObject: { title: 'Search results' },
    locationObject: { href: 'http://127.0.0.1:4317/demo/search?q=headphones' },
    now: () => '2026-09-03T12:00:00.000Z',
    runtime,
    sessionStorage: { getItem: () => null, setItem() {} },
    windowObject: { addEventListener() {} },
  });
  return { actor, calls, client, onMessage, port, sent };
};

const envelope = (type, payload) => ({
  protocol: 'webmcp-run/1', type, requestId: 'request_1', runId: 'run_1', sequence: 1,
  sentAt: '2026-09-03T12:00:00.000Z',
  sender: { context: 'service_worker', documentId: null, tabId: null }, payload,
});

test('connects one execution port and reports page readiness after pinned initialization', async () => {
  const value = harness();
  assert.equal(value.client.start(), true);
  assert.equal(value.calls[0][1], PORT_NAME);
  value.onMessage.emit(envelope('execution.initialize', {
    action: { id: 'add_field_h1_to_basket' }, states: [{ id: 'search_results' }],
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.sent[0].type, 'page.ready');
  assert.equal(value.sent[0].payload.stateId, 'search_results');
});

test('executes a correlated pinned command and replays its cached outcome once per delivery', async () => {
  const value = harness();
  value.client.start();
  value.onMessage.emit(envelope('execution.initialize', {
    action: { id: 'add_field_h1_to_basket' }, states: [{ id: 'search_results' }],
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const command = envelope('step.command', {
    arguments: {}, commandId: 'command_1', step: { id: 'add_field_h1', op: 'click' }, stepIndex: 0,
  });
  value.onMessage.emit(command);
  await new Promise((resolve) => setImmediate(resolve));
  value.onMessage.emit(command);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.calls.filter(([kind]) => kind === 'step').length, 1);
  assert.deepEqual(value.sent.slice(1).map(({ type }) => type), ['step.completed', 'step.completed']);
  assert.deepEqual(value.sent.map(({ sequence }) => sequence), [1, 2, 3]);
});

test('reconnects after a coordinator port restart and waits for a fresh pinned plan', async () => {
  const ports = [];
  const timers = [];
  const actor = {
    async detectStateId() { return 'search_results'; },
    async executeStep() { throw new Error('a command must not execute before initialization'); },
  };
  const runtime = {
    connect() {
      const port = {
        onDisconnect: listeners(), onMessage: listeners(), sent: [],
        disconnect() {}, postMessage(value) { this.sent.push(value); },
      };
      ports.push(port);
      return port;
    },
  };
  const client = createExecutionClient({
    actor,
    documentObject: { title: 'Search results' },
    locationObject: { href: 'http://127.0.0.1:4317/demo/search?q=headphones' },
    reconnectDelayMs: 100,
    runtime,
    sessionStorage: { getItem: () => null, setItem() {} },
    setTimer(callback) { timers.push(callback); return callback; },
    clearTimer() {},
    windowObject: { addEventListener() {} },
  });

  client.start();
  ports[0].onDisconnect.emit();
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.equal(ports.length, 2);
  ports[1].onMessage.emit(envelope('step.command', {
    arguments: {}, commandId: 'command_stale', step: { id: 'add_field_h1', op: 'click' }, stepIndex: 0,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ports[1].sent.length, 0);
  ports[1].onMessage.emit(envelope('execution.initialize', {
    action: { id: 'add_field_h1_to_basket' }, states: [{ id: 'search_results' }],
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ports[1].sent[0].type, 'page.ready');
});
