(() => {
  'use strict';

  const results = [];
  const equal = (actual, expected) => {
    if (actual !== expected) {
      throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  const deepEqual = (actual, expected) => {
    const actualJSON = JSON.stringify(actual);
    const expectedJSON = JSON.stringify(expected);
    if (actualJSON !== expectedJSON) {
      throw new Error(`expected ${expectedJSON}, got ${actualJSON}`);
    }
  };
  const match = (actual, pattern) => {
    if (!pattern.test(actual)) {
      throw new Error(`expected ${JSON.stringify(actual)} to match ${pattern}`);
    }
  };
  const test = (name, body) => {
    try {
      body();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: error.message });
    }
  };

  const locator = (css = null) => ({
    css,
    role: null,
    name: null,
    placeholder: null,
    text: null,
    hrefContains: null,
  });

  const adapter = () => ({
    schemaVersion: 'learned-adapter/1',
    usable: true,
    site: {
      origin: 'https://example.com',
      routePatterns: ['/search'],
    },
    tool: {
      name: 'search_products',
      description: 'Search products',
      safety: 'read',
      parameters: [{
        name: 'query',
        description: 'Search query',
        type: 'string',
        required: true,
      }],
      steps: [{
        op: 'fill',
        target: locator('#search'),
        valueFrom: 'query',
        literalValue: null,
        key: null,
        expectNavigation: false,
        timeoutMs: 5000,
      }],
      output: {
        mode: 'page',
        collectionRoot: locator(),
        item: locator(),
        limit: 10,
        fields: [],
      },
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
    },
    confidence: 0.9,
    evidence: 'Recorded once',
    issues: [],
  });

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

  const manifest = globalThis.WebMcpManifest;
  const recorder = globalThis.ActionMapperRecorder;

  test('validates a deterministic learned adapter', () => {
    equal(manifest.validateManifest(adapter()).valid, true);
  });

  test('rejects an unknown schema version', () => {
    const candidate = adapter();
    candidate.schemaVersion = 'learned-adapter/99';
    const validation = manifest.validateManifest(candidate);
    equal(validation.valid, false);
    match(validation.errors.join(' '), /schemaVersion/);
  });

  test('builds WebMCP input schema and respects route scope', () => {
    const candidate = adapter();
    deepEqual(manifest.buildInputSchema(candidate.tool), {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
      additionalProperties: false,
    });
    equal(manifest.manifestMatchesLocation(
      candidate,
      'https://example.com/search?q=microphone',
    ), true);
    equal(manifest.manifestMatchesLocation(candidate, 'https://example.com/cart'), false);
  });

  test('emits a stepped trace and directed action graph', () => {
    const home = pageState('home', 'http://127.0.0.1:4317/demo/');
    const queryEntered = pageState('query_entered', 'http://127.0.0.1:4317/demo/');
    const searchURL = 'http://127.0.0.1:4317/demo/search?q=headphones';
    const searchResults = pageState(
      'results',
      searchURL,
      [{ identity: 'article|product', name: 'Field H1' }],
    );
    let recording = recorder.createRecording({
      id: 'recording-1',
      tabId: 7,
      state: home,
      startedAt: '2026-09-02T12:00:00.000Z',
    });

    recording = recorder.beginEvent(recording, event('fill-1', 'fill', 'Search catalog'), home);
    recording = recorder.completeEvent(
      recording,
      'fill-1',
      queryEntered,
      delta(home, queryEntered, { changed: [{ before: {}, after: {} }] }),
    );
    recording = recorder.beginEvent(
      recording,
      event('click-1', 'click', 'Search'),
      queryEntered,
    );
    recording = recorder.completeNavigation(
      recording,
      searchResults,
      (before, after) => delta(before, after, { added: after.nodes }),
    );
    recording = recorder.finishRecording(
      recording,
      searchResults,
      '2026-09-02T12:00:05.000Z',
    );

    const trace = recorder.toTrace(recording);
    equal(trace.schemaVersion, 'learning-trace/3');
    deepEqual(trace.frames.map(({ type }) => type), [
      'page',
      'action',
      'update',
      'page',
      'action',
      'update',
      'page',
    ]);
    equal(trace.frames[0].page.id, 'page_1');
    equal(trace.frames[1].action.kind, 'fill');
    equal(trace.frames[2].actionId, trace.frames[1].action.id);
    equal(trace.frames[3].page.id, 'page_2');
    equal(trace.frames[4].fromPageId, 'page_2');
    equal(trace.frames[5].toPageId, 'page_3');
    equal(trace.frames[6].page.url, searchURL);
    equal(trace.actionTree.rootPageId, 'page_1');
    equal(trace.actionTree.finalPageId, 'page_3');
    equal(trace.actionTree.transitions.length, 2);
    deepEqual(trace.actionTree.transitions[1], {
      id: 'transition_2',
      fromPageId: 'page_2',
      actionId: 'action_2',
      actionFrameSequence: 5,
      updateFrameSequence: 6,
      toPageId: 'page_3',
    });
    equal(JSON.stringify(trace).includes('semanticXml'), false);
  });

  test('keeps event order when completions arrive out of order', () => {
    const first = pageState('first', 'https://shop.example/');
    const second = pageState('second', 'https://shop.example/');
    let recording = recorder.createRecording({
      id: 'recording-2',
      tabId: 9,
      state: first,
      startedAt: '2026-09-02T12:00:00.000Z',
    });
    recording = recorder.beginEvent(recording, event('one', 'fill', 'Search'), first);
    recording = recorder.beginEvent(recording, event('two', 'click', 'Submit'), first);
    recording = recorder.completeEvent(recording, 'two', second, delta(first, second));
    recording = recorder.completeEvent(recording, 'one', second, delta(first, second));
    deepEqual(recording.steps.map(({ event: observed }) => observed.id), ['one', 'two']);
  });

  test('normalizes focus clicks and repeated fills', () => {
    const first = pageState('first', 'https://shop.example/');
    const second = pageState('second', 'https://shop.example/');
    const third = pageState('third', 'https://shop.example/');
    const searchTarget = {
      id: 'search',
      name: 'Search',
      role: 'searchbox',
      css: '#search',
    };
    let recording = recorder.createRecording({
      id: 'recording-3',
      tabId: 10,
      state: first,
      startedAt: '2026-09-02T12:00:00.000Z',
    });
    recording = recorder.beginEvent(recording, {
      ...event('focus', 'click', 'Search'),
      target: searchTarget,
    }, first);
    recording = recorder.completeEvent(recording, 'focus', first, delta(first, first));
    recording = recorder.beginEvent(recording, {
      ...event('fill-1', 'fill', 'Search'),
      target: searchTarget,
    }, first);
    recording = recorder.completeEvent(recording, 'fill-1', second, delta(first, second));
    recording = recorder.beginEvent(recording, {
      ...event('fill-2', 'fill', 'Search'),
      target: searchTarget,
    }, second);
    recording = recorder.completeEvent(recording, 'fill-2', third, delta(second, third));

    const normalized = recorder.normalizeSteps(recording);
    equal(normalized.length, 1);
    equal(normalized[0].event.id, 'fill-2');
    equal(normalized[0].fromStateFingerprint, 'first');
    equal(normalized[0].toStateFingerprint, 'third');
  });

  test('reuses a page when an action keeps the same semantic state', () => {
    const page = pageState('same', 'https://shop.example/');
    let recording = recorder.createRecording({
      id: 'recording-4',
      tabId: 11,
      state: page,
      startedAt: '2026-09-02T12:00:00.000Z',
    });
    recording = recorder.beginEvent(recording, event('fill', 'fill', 'Search'), page);
    recording = recorder.completeEvent(recording, 'fill', page, delta(page, page));
    recording = recorder.finishRecording(recording, page, '2026-09-02T12:00:02.000Z');

    const trace = recorder.toTrace(recording);
    deepEqual(trace.frames.map(({ type }) => type), ['page', 'action', 'update', 'page']);
    deepEqual(trace.frames[3].page, {
      id: 'page_1',
      fingerprint: 'same',
      reused: true,
    });
    equal(trace.actionTree.transitions[0].fromPageId, 'page_1');
    equal(trace.actionTree.transitions[0].toPageId, 'page_1');
  });

  const failures = results.filter(({ passed }) => !passed);
  document.body.dataset.status = failures.length === 0 ? 'passed' : 'failed';
  document.querySelector('#summary').textContent = failures.length === 0
    ? `${results.length} tests passed.`
    : `${failures.length} of ${results.length} tests failed.`;
  const list = document.querySelector('#results');
  results.forEach((result) => {
    const item = document.createElement('li');
    item.textContent = result.passed
      ? `PASS — ${result.name}`
      : `FAIL — ${result.name}: ${result.error}`;
    list.append(item);
  });
})();
