'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createChromeObservationStore,
  createChromeRunStorage,
  createChromeTabs,
  installChromeCoordinator,
} = require('../chrome-adapters.js');

const clone = (value) => structuredClone(value);

const createArea = () => {
  const values = {};
  return {
    async get(key) {
      return { [key]: clone(values[key]) };
    },
    async set(update) {
      Object.assign(values, clone(update));
    },
    values,
  };
};

test('Chrome run storage serializes concurrent saves without losing independent runs', async () => {
  const area = createArea();
  const storage = createChromeRunStorage(area);
  await Promise.all([
    storage.save({ runId: 'run_a', status: 'created' }),
    storage.save({ runId: 'run_b', status: 'created' }),
  ]);

  const runs = await storage.list();
  assert.deepEqual(runs.map(({ runId }) => runId).sort(), ['run_a', 'run_b']);
  assert.equal((await storage.load('run_a')).status, 'created');
});

test('Chrome observation storage keeps a bounded diagnostic history', async () => {
  const area = createArea();
  const observations = createChromeObservationStore(area);
  for (let index = 0; index < 505; index += 1) {
    await observations.save({ runId: `run_${index}` });
  }

  assert.equal(area.values.webMcpRunObservations.length, 500);
  assert.equal(area.values.webMcpRunObservations[0].runId, 'run_5');
});

test('Chrome tab adapter reuses only coordinator-owned inactive tabs not already in use', async () => {
  const area = createArea();
  const browserTabs = new Map();
  let nextId = 1;
  const chromeApi = {
    tabs: {
      async create(options) {
        const tab = { id: nextId, ...options };
        nextId += 1;
        browserTabs.set(tab.id, tab);
        return tab;
      },
      async get(tabId) {
        return browserTabs.get(tabId);
      },
      async query() {
        return [
          ...browserTabs.values(),
          { id: 99, active: false, url: 'https://example.com/private' },
        ];
      },
      async remove(tabId) {
        browserTabs.delete(tabId);
      },
    },
  };
  const tabs = createChromeTabs(chromeApi, area);
  const created = await tabs.create({ active: true, url: 'https://example.com/start' });

  assert.equal(created.active, false);
  assert.equal((await tabs.findReusable({ origin: 'https://example.com' })).id, created.id);
  assert.equal(await tabs.findReusable({
    excludeTabIds: [created.id],
    origin: 'https://example.com',
  }), null);
  await tabs.remove(created.id);
  assert.deepEqual(area.values.webMcpCoordinatorTabs, []);
});

test('Chrome installer wires ports, tab removal, and startup recovery once invoked', async () => {
  const listeners = { connect: null, removed: null };
  const calls = [];
  const chromeApi = {
    runtime: {
      onConnect: { addListener(listener) { listeners.connect = listener; } },
    },
    tabs: {
      onRemoved: { addListener(listener) { listeners.removed = listener; } },
    },
  };
  const coordinator = {
    bindPort(port) { calls.push(['port', port.name]); },
    async recover() { calls.push(['recover']); },
    async tabClosed(tabId) { calls.push(['tab', tabId]); },
  };
  installChromeCoordinator({ chromeApi, coordinator });
  listeners.connect({ name: 'webmcp-run/1:source' });
  listeners.removed(7);
  await new Promise((resolve) => { setImmediate(resolve); });

  assert.deepEqual(calls, [
    ['recover'],
    ['port', 'webmcp-run/1:source'],
    ['tab', 7],
  ]);
});
