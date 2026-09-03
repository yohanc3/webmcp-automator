'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createReplayRunner, deriveArguments, executableView, PORT_NAME, replayURLForAction,
} = require('./candidate-replay.js');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const action = {
  id: 'search_products', version: 3, lifecycle: 'candidate',
  tool: {
    inputSchema: {
      required: ['query', 'limit', 'exact'],
      properties: {
        query: { type: 'string' }, limit: { type: 'integer', minimum: 2 }, exact: { type: 'boolean' },
      },
    },
  },
  steps: [{ id: 'fill_query' }, { id: 'submit_search' }],
  precondition: { allowedStateIds: [], urlPatterns: ['^https://shop\\.example/search(?:\\?.*)?$'] },
  safety: { class: 'read', confirmation: 'before_run', confirmationStepId: 'fill_query' },
  runtime: { maxDurationMs: 5000 },
};
const list = {
  listId: 'shop_actions',
  site: { origin: 'https://shop.example', routePatterns: ['^/search(?:\\?.*)?$'] },
  publication: { status: 'candidate', revision: 3, contentDigest: null },
  policy: { status: 'unknown', scopes: [], checkedAt: '2026-09-03T00:00:00Z' },
  states: [], actions: [action],
};

test('derives deterministic local replay arguments without returning page values', () => {
  assert.deepEqual(deriveArguments(action, 'https://shop.example/search?q=headphones'), {
    exact: true, limit: 2, query: 'headphones',
  });
});

test('builds an executable replay-only view without mutating the candidate', () => {
  const view = executableView({ digest: DIGEST, list, now: () => '2026-09-03T12:00:00Z' });
  assert.equal(view.publication.status, 'published');
  assert.equal(view.actions[0].lifecycle, 'published');
  assert.equal(view.actions[0].safety.confirmation, 'none');
  assert.equal(list.actions[0].lifecycle, 'candidate');
});

test('selects a concrete start URL for each action in a multi-route candidate', () => {
  const routed = {
    ...action,
    precondition: {
      allowedStateIds: ['orders'],
      urlPatterns: ['^https://shop\\.example/orders(?:\\?.*)?$'],
    },
  };
  assert.equal(replayURLForAction(routed, {
    ...list,
    states: [{ id: 'orders', match: { checks: [{ kind: 'url', pattern: '^https://shop\\.example/orders(?:\\?.*)?$' }] } }],
  }, 'https://shop.example/catalog'), 'https://shop.example/orders');
  assert.throws(() => replayURLForAction({ ...routed, precondition: { urlPatterns: ['^https://shop\\.example/items/[0-9]+$'] } }, list, 'https://shop.example/catalog'), /no concrete start URL/);
});

test('uses the durable coordinator result to build complete replay coverage', async () => {
  const calls = [];
  const coordinator = {
    bindPort(port) { calls.push(['bind', port.name]); return {}; },
    async receive(port, _binding, message) {
      calls.push(['receive', message.type]);
      port.postMessage({
        type: 'run.result',
        payload: { evidence: { completedSteps: ['fill_query', 'submit_search'] } },
      });
      return true;
    },
  };
  const runner = createReplayRunner({
    coordinator,
    randomId: () => '00000000-0000-4000-8000-000000000001',
    tabs: {},
  });
  const report = await runner.runCandidate({
    digest: DIGEST, list, sourceTabId: 7,
    sourceUrl: 'https://shop.example/search?q=headphones',
  });
  assert.deepEqual(report.actions, [{
    actionId: 'search_products', actionVersion: 3,
    postconditionsVerified: 2, stepsExecuted: 2,
  }]);
  assert.deepEqual(calls, [['bind', 'webmcp-run/1:source'], ['receive', 'run.request']]);

  const port = {
    name: PORT_NAME, sender: { documentId: 'doc', tab: { id: 9 }, url: 'https://shop.example' },
    onDisconnect: { addListener() {} }, onMessage: { addListener() {} },
    disconnect() {}, postMessage() {},
  };
  runner.bindPort(port);
  assert.equal(calls.at(-1)[1], 'webmcp-run/1:execution');
});
