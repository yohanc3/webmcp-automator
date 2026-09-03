'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createReadyRuntime } = require('../ready-runtime.js');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const fixturePath = path.resolve(
  __dirname,
  '../../../documentation/contracts/examples/owned-storefront.action-list.json',
);

const publishedList = () => {
  const list = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  list.publication.status = 'published';
  list.publication.contentDigest = DIGEST;
  list.actions.forEach((action) => { action.lifecycle = 'published'; });
  return list;
};

const createHarness = (responses, runs = []) => {
  const requests = [];
  const received = [];
  const coordinator = {
    bindPort() { return {}; },
    async receive(_port, _binding, message) { received.push(message); return true; },
    async recover() {},
  };
  const storage = {
    async list() { return structuredClone(runs); },
    async load(runId) {
      return structuredClone(runs.find((run) => run.runId === runId) || null);
    },
  };
  const runtime = createReadyRuntime({
    chromeApi: { runtime: { getURL: () => 'chrome-extension://test/popup.html' } },
    coordinator,
    fetchApi: async (url) => {
      requests.push(url);
      const body = responses.shift();
      return {
        ok: true,
        async json() { return structuredClone(body); },
      };
    },
    localObservations: { async save() {} },
    observations: { async save() {} },
    storage,
    tabs: {},
  });
  return { received, requests, runtime };
};

test('discovery filters public lists and exact resolution fetches the immutable revision', async () => {
  const list = publishedList();
  const harness = createHarness([{ actionLists: [list] }, list]);
  const discovered = await harness.runtime.discoverActionLists({
    origin: 'http://127.0.0.1:4317',
    url: 'http://127.0.0.1:4317/demo/',
  });
  assert.equal(discovered.length, 1);

  const resolved = await harness.runtime.registry.resolveExact({
    actionId: 'search_products',
    actionVersion: 1,
    expectedDigest: DIGEST,
    listId: 'owned_storefront',
    revision: 1,
  });
  assert.equal(resolved.digest, DIGEST);
  assert.match(harness.requests[0], /\/v1\/action-lists\?origin=/);
  assert.match(harness.requests[1], /\/v1\/action-lists\/owned_storefront\/revisions\/1$/);
});

test('exact resolution rejects a revision whose digest no longer matches the registration', async () => {
  const list = publishedList();
  list.publication.contentDigest = `sha256:${'b'.repeat(64)}`;
  const harness = createHarness([list]);

  await assert.rejects(harness.runtime.registry.resolveExact({
    actionId: 'search_products',
    actionVersion: 1,
    expectedDigest: DIGEST,
    listId: 'owned_storefront',
    revision: 1,
  }), /exact published action/);
});

test('confirmation DTO preserves the exact page boundary through submission', async () => {
  const binding = {
    actorSequence: 2,
    boundary: 'before_step',
    confirmationId: 'confirmation_run_1_submit_search_1',
    documentId: 'execution_document_1',
    listDigest: DIGEST,
    navigationSequence: 0,
    origin: 'http://127.0.0.1:4317',
    pageRevision: 4,
    policyRevision: '2026-09-03T11:00:00.000Z',
    requestId: 'request_1',
    runId: 'run_1',
    stateId: 'catalog',
    stepId: 'submit_search',
    url: 'http://127.0.0.1:4317/demo/',
  };
  const run = {
    action: {
      safety: { class: 'write', sensitiveArguments: ['query'] },
      steps: [{ id: 'submit_search', op: 'click' }],
      tool: { title: 'Search products' },
    },
    arguments: { query: 'headphones' },
    confirmation: {
      argumentPreview: { query: '[redacted]' },
      binding,
      boundary: 'before_step',
      stepId: 'submit_search',
      summary: 'Approve search',
    },
    execution: {
      documentId: binding.documentId,
      navigationSequence: binding.navigationSequence,
      pageRevision: binding.pageRevision,
      stateId: binding.stateId,
      tabId: 101,
      url: binding.url,
    },
    lastAcceptedSequenceBySender: {
      'execution_content:101:execution_document_1': binding.actorSequence,
    },
    listDigest: DIGEST,
    listPolicy: {
      basis: 'reviewed_terms',
      checkedAt: binding.policyRevision,
      expiresAt: null,
      scopes: ['inject', 'write'],
      status: 'allowed',
    },
    policyDecision: { reasonCode: 'PUBLISHED_POLICY_ALLOWED' },
    requestId: 'request_1',
    runId: 'run_1',
    source: { documentId: 'source_document_1', tabId: 10, url: binding.url },
    status: 'awaiting_confirmation',
    updatedAt: '2026-09-03T12:00:00.000Z',
  };
  const harness = createHarness([], [run]);
  const state = await harness.runtime.getPolicyReviewState();

  assert.equal(state.confirmation.boundary, 'before_step');
  assert.deepEqual(state.confirmation.binding, binding);
  assert.equal(state.context.boundary, 'before_step');
  await harness.runtime.submitRunConfirmation({
    approved: false,
    binding: state.confirmation.binding,
    runId: run.runId,
    stepId: binding.stepId,
  });
  assert.equal(harness.received.length, 1);
  assert.equal(harness.received[0].payload.approved, false);
});

test('installs isolated replay port and tab-close hooks beside the ready coordinator', async () => {
  let connectListener;
  let removedListener;
  let recovered = 0;
  const bound = [];
  const closed = [];
  const replayPorts = [];
  const coordinator = {
    bindPort(port) { bound.push(port.name); return {}; },
    async recover() { recovered += 1; },
    async tabClosed(tabId) { closed.push(['ready', tabId]); },
  };
  const runtime = createReadyRuntime({
    chromeApi: {
      runtime: {
        getURL: () => 'chrome-extension://test/popup.html',
        onConnect: { addListener(listener) { connectListener = listener; } },
      },
      tabs: { onRemoved: { addListener(listener) { removedListener = listener; } } },
    },
    coordinator,
    localObservations: { async save() {} },
    observations: { async save() {} },
    portHandlers: { replay: (port) => replayPorts.push(port.name) },
    storage: { async list() { return []; }, async load() { return null; } },
    tabClosedHandlers: [(tabId) => { closed.push(['replay', tabId]); }],
    tabs: {},
  });

  runtime.start();
  connectListener({ name: 'replay' });
  connectListener({ name: 'webmcp-run/1:source' });
  removedListener(17);
  await new Promise((resolve) => { setImmediate(resolve); });

  assert.deepEqual(replayPorts, ['replay']);
  assert.deepEqual(bound, ['webmcp-run/1:review', 'webmcp-run/1:source']);
  assert.deepEqual(closed, [['ready', 17], ['replay', 17]]);
  assert.equal(recovered, 1);
});
