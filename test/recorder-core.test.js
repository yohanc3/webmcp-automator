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

test('records deduplicated page maps and reconstructs an ordered transition path', () => {
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
  assert.equal(trace.schemaVersion, 'learning-trace/2');
  assert.deepEqual(trace.states.map(({ fingerprint }) => fingerprint), [
    'home',
    'query_entered',
    'results',
  ]);
  assert.deepEqual(trace.steps.map(({ sequence, event: observed }) => ({
    sequence,
    kind: observed.kind,
  })), [
    { sequence: 1, kind: 'fill' },
    { sequence: 2, kind: 'click' },
  ]);
  assert.equal(trace.steps[1].fromStateFingerprint, 'query_entered');
  assert.equal(trace.steps[1].toStateFingerprint, 'results');
  assert.deepEqual(trace.observedPath[1].transition, {
    urlChanged: true,
    beforeUrl: 'http://127.0.0.1:4317/demo/',
    afterUrl: 'http://127.0.0.1:4317/demo/search?q=headphones',
    addedNodes: 1,
    removedNodes: 0,
    changedNodes: 0,
    collectionsChanged: false,
  });
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
