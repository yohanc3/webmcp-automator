'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Recorder = require('../extension/recorder-core');

const pageState = (fingerprint, url, nodes = []) => ({
  capturedAt: '2026-09-02T12:00:00.000Z',
  fingerprint,
  url,
  origin: 'http://127.0.0.1:4317',
  title: 'Instrument Supply',
  viewport: {
    width: 1280,
    height: 800,
    scrollX: 0,
    scrollY: 0,
  },
  nodes,
  collections: [],
  semanticXml: '<page>removed before model transmission</page>',
  truncated: false,
});

const event = (id, kind, name) => ({
  id,
  kind,
  occurredAt: '2026-09-02T12:00:01.000Z',
  target: { name, role: kind === 'fill' ? 'searchbox' : 'button' },
  value: { redacted: false, value: kind === 'fill' ? 'headphones' : null },
});

const delta = (before, after, changes = {}) => ({
  urlChanged: before.url !== after.url,
  beforeUrl: before.url,
  afterUrl: after.url,
  titleChanged: false,
  beforeTitle: before.title,
  afterTitle: after.title,
  added: changes.added || [],
  removed: changes.removed || [],
  changed: changes.changed || [],
  collectionsChanged: changes.collectionsChanged || false,
  collections: after.collections,
  beforeFingerprint: before.fingerprint,
  afterFingerprint: after.fingerprint,
});

test('emits the stepped page, action, update, page trace and its action tree', () => {
  const home = pageState('home', 'http://127.0.0.1:4317/demo/');
  const queryEntered = pageState('query_entered', 'http://127.0.0.1:4317/demo/');
  const results = pageState(
    'results',
    'http://127.0.0.1:4317/demo/search?q=headphones',
    [{ identity: 'article|product', name: 'Field H1' }],
  );
  let recording = Recorder.createRecording({
    id: 'recording-1',
    tabId: 7,
    state: home,
    startedAt: '2026-09-02T12:00:00.000Z',
  });

  recording = Recorder.beginEvent(recording, event('fill-1', 'fill', 'Search catalog'), home);
  recording = Recorder.completeEvent(
    recording,
    'fill-1',
    queryEntered,
    delta(home, queryEntered, { changed: [{ before: {}, after: {} }] }),
  );
  recording = Recorder.beginEvent(
    recording,
    event('click-1', 'click', 'Search'),
    queryEntered,
  );
  recording = Recorder.completeNavigation(
    recording,
    results,
    (before, after) => delta(before, after, { added: after.nodes }),
  );
  recording = Recorder.finishRecording(
    recording,
    results,
    '2026-09-02T12:00:05.000Z',
  );

  const trace = Recorder.toTrace(recording);
  assert.equal(trace.schemaVersion, 'learning-trace/3');
  assert.deepEqual(trace.frames.map(({ type }) => type), [
    'page',
    'action',
    'update',
    'page',
    'action',
    'update',
    'page',
  ]);
  assert.equal(trace.frames[0].page.id, 'page_1');
  assert.equal(trace.frames[1].action.kind, 'fill');
  assert.equal(trace.frames[2].actionId, trace.frames[1].action.id);
  assert.equal(trace.frames[3].page.id, 'page_2');
  assert.equal(trace.frames[4].fromPageId, 'page_2');
  assert.equal(trace.frames[5].toPageId, 'page_3');
  assert.equal(trace.frames[6].page.url, 'http://127.0.0.1:4317/demo/search?q=headphones');
  assert.equal(trace.actionTree.rootPageId, 'page_1');
  assert.equal(trace.actionTree.finalPageId, 'page_3');
  assert.equal(trace.actionTree.transitions.length, 2);
  assert.deepEqual(trace.actionTree.transitions[1], {
    id: 'transition_2',
    fromPageId: 'page_2',
    actionId: 'action_2',
    actionFrameSequence: 5,
    updateFrameSequence: 6,
    toPageId: 'page_3',
  });
  assert.equal(JSON.stringify(trace).includes('semanticXml'), false);
});

test('keeps event order when completion messages arrive out of order', () => {
  const first = pageState('first', 'https://shop.example/');
  const second = pageState('second', 'https://shop.example/');
  let recording = Recorder.createRecording({
    id: 'recording-2',
    tabId: 9,
    state: first,
    startedAt: '2026-09-02T12:00:00.000Z',
  });
  recording = Recorder.beginEvent(recording, event('one', 'fill', 'Search'), first);
  recording = Recorder.beginEvent(recording, event('two', 'click', 'Submit'), first);
  recording = Recorder.completeEvent(recording, 'two', second, delta(first, second));
  recording = Recorder.completeEvent(recording, 'one', second, delta(first, second));

  assert.deepEqual(recording.steps.map(({ event: observed }) => observed.id), ['one', 'two']);
});

test('normalizes focus clicks and repeated fills before building the trace', () => {
  const first = pageState('first', 'https://shop.example/');
  const second = pageState('second', 'https://shop.example/');
  const third = pageState('third', 'https://shop.example/');
  const searchTarget = {
    id: 'search',
    name: 'Search',
    role: 'searchbox',
    css: '#search',
  };
  const noChange = delta(first, first);
  let recording = Recorder.createRecording({
    id: 'recording-3',
    tabId: 10,
    state: first,
    startedAt: '2026-09-02T12:00:00.000Z',
  });

  recording = Recorder.beginEvent(recording, {
    ...event('focus', 'click', 'Search'),
    target: searchTarget,
  }, first);
  recording = Recorder.completeEvent(recording, 'focus', first, noChange);
  recording = Recorder.beginEvent(recording, {
    ...event('fill-1', 'fill', 'Search'),
    target: searchTarget,
  }, first);
  recording = Recorder.completeEvent(recording, 'fill-1', second, delta(first, second));
  recording = Recorder.beginEvent(recording, {
    ...event('fill-2', 'fill', 'Search'),
    target: searchTarget,
  }, second);
  recording = Recorder.completeEvent(recording, 'fill-2', third, delta(second, third));

  const normalized = Recorder.normalizeSteps(recording);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].event.id, 'fill-2');
  assert.equal(normalized[0].fromStateFingerprint, 'first');
  assert.equal(normalized[0].toStateFingerprint, 'third');
});

test('uses a page reference when an action keeps the same semantic state', () => {
  const page = pageState('same', 'https://shop.example/');
  let recording = Recorder.createRecording({
    id: 'recording-4',
    tabId: 11,
    state: page,
    startedAt: '2026-09-02T12:00:00.000Z',
  });
  recording = Recorder.beginEvent(recording, event('fill', 'fill', 'Search'), page);
  recording = Recorder.completeEvent(recording, 'fill', page, delta(page, page));
  recording = Recorder.finishRecording(recording, page, '2026-09-02T12:00:02.000Z');

  const trace = Recorder.toTrace(recording);
  assert.deepEqual(trace.frames.map(({ type }) => type), ['page', 'action', 'update', 'page']);
  assert.deepEqual(trace.frames[3].page, {
    id: 'page_1',
    fingerprint: 'same',
    reused: true,
  });
  assert.equal(trace.actionTree.transitions[0].fromPageId, 'page_1');
  assert.equal(trace.actionTree.transitions[0].toPageId, 'page_1');
});
