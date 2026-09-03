'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  RUN_STATUSES,
  createRunRecord,
  transitionRun,
} = require('../run-state.js');
const {
  DurableRunCoordinator,
  MESSAGE_TYPES,
  PORT_NAMES,
} = require('../run-coordinator.js');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const START_TIME = '2026-09-03T12:00:00.000Z';
const SOURCE_URL = 'http://127.0.0.1:4317/demo/';
const RESULTS_URL = 'http://127.0.0.1:4317/demo/search?q=headphones';

const fixturePath = path.resolve(
  __dirname,
  '../../../documentation/contracts/examples/owned-storefront.action-list.json',
);

const clone = (value) => structuredClone(value);

const publishedList = () => {
  const list = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  list.publication.status = 'published';
  list.publication.contentDigest = DIGEST;
  list.actions.forEach((action) => { action.lifecycle = 'published'; });
  return list;
};

class FakePort {
  constructor(name, sender) {
    this.name = name;
    this.sender = sender;
    this.sent = [];
    this.messageListeners = [];
    this.disconnectListeners = [];
    this.disconnected = false;
    this.onMessage = {
      addListener: (listener) => { this.messageListeners.push(listener); },
    };
    this.onDisconnect = {
      addListener: (listener) => { this.disconnectListeners.push(listener); },
    };
  }

  postMessage(message) {
    this.sent.push(clone(message));
  }

  disconnect() {
    this.disconnected = true;
    this.disconnectListeners.forEach((listener) => listener());
  }
}

class FakeStorage {
  constructor() {
    this.runs = new Map();
    this.saves = [];
  }

  async list() {
    return [...this.runs.values()].map(clone);
  }

  async load(runId) {
    const run = this.runs.get(runId);
    return run ? clone(run) : null;
  }

  async save(record) {
    this.runs.set(record.runId, clone(record));
    this.saves.push(clone(record));
  }
}

class FakeTabs {
  constructor() {
    this.nextId = 101;
    this.tabs = new Map();
    this.created = [];
    this.removed = [];
  }

  async create(options) {
    const tab = { id: this.nextId, url: options.url, active: options.active };
    this.nextId += 1;
    this.tabs.set(tab.id, clone(tab));
    this.created.push(clone(tab));
    return clone(tab);
  }

  async findReusable({ excludeTabIds = [], origin }) {
    return [...this.tabs.values()].find((tab) => (
      tab.active === false
      && !excludeTabIds.includes(tab.id)
      && new URL(tab.url).origin === origin
    )) || null;
  }

  async get(tabId) {
    if (!this.tabs.has(tabId)) throw new Error('No such tab');
    return clone(this.tabs.get(tabId));
  }

  async remove(tabId) {
    this.removed.push(tabId);
    this.tabs.delete(tabId);
  }
}

const createClock = () => {
  let milliseconds = Date.parse(START_TIME);
  const timers = new Map();
  let nextTimer = 1;
  return {
    advance(amount) { milliseconds += amount; },
    clearTimer(timerId) { timers.delete(timerId); },
    now() { return new Date(milliseconds).toISOString(); },
    setTimer(callback, delay) {
      const timerId = nextTimer;
      nextTimer += 1;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
  };
};

const createIds = () => {
  let nextId = 1;
  return () => {
    const id = `id_${String(nextId).padStart(4, '0')}`;
    nextId += 1;
    return id;
  };
};

const sourceSender = (overrides = {}) => ({
  documentId: 'source_document_1',
  tab: { id: 10, url: SOURCE_URL },
  url: SOURCE_URL,
  ...overrides,
});

const executionSender = (tabId, documentId, url = SOURCE_URL) => ({
  documentId,
  tab: { id: tabId, url },
  url,
});

const sourcePort = (overrides) => new FakePort(PORT_NAMES.source, sourceSender(overrides));
const actorPort = (tabId, documentId, url) => new FakePort(
  PORT_NAMES.execution,
  executionSender(tabId, documentId, url),
);
const reviewPort = () => new FakePort(PORT_NAMES.review, { url: 'chrome-extension://test/review.html' });

const runRequest = (overrides = {}) => ({
  protocol: 'webmcp-run/1',
  type: MESSAGE_TYPES.runRequest,
  requestId: 'request_search_1',
  runId: null,
  sequence: 1,
  sentAt: START_TIME,
  sender: {
    context: 'source_content',
    documentId: 'source_document_1',
    tabId: 10,
  },
  payload: {
    actionId: 'search_products',
    actionVersion: 1,
    arguments: { query: 'headphones' },
    listId: 'owned_storefront',
    sourceUrl: SOURCE_URL,
  },
  ...overrides,
});

const pageReady = ({
  run,
  documentId,
  navigationSequence,
  sequence,
  stateId,
  url,
}) => ({
  protocol: 'webmcp-run/1',
  type: MESSAGE_TYPES.pageReady,
  requestId: run.requestId,
  runId: run.runId,
  sequence,
  sentAt: START_TIME,
  sender: {
    context: 'execution_content',
    documentId,
    tabId: run.execution.tabId,
  },
  payload: {
    navigationSequence,
    stateId,
    title: 'Instrument Supply',
    url,
  },
});

const completed = ({ run, command, documentId, sequence, result = null }) => ({
  protocol: 'webmcp-run/1',
  type: MESSAGE_TYPES.stepCompleted,
  requestId: run.requestId,
  runId: run.runId,
  sequence,
  sentAt: START_TIME,
  sender: {
    context: 'execution_content',
    documentId,
    tabId: run.execution.tabId,
  },
  payload: {
    commandId: command.payload.commandId,
    effect: {
      navigationExpected: false,
      navigationObserved: false,
      postconditionSatisfied: true,
      stateAfter: run.execution.stateId,
      stateBefore: run.execution.stateId,
      urlAfter: run.execution.url,
      urlBefore: run.execution.url,
      urlChanged: false,
    },
    result,
    stepId: command.payload.step.id,
    stepIndex: command.payload.stepIndex,
  },
});

const createHarness = ({
  list = publishedList(),
  authorize,
  afterPersist,
  storage = new FakeStorage(),
  tabs = new FakeTabs(),
  clock = createClock(),
  ids = createIds(),
  observations = { values: [], async save(value) { this.values.push(clone(value)); } },
} = {}) => {
  const registryCalls = [];
  const coordinator = new DurableRunCoordinator({
    afterPersist,
    authorize,
    clearTimer: clock.clearTimer,
    now: clock.now,
    observations,
    randomId: ids,
    registry: {
      async resolveExact(request) {
        registryCalls.push(clone(request));
        return { digest: DIGEST, list: clone(list) };
      },
    },
    setTimer: clock.setTimer,
    storage,
    tabs,
    validateActionList: () => ({ valid: true }),
    validateMessage: () => true,
  });
  return {
    clock,
    coordinator,
    ids,
    list,
    observations,
    registryCalls,
    storage,
    tabs,
  };
};

const bindAndSendRequest = async (harness, request = runRequest()) => {
  const port = sourcePort();
  const binding = harness.coordinator.bindPort(port);
  await harness.coordinator.receive(port, binding, request);
  const [run] = await harness.storage.list();
  return { port, run };
};

const bindActorAndReady = async (harness, run, {
  documentId = 'execution_document_1',
  navigationSequence = 0,
  sequence = 1,
  stateId = 'catalog',
  url = SOURCE_URL,
} = {}) => {
  const port = actorPort(run.execution.tabId, documentId, url);
  const binding = harness.coordinator.bindPort(port);
  await harness.coordinator.receive(port, binding, pageReady({
    documentId,
    navigationSequence,
    run,
    sequence,
    stateId,
    url,
  }));
  return { binding, port, run: await harness.storage.load(run.runId) };
};

test('the persisted record reducer permits only declared transitions', () => {
  const record = createRunRecord({
    deadlineAt: null,
    now: START_TIME,
    request: runRequest(),
    runId: 'run_test_1',
    source: { documentId: 'source_document_1', tabId: 10, url: SOURCE_URL },
  });
  const policyChecked = transitionRun(record, RUN_STATUSES.policyChecked, {}, START_TIME);
  const openingTab = transitionRun(policyChecked, RUN_STATUSES.openingTab, {}, START_TIME);
  assert.equal(openingTab.status, RUN_STATUSES.openingTab);
  assert.throws(
    () => transitionRun(openingTab, RUN_STATUSES.completed, {}, START_TIME),
    /Illegal run transition/,
  );
  assert.throws(
    () => transitionRun(openingTab, RUN_STATUSES.openingTab, {}, START_TIME),
    /Self-transition/,
  );
});

test('accepts a bound source request, pins the exact digest, and opens an inactive tab', async () => {
  const harness = createHarness();
  const { port, run } = await bindAndSendRequest(harness);

  assert.deepEqual(harness.registryCalls, [{
    actionId: 'search_products',
    actionVersion: 1,
    listId: 'owned_storefront',
  }]);
  assert.equal(run.listDigest, DIGEST);
  assert.equal(run.status, RUN_STATUSES.waitingForPage);
  assert.equal(harness.tabs.created.length, 1);
  assert.equal(harness.tabs.created[0].active, false);
  assert.equal(port.sent.length, 1);
  assert.equal(port.sent[0].type, MESSAGE_TYPES.runAccepted);
  assert.equal(port.sent[0].payload.planDigest, DIGEST);
});

test('rejects a source request whose claimed sender differs from the bound port', async () => {
  const harness = createHarness();
  const port = sourcePort();
  const binding = harness.coordinator.bindPort(port);
  await harness.coordinator.receive(port, binding, runRequest({
    sender: { context: 'source_content', documentId: 'forged', tabId: 10 },
  }));

  assert.equal((await harness.storage.list()).length, 0);
  assert.equal(harness.tabs.created.length, 0);
});

test('a forged actor document cannot terminate or advance a real run', async () => {
  const harness = createHarness();
  const { run: acceptedRun } = await bindAndSendRequest(harness);
  const ready = await bindActorAndReady(harness, acceptedRun);
  const command = ready.port.sent.at(-1);
  const forgedPort = actorPort(acceptedRun.execution.tabId, 'forged_document');
  const forgedBinding = harness.coordinator.bindPort(forgedPort);
  const forged = completed({
    command,
    documentId: 'forged_document',
    run: ready.run,
    sequence: 1,
  });
  forged.payload.commandId = command.payload.commandId;
  await harness.coordinator.receive(forgedPort, forgedBinding, forged);

  const unchanged = await harness.storage.load(acceptedRun.runId);
  assert.equal(unchanged.status, RUN_STATUSES.waitingForEffect);
  assert.equal(unchanged.stepIndex, 0);
  assert.equal(unchanged.terminal, null);
});

test('persists every command before dispatch and completes an event-driven run', async () => {
  const harness = createHarness();
  const { port: source, run: acceptedRun } = await bindAndSendRequest(harness);
  let { binding, port: actor, run } = await bindActorAndReady(harness, acceptedRun);
  const fillCommand = actor.sent.at(-1);

  const fillPersistence = harness.storage.saves.find((saved) => (
    saved.pendingCommand?.commandId === fillCommand.payload.commandId
    && saved.status === RUN_STATUSES.waitingForEffect
  ));
  assert.ok(fillPersistence);
  assert.ok(fillPersistence.pendingCommand.dispatchedAt);

  await harness.coordinator.receive(actor, binding, completed({
    command: fillCommand,
    documentId: 'execution_document_1',
    run,
    sequence: 2,
  }));
  run = await harness.storage.load(run.runId);
  const clickCommand = actor.sent.at(-1);
  assert.equal(clickCommand.payload.step.op, 'click');
  assert.equal(run.status, RUN_STATUSES.waitingForNavigation);

  const nextActor = actorPort(run.execution.tabId, 'execution_document_2', RESULTS_URL);
  const nextBinding = harness.coordinator.bindPort(nextActor);
  await harness.coordinator.receive(nextActor, nextBinding, pageReady({
    documentId: 'execution_document_2',
    navigationSequence: 1,
    run,
    sequence: 1,
    stateId: 'search_results',
    url: RESULTS_URL,
  }));
  run = await harness.storage.load(run.runId);
  const waitCommand = nextActor.sent.at(-1);
  assert.equal(waitCommand.payload.step.op, 'wait');

  await harness.coordinator.receive(nextActor, nextBinding, completed({
    command: waitCommand,
    documentId: 'execution_document_2',
    run,
    sequence: 2,
  }));
  run = await harness.storage.load(run.runId);
  const extractCommand = nextActor.sent.at(-1);
  assert.equal(extractCommand.payload.step.op, 'extract');

  await harness.coordinator.receive(nextActor, nextBinding, completed({
    command: extractCommand,
    documentId: 'execution_document_2',
    result: { count: 1, items: [{ name: 'Field H1' }] },
    run,
    sequence: 3,
  }));
  const terminal = await harness.storage.load(run.runId);

  assert.equal(terminal.status, RUN_STATUSES.completed);
  assert.equal(source.sent.filter(({ type }) => type === MESSAGE_TYPES.runResult).length, 1);
  assert.equal(harness.observations.values.length, 1);
  assert.equal(JSON.stringify(harness.observations.values).includes('headphones'), false);
  assert.equal(JSON.stringify(harness.observations.values).includes('Field H1'), false);
  assert.deepEqual(terminal.completedSteps, [
    'fill_query',
    'submit_search',
    'wait_for_results',
    'extract_results',
  ]);
  assert.equal(harness.tabs.removed.length, 1);
});

test('recovers after a persisted click and advances on a new document without repeating it', async () => {
  const shared = createHarness();
  const { port: source, run: acceptedRun } = await bindAndSendRequest(shared);
  let { binding, port: firstActor, run } = await bindActorAndReady(shared, acceptedRun);
  const fillCommand = firstActor.sent.at(-1);
  await shared.coordinator.receive(firstActor, binding, completed({
    command: fillCommand,
    documentId: 'execution_document_1',
    run,
    sequence: 2,
  }));
  run = await shared.storage.load(run.runId);
  const clickCommand = firstActor.sent.at(-1);
  assert.equal(clickCommand.payload.step.op, 'click');
  assert.equal(run.status, RUN_STATUSES.waitingForNavigation);

  const restarted = createHarness({
    clock: shared.clock,
    ids: shared.ids,
    observations: shared.observations,
    storage: shared.storage,
    tabs: shared.tabs,
  });
  restarted.coordinator.bindPort(source);
  await restarted.coordinator.recover();
  const secondActor = actorPort(run.execution.tabId, 'execution_document_2', RESULTS_URL);
  const secondBinding = restarted.coordinator.bindPort(secondActor);
  await restarted.coordinator.receive(secondActor, secondBinding, pageReady({
    documentId: 'execution_document_2',
    navigationSequence: 1,
    run,
    sequence: 1,
    stateId: 'search_results',
    url: RESULTS_URL,
  }));

  const postRestartCommands = secondActor.sent.filter(
    ({ type }) => type === MESSAGE_TYPES.stepCommand,
  );
  assert.equal(postRestartCommands.some(({ payload }) => (
    payload.commandId === clickCommand.payload.commandId || payload.step.op === 'click'
  )), false);
  assert.equal(postRestartCommands.at(-1).payload.step.id, 'wait_for_results');
  const recovered = await shared.storage.load(run.runId);
  assert.equal(recovered.stepIndex, 2);
  assert.deepEqual(recovered.completedSteps, ['fill_query', 'submit_search']);
});

test('deduplicates requests and actor events and emits one terminal result', async () => {
  const harness = createHarness();
  const { port: source, run: acceptedRun } = await bindAndSendRequest(harness);
  const binding = { documentId: 'source_document_1', tabId: 10, url: SOURCE_URL };
  await harness.coordinator.receive(source, binding, runRequest());
  assert.equal(harness.tabs.created.length, 1);

  let { binding: actorBinding, port: actor, run } = await bindActorAndReady(harness, acceptedRun);
  const fillCommand = actor.sent.at(-1);
  const fillCompleted = completed({
    command: fillCommand,
    documentId: 'execution_document_1',
    run,
    sequence: 2,
  });
  await harness.coordinator.receive(actor, actorBinding, fillCompleted);
  await harness.coordinator.receive(actor, actorBinding, fillCompleted);
  run = await harness.storage.load(run.runId);
  assert.equal(run.stepIndex, 1);
  assert.equal(actor.sent.filter(({ payload }) => payload.step?.op === 'click').length, 1);
});

test('blocks invalid arguments and revoked policy before opening a tab', async () => {
  const invalidHarness = createHarness();
  const invalid = runRequest();
  invalid.payload.arguments = { query: '' };
  const { run: invalidRun } = await bindAndSendRequest(invalidHarness, invalid);
  assert.equal(invalidRun.status, RUN_STATUSES.failed);
  assert.equal(invalidRun.error.code, 'INVALID_ARGUMENTS');
  assert.equal(invalidHarness.tabs.created.length, 0);

  const blockedHarness = createHarness({
    authorize: async () => ({ allowed: false, reasonCode: 'REVOKED' }),
  });
  const { run: blockedRun } = await bindAndSendRequest(blockedHarness);
  assert.equal(blockedRun.status, RUN_STATUSES.failed);
  assert.equal(blockedRun.error.code, 'POLICY_BLOCKED');
  assert.equal(blockedHarness.tabs.created.length, 0);
});

test('rejects digest mismatch, out-of-scope navigation, and actor step failure', async () => {
  const mismatchedList = publishedList();
  mismatchedList.publication.contentDigest = `sha256:${'b'.repeat(64)}`;
  const mismatchHarness = createHarness({ list: mismatchedList });
  const { run: mismatch } = await bindAndSendRequest(mismatchHarness);
  assert.equal(mismatch.status, RUN_STATUSES.failed);
  assert.equal(mismatch.error.code, 'PLAN_VERSION_MISMATCH');

  const navigationHarness = createHarness();
  const { run: navigationRun } = await bindAndSendRequest(navigationHarness);
  await bindActorAndReady(navigationHarness, navigationRun, {
    stateId: null,
    url: 'https://outside.example/path',
  });
  const navigationFailure = await navigationHarness.storage.load(navigationRun.runId);
  assert.equal(navigationFailure.error.code, 'NAVIGATION_OUT_OF_SCOPE');

  const actorHarness = createHarness();
  const { run: actorRun } = await bindAndSendRequest(actorHarness);
  const ready = await bindActorAndReady(actorHarness, actorRun);
  const command = ready.port.sent.at(-1);
  await actorHarness.coordinator.receive(ready.port, ready.binding, {
    protocol: 'webmcp-run/1',
    type: MESSAGE_TYPES.stepFailed,
    requestId: ready.run.requestId,
    runId: ready.run.runId,
    sequence: 2,
    sentAt: START_TIME,
    sender: {
      context: 'execution_content',
      documentId: 'execution_document_1',
      tabId: ready.run.execution.tabId,
    },
    payload: {
      commandId: command.payload.commandId,
      error: {
        code: 'TARGET_NOT_FOUND',
        message: 'Search box was not found',
        observed: { matchCount: 0 },
        retryable: false,
        stepId: 'fill_query',
      },
      stepId: 'fill_query',
      stepIndex: 0,
    },
  });
  const actorFailure = await actorHarness.storage.load(actorRun.runId);
  assert.equal(actorFailure.error.code, 'TARGET_NOT_FOUND');
  assert.equal(actorHarness.observations.values[0].steps[0].status, 'failed');
  assert.equal(JSON.stringify(actorHarness.observations.values).includes('Search box'), false);
});

test('enforces the step deadline independently of the action deadline', async () => {
  const harness = createHarness();
  const { run: acceptedRun } = await bindAndSendRequest(harness);
  const { run } = await bindActorAndReady(harness, acceptedRun);
  assert.equal(run.status, RUN_STATUSES.waitingForEffect);
  assert.ok(Date.parse(run.pendingCommand.deadlineAt) < Date.parse(run.deadlineAt));

  harness.clock.advance(run.action.steps[0].timeoutMs + 1);
  await harness.coordinator.timeout(run.runId);
  const terminal = await harness.storage.load(run.runId);
  assert.equal(terminal.error.code, 'TIMEOUT');
  assert.equal(terminal.error.stepId, 'fill_query');
});

test('keeps concurrent runs isolated on separate execution tabs', async () => {
  const harness = createHarness();
  const source = sourcePort();
  const binding = harness.coordinator.bindPort(source);
  await harness.coordinator.receive(source, binding, runRequest());
  await harness.coordinator.receive(source, binding, runRequest({
    requestId: 'request_search_2',
  }));

  const runs = await harness.storage.list();
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0].runId, runs[1].runId);
  assert.notEqual(runs[0].execution.tabId, runs[1].execution.tabId);
  assert.equal(harness.tabs.created.length, 2);
});

test('confirmation masks arguments, approves the exact step, and ignores stale intent', async () => {
  const list = publishedList();
  const action = list.actions[0];
  action.safety.class = 'write';
  action.safety.writesExternalState = true;
  action.safety.confirmation = 'before_step';
  action.safety.confirmationStepId = 'submit_search';
  action.safety.idempotency = 'conditional';
  action.safety.sensitiveArguments = ['query'];
  action.tool.annotations.readOnlyHint = false;
  const harness = createHarness({ list });
  const { run: acceptedRun } = await bindAndSendRequest(harness);
  let { binding, port: actor, run } = await bindActorAndReady(harness, acceptedRun);
  const fillCommand = actor.sent.at(-1);
  await harness.coordinator.receive(actor, binding, completed({
    command: fillCommand,
    documentId: 'execution_document_1',
    run,
    sequence: 2,
  }));
  run = await harness.storage.load(run.runId);
  assert.equal(run.status, RUN_STATUSES.awaitingConfirmation);
  assert.deepEqual(run.confirmation.argumentPreview, { query: '[redacted]' });

  const review = reviewPort();
  const reviewBinding = harness.coordinator.bindPort(review);
  const confirmation = {
    protocol: 'webmcp-run/1',
    type: MESSAGE_TYPES.runConfirm,
    requestId: run.requestId,
    runId: run.runId,
    sequence: 1,
    sentAt: START_TIME,
    sender: { context: 'review_ui', documentId: null, tabId: null },
    payload: { approved: true, stepId: 'submit_search' },
  };
  await harness.coordinator.receive(review, reviewBinding, confirmation);
  run = await harness.storage.load(run.runId);
  assert.equal(run.status, RUN_STATUSES.waitingForNavigation);
  assert.equal(actor.sent.at(-1).payload.step.id, 'submit_search');

  const stale = { ...confirmation, sequence: 2, payload: { approved: false, stepId: 'fill_query' } };
  await harness.coordinator.receive(review, reviewBinding, stale);
  run = await harness.storage.load(run.runId);
  assert.equal(run.status, RUN_STATUSES.waitingForNavigation);
  assert.equal(actor.sent.filter(({ payload }) => payload.step?.id === 'submit_search').length, 1);
});

test('a denied confirmation terminates without dispatching the guarded step', async () => {
  const list = publishedList();
  const action = list.actions[0];
  action.safety.class = 'write';
  action.safety.writesExternalState = true;
  action.safety.confirmation = 'before_step';
  action.safety.confirmationStepId = 'submit_search';
  action.safety.idempotency = 'unsafe';
  action.tool.annotations.readOnlyHint = false;
  const harness = createHarness({ list });
  const { run: acceptedRun } = await bindAndSendRequest(harness);
  let { binding, port: actor, run } = await bindActorAndReady(harness, acceptedRun);
  const fillCommand = actor.sent.at(-1);
  await harness.coordinator.receive(actor, binding, completed({
    command: fillCommand,
    documentId: 'execution_document_1',
    run,
    sequence: 2,
  }));
  run = await harness.storage.load(run.runId);

  const review = reviewPort();
  const reviewBinding = harness.coordinator.bindPort(review);
  await harness.coordinator.receive(review, reviewBinding, {
    protocol: 'webmcp-run/1',
    type: MESSAGE_TYPES.runConfirm,
    requestId: run.requestId,
    runId: run.runId,
    sequence: 1,
    sentAt: START_TIME,
    sender: { context: 'review_ui', documentId: null, tabId: null },
    payload: { approved: false, stepId: 'submit_search' },
  });
  const denied = await harness.storage.load(run.runId);
  assert.equal(denied.error.code, 'CONFIRMATION_DENIED');
  assert.equal(actor.sent.some(({ payload }) => payload.step?.id === 'submit_search'), false);
});

test('cancellation, timeout, tab closure, and source closure terminate once with typed errors', async () => {
  const cases = [
    {
      expected: 'CANCELLED',
      async trigger(harness, run) {
        const source = sourcePort();
        const binding = harness.coordinator.bindPort(source);
        await harness.coordinator.receive(source, binding, {
          protocol: 'webmcp-run/1',
          type: MESSAGE_TYPES.runCancel,
          requestId: run.requestId,
          runId: run.runId,
          sequence: 2,
          sentAt: START_TIME,
          sender: { context: 'source_content', documentId: 'source_document_1', tabId: 10 },
          payload: { reason: 'No longer needed' },
        });
      },
    },
    {
      expected: 'TIMEOUT',
      async trigger(harness, run) {
        harness.clock.advance(run.action.runtime.maxDurationMs + 1);
        await harness.coordinator.timeout(run.runId);
      },
    },
    {
      expected: 'EXECUTION_TAB_CLOSED',
      async trigger(harness, run) {
        await harness.coordinator.tabClosed(run.execution.tabId);
      },
    },
  ];

  for (const testCase of cases) {
    const harness = createHarness();
    const { run } = await bindAndSendRequest(harness);
    await testCase.trigger(harness, run);
    const terminal = await harness.storage.load(run.runId);
    assert.equal(terminal.error.code, testCase.expected);
    assert.equal(harness.observations.values.length, 1);
    await testCase.trigger(harness, terminal);
    assert.equal(harness.observations.values.length, 1);
  }

  const disconnectedHarness = createHarness();
  const { port, run } = await bindAndSendRequest(disconnectedHarness);
  port.disconnect();
  await new Promise((resolve) => { setImmediate(resolve); });
  const disconnected = await disconnectedHarness.storage.load(run.runId);
  assert.equal(disconnected.error.code, 'TRANSPORT_DISCONNECTED');
});

test('recovery resumes records suspended after each nonterminal persistence boundary', async () => {
  const targets = [
    RUN_STATUSES.created,
    RUN_STATUSES.policyChecked,
    RUN_STATUSES.openingTab,
  ];

  for (const target of targets) {
    const storage = new FakeStorage();
    const tabs = new FakeTabs();
    let suspended = false;
    const first = createHarness({
      afterPersist: async (record) => {
        if (!suspended && record.status === target) {
          suspended = true;
          throw new Error('simulated worker suspension');
        }
      },
      storage,
      tabs,
    });
    await bindAndSendRequest(first);
    const [interrupted] = await storage.list();
    assert.equal(interrupted.status, target);

    const restarted = createHarness({ storage, tabs });
    await restarted.coordinator.recover();
    const recovered = await storage.load(interrupted.runId);
    assert.equal(recovered.status, RUN_STATUSES.waitingForPage);
    assert.equal(tabs.created.length, 1);
  }
});

test('restart recovery reconciles waiting page, prepared dispatch, and pending effect states', async () => {
  const waitingPageHarness = createHarness();
  const { run: waitingPage } = await bindAndSendRequest(waitingPageHarness);
  const waitingPageRestart = createHarness({
    clock: waitingPageHarness.clock,
    ids: waitingPageHarness.ids,
    observations: waitingPageHarness.observations,
    storage: waitingPageHarness.storage,
    tabs: waitingPageHarness.tabs,
  });
  await waitingPageRestart.coordinator.recover();
  const readyAfterRestart = await bindActorAndReady(waitingPageRestart, waitingPage);
  assert.equal(readyAfterRestart.port.sent.at(-1).payload.step.id, 'fill_query');

  const dispatchStorage = new FakeStorage();
  const dispatchTabs = new FakeTabs();
  let suspended = false;
  const dispatchHarness = createHarness({
    afterPersist: async (record) => {
      if (!suspended && record.status === RUN_STATUSES.dispatchingStep) {
        suspended = true;
        throw new Error('simulated worker suspension');
      }
    },
    storage: dispatchStorage,
    tabs: dispatchTabs,
  });
  const { run: dispatchRun } = await bindAndSendRequest(dispatchHarness);
  const dispatchActor = actorPort(dispatchRun.execution.tabId, 'execution_document_1');
  const dispatchBinding = dispatchHarness.coordinator.bindPort(dispatchActor);
  await assert.rejects(
    dispatchHarness.coordinator.handlePageReady(
      dispatchRun,
      dispatchBinding,
      pageReady({
        documentId: 'execution_document_1',
        navigationSequence: 0,
        run: dispatchRun,
        sequence: 1,
        stateId: 'catalog',
        url: SOURCE_URL,
      }),
    ),
    /simulated worker suspension/,
  );
  const prepared = await dispatchStorage.load(dispatchRun.runId);
  assert.equal(prepared.status, RUN_STATUSES.dispatchingStep);
  assert.equal(dispatchActor.sent.length, 0);

  const dispatchRestart = createHarness({ storage: dispatchStorage, tabs: dispatchTabs });
  await dispatchRestart.coordinator.recover();
  const recoveredActor = actorPort(dispatchRun.execution.tabId, 'execution_document_1');
  dispatchRestart.coordinator.bindPort(recoveredActor);
  await new Promise((resolve) => { setImmediate(resolve); });
  const recoveredEffect = await dispatchStorage.load(dispatchRun.runId);
  assert.equal(recoveredEffect.status, RUN_STATUSES.waitingForEffect);
  assert.equal(recoveredActor.sent.at(-1).payload.commandId, prepared.pendingCommand.commandId);

  const effectHarness = createHarness();
  const { run: effectAccepted } = await bindAndSendRequest(effectHarness);
  const effectReady = await bindActorAndReady(effectHarness, effectAccepted);
  const originalCommand = effectReady.port.sent.at(-1);
  const effectRestart = createHarness({
    clock: effectHarness.clock,
    ids: effectHarness.ids,
    observations: effectHarness.observations,
    storage: effectHarness.storage,
    tabs: effectHarness.tabs,
  });
  await effectRestart.coordinator.recover();
  const effectActor = actorPort(effectAccepted.execution.tabId, 'execution_document_1');
  effectRestart.coordinator.bindPort(effectActor);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(effectActor.sent.length, 1);
  assert.equal(effectActor.sent[0].payload.commandId, originalCommand.payload.commandId);
});

test('restart recovery replays confirmation and extraction without creating new commands', async () => {
  const confirmationList = publishedList();
  confirmationList.actions[0].safety.class = 'write';
  confirmationList.actions[0].safety.writesExternalState = true;
  confirmationList.actions[0].safety.confirmation = 'before_run';
  confirmationList.actions[0].safety.confirmationStepId = null;
  confirmationList.actions[0].safety.idempotency = 'conditional';
  confirmationList.actions[0].tool.annotations.readOnlyHint = false;
  const confirmationHarness = createHarness({ list: confirmationList });
  const { run: confirmationRun } = await bindAndSendRequest(confirmationHarness);
  assert.equal(confirmationRun.status, RUN_STATUSES.awaitingConfirmation);

  const confirmationRestart = createHarness({
    list: confirmationList,
    storage: confirmationHarness.storage,
    tabs: confirmationHarness.tabs,
  });
  await confirmationRestart.coordinator.recover();
  const review = reviewPort();
  confirmationRestart.coordinator.bindPort(review);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(review.sent.length, 1);
  assert.equal(review.sent[0].type, MESSAGE_TYPES.runAwaitingConfirmation);
  assert.equal(review.sent[0].payload.stepId, 'fill_query');

  const extractionList = publishedList();
  extractionList.actions[0].steps = [
    extractionList.actions[0].steps[0],
    extractionList.actions[0].steps[3],
  ];
  const extractionHarness = createHarness({ list: extractionList });
  const { run: extractionAccepted } = await bindAndSendRequest(extractionHarness);
  let extractionReady = await bindActorAndReady(extractionHarness, extractionAccepted);
  const fillCommand = extractionReady.port.sent.at(-1);
  await extractionHarness.coordinator.receive(
    extractionReady.port,
    extractionReady.binding,
    completed({
      command: fillCommand,
      documentId: 'execution_document_1',
      run: extractionReady.run,
      sequence: 2,
    }),
  );
  const extracting = await extractionHarness.storage.load(extractionAccepted.runId);
  const extractCommand = extractionReady.port.sent.at(-1);
  assert.equal(extracting.status, RUN_STATUSES.extracting);

  const extractionRestart = createHarness({
    list: extractionList,
    storage: extractionHarness.storage,
    tabs: extractionHarness.tabs,
  });
  await extractionRestart.coordinator.recover();
  const extractionActor = actorPort(extractionAccepted.execution.tabId, 'execution_document_1');
  extractionRestart.coordinator.bindPort(extractionActor);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(extractionActor.sent.length, 1);
  assert.equal(extractionActor.sent[0].payload.commandId, extractCommand.payload.commandId);
});

test('source tab closure produces one transport failure', async () => {
  const harness = createHarness();
  const { run } = await bindAndSendRequest(harness);
  await harness.coordinator.tabClosed(run.source.tabId);
  await harness.coordinator.tabClosed(run.source.tabId);
  const failed = await harness.storage.load(run.runId);
  assert.equal(failed.error.code, 'TRANSPORT_DISCONNECTED');
  assert.equal(harness.observations.values.length, 1);
});

test('terminal recovery stores one observation and waits for the source before dispatch', async () => {
  const storage = new FakeStorage();
  const observations = { values: [], async save(value) { this.values.push(clone(value)); } };
  const harness = createHarness({ observations, storage });
  const { run } = await bindAndSendRequest(harness);
  await harness.coordinator.fail(run.runId, {
    code: 'INTERNAL_ERROR',
    message: 'simulated terminal state',
    observed: {},
    retryable: false,
    stepId: null,
  });
  let terminal = await storage.load(run.runId);
  terminal.terminal.dispatched = false;
  terminal.observationStored = false;
  await storage.save(terminal);
  observations.values.length = 0;

  const restarted = createHarness({ observations, storage, tabs: harness.tabs });
  await restarted.coordinator.recover();
  terminal = await storage.load(run.runId);
  assert.equal(terminal.terminal.dispatched, false);
  assert.equal(observations.values.length, 1);

  const port = sourcePort();
  restarted.coordinator.bindPort(port);
  await new Promise((resolve) => { setImmediate(resolve); });
  terminal = await storage.load(run.runId);
  assert.equal(terminal.terminal.dispatched, true);
  assert.equal(port.sent.filter(({ type }) => type === MESSAGE_TYPES.runError).length, 1);
});
