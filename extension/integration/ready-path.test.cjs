'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const actorBootstrap = require('../actor/bootstrap.js');
const { DurableRunCoordinator, PORT_NAMES } = require('../coordinator/run-coordinator.js');
const sourceBootstrap = require('../source/bootstrap.js');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = '2026-09-03T12:00:00.000Z';
const SOURCE_URL = 'http://127.0.0.1:4317/demo/';
const fixturePath = path.resolve(
  __dirname,
  '../../documentation/contracts/examples/owned-storefront.action-list.json',
);

const clone = (value) => structuredClone(value);

const createChannel = () => {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    emit(value) { listeners.forEach((listener) => listener(value)); },
    removeListener(listener) { listeners.delete(listener); },
  };
};

const linkedPorts = (name, sender) => {
  const clientMessages = createChannel();
  const serverMessages = createChannel();
  const clientDisconnect = createChannel();
  const serverDisconnect = createChannel();
  const client = {
    name,
    onDisconnect: clientDisconnect,
    onMessage: clientMessages,
    disconnect() {
      clientDisconnect.emit();
      serverDisconnect.emit();
    },
    postMessage(message) {
      queueMicrotask(() => serverMessages.emit(clone(message)));
    },
  };
  const server = {
    name,
    sender,
    onDisconnect: serverDisconnect,
    onMessage: serverMessages,
    disconnect() {
      clientDisconnect.emit();
      serverDisconnect.emit();
    },
    postMessage(message) {
      queueMicrotask(() => clientMessages.emit(clone(message)));
    },
  };
  return { client, server };
};

class MemoryStorage {
  constructor() { this.runs = new Map(); }

  async list() { return [...this.runs.values()].map(clone); }

  async load(runId) { return this.runs.has(runId) ? clone(this.runs.get(runId)) : null; }

  async save(record) { this.runs.set(record.runId, clone(record)); }
}

class InactiveTabs {
  constructor() {
    this.created = [];
    this.removed = [];
    this.tabs = new Map();
  }

  async create(options) {
    const tab = { ...options, active: false, id: 101 };
    this.created.push(clone(tab));
    this.tabs.set(tab.id, clone(tab));
    return tab;
  }

  async findReusable() { return null; }

  async get(tabId) { return clone(this.tabs.get(tabId)); }

  async remove(tabId) { this.removed.push(tabId); this.tabs.delete(tabId); }
}

const publishedList = () => {
  const list = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  list.publication.status = 'published';
  list.publication.contentDigest = DIGEST;
  list.actions.forEach((action) => { action.lifecycle = 'published'; });
  return list;
};

test('published WebMCP tool executes through source, coordinator, and actor bridges', async () => {
  const list = publishedList();
  const storage = new MemoryStorage();
  const tabs = new InactiveTabs();
  const actorSteps = [];
  const registryCalls = [];
  let nextId = 1;
  const coordinator = new DurableRunCoordinator({
    clearTimer() {},
    now: () => NOW,
    observations: { async save() {} },
    randomId: () => `integration_${nextId++}`,
    registry: {
      async resolveExact(reference) {
        registryCalls.push(clone(reference));
        return { digest: DIGEST, list: clone(list) };
      },
    },
    setTimer: () => 1,
    storage,
    tabs,
    validateActionList: () => ({ valid: true }),
  });

  const sourceRuntime = {
    connect() {
      const ports = linkedPorts(PORT_NAMES.source, {
        documentId: 'source_document',
        tab: { id: 10, url: SOURCE_URL },
        url: SOURCE_URL,
      });
      coordinator.bindPort(ports.server);
      return ports.client;
    },
    sendMessage(_message, callback) { callback?.({ ok: true }); },
  };
  const actorRuntime = {
    connect() {
      const ports = linkedPorts(PORT_NAMES.execution, {
        documentId: 'execution_document',
        tab: { id: 101, url: SOURCE_URL },
        url: SOURCE_URL,
      });
      coordinator.bindPort(ports.server);
      return ports.client;
    },
  };
  const modelContext = {
    tool: null,
    async registerTool(tool) { this.tool = tool; },
  };
  const actor = {
    async detectStateId() { return 'catalog'; },
    async evaluateConditionSet() { return true; },
    async executeStep({ command }) {
      actorSteps.push(command.payload.step.id);
      return {
        type: 'step.completed',
        payload: {
          commandId: command.payload.commandId,
          effect: {
            navigationExpected: false,
            navigationObserved: false,
            postconditionSatisfied: true,
            stateAfter: 'catalog',
            stateBefore: 'catalog',
            urlAfter: SOURCE_URL,
            urlBefore: SOURCE_URL,
            urlChanged: false,
          },
          result: command.payload.step.op === 'extract'
            ? { count: 1, items: [{ name: 'Field H1' }] }
            : null,
          stepId: command.payload.step.id,
          stepIndex: command.payload.stepIndex,
        },
      };
    },
  };
  const actorBridge = actorBootstrap.createActorBridge({
    actor,
    documentObject: { location: { href: SOURCE_URL }, title: 'Instrument Supply' },
    now: () => NOW,
    runtime: actorRuntime,
  });
  const sourceBridge = sourceBootstrap.createSourceBridge({
    locationObject: { href: SOURCE_URL, origin: new URL(SOURCE_URL).origin },
    modelContext,
    now: () => new Date(NOW),
    randomId: () => 'integration_source',
    runtime: sourceRuntime,
    windowObject: { addEventListener() {}, navigation: { addEventListener() {} } },
  });

  actorBridge.start();
  await sourceBridge.registerActionLists([list]);
  const result = await modelContext.tool.execute({ query: 'headphones' });
  await new Promise((resolve) => { setImmediate(resolve); });
  const [run] = await storage.list();

  assert.deepEqual(result, { count: 1, items: [{ name: 'Field H1' }] });
  assert.deepEqual(actorSteps, [
    'fill_query',
    'submit_search',
    'wait_for_results',
    'extract_results',
  ]);
  assert.equal(registryCalls[0].revision, 1);
  assert.equal(run.status, 'completed');
  assert.equal(run.terminal.dispatched, true);
  assert.equal(tabs.created[0].active, false);
  assert.deepEqual(tabs.removed, [101]);
});
