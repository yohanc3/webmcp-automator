(() => {
  'use strict';

  const {
    assert: { deepEqual, equal, match },
    run,
    test,
  } = ExtensionTest;

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

  test('exposes frozen compatibility messages and canonical run envelopes', () => {
    const protocol = globalThis.WebMcpProtocol;
    equal(Object.isFrozen(protocol.MESSAGE_TYPES), true);
    deepEqual(protocol.createMessage(protocol.MESSAGE_TYPES.startJob, { jobId: 'job_1' }), {
      type: 'START_JOB',
      jobId: 'job_1',
    });
    deepEqual(protocol.createEnvelope({
      type: protocol.RUN_MESSAGE_TYPES.runAccepted,
      requestId: 'request_1',
      runId: 'run_1',
      sequence: 2,
      sentAt: '2026-09-02T12:00:00.000Z',
      sender: { context: 'service_worker', tabId: null, documentId: null },
      payload: { planDigest: 'sha256:test', executionTabId: 7 },
    }), {
      protocol: 'webmcp-run/1',
      type: 'run.accepted',
      requestId: 'request_1',
      runId: 'run_1',
      sequence: 2,
      sentAt: '2026-09-02T12:00:00.000Z',
      sender: { context: 'service_worker', tabId: null, documentId: null },
      payload: { planDigest: 'sha256:test', executionTabId: 7 },
    });
  });

  test('keeps legacy public errors string-only', () => {
    deepEqual(WebMcpErrors.legacyResponseFor(new Error('legacy failure')), {
      ok: false,
      error: 'legacy failure',
    });
    equal(WebMcpErrors.cancellationError().name, 'AbortError');
  });

  test('loads thin roots without starting adapter registration', () => {
    equal(typeof WebMcpLearningBootstrap.handleMessage, 'function');
    equal(typeof WebMcpSourceBootstrap.handleMessage, 'function');
    equal(typeof WebMcpCoordinatorBootstrap.start, 'function');
    deepEqual(chrome.__test.sentMessages.map(({ type }) => type), ['PAGE_READY']);
    equal(chrome.__test.runtimeListeners.length, 2);
    equal(chrome.__test.tabRemovedListeners.length, 1);
  });

  test('preserves learning message routing return values', () => {
    let response;
    equal(WebMcpLearningBootstrap.handleMessage({
      type: WebMcpProtocol.MESSAGE_TYPES.recordingStart,
      recordingId: 'recording_1',
    }, {}, (value) => { response = value; }), false);
    deepEqual(response, { ok: true });

    equal(WebMcpLearningBootstrap.handleMessage({
      type: WebMcpProtocol.MESSAGE_TYPES.getPageState,
    }, {}, (value) => { response = value; }), false);
    equal(response.ok, true);
    equal(typeof response.state.fingerprint, 'string');
    equal(WebMcpLearningBootstrap.handleMessage({ type: 'UNKNOWN' }, {}, () => {}), undefined);
  });

  test('captures fill, click, and Enter while preserving recorder exclusions', async () => {
    const contentListener = chrome.__test.runtimeListeners[0];
    let response;
    contentListener({
      type: WebMcpProtocol.MESSAGE_TYPES.recordingStart,
      recordingId: 'recording_interactions',
    }, {}, (value) => { response = value; });
    deepEqual(response, { ok: true });

    const fixture = document.createElement('section');
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Search catalog');
    const button = document.createElement('button');
    button.textContent = 'Search';
    fixture.append(input, button);
    document.body.append(fixture);

    const before = chrome.__test.sentMessages.length;
    input.value = 'headphones';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    input.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      key: 'Enter',
    }));
    globalThis.__webMcpRunnerActive = true;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    globalThis.__webMcpRunnerActive = false;

    await new Promise((resolve) => { setTimeout(resolve, 450); });
    const observed = chrome.__test.sentMessages.slice(before);
    deepEqual(observed
      .filter(({ type }) => type === 'TRACE_EVENT_STARTED')
      .map(({ event: traceEvent }) => traceEvent.kind), ['fill', 'click', 'press']);
    equal(observed.filter(({ type }) => type === 'TRACE_EVENT_COMPLETED').length, 3);

    const stopResponse = await new Promise((resolve) => {
      equal(contentListener({
        type: WebMcpProtocol.MESSAGE_TYPES.recordingStop,
      }, {}, resolve), true);
    });
    equal(stopResponse.ok, true);
    equal(typeof stopResponse.finalState.fingerprint, 'string');
    const afterStop = chrome.__test.sentMessages.length;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    equal(chrome.__test.sentMessages.length, afterStop);
    fixture.remove();
  });

  test('keeps registration paused until an explicit refresh', async () => {
    const before = chrome.__test.sentMessages.length;
    equal(WebMcpSourceBootstrap.handleMessage({
      type: WebMcpProtocol.MESSAGE_TYPES.refreshAdapters,
    }, {}, () => {}), true);
    await Promise.resolve();
    await Promise.resolve();
    deepEqual(chrome.__test.sentMessages.slice(before), [{
      type: 'WEBMCP_STATUS',
      available: false,
    }]);
    equal(WebMcpSourceBootstrap.handleMessage({ type: 'UNKNOWN' }, {}, () => {}), undefined);
  });

  test('preserves positive registration and completed job polling', async () => {
    const registered = [];
    let jobReads = 0;
    document.modelContext = {
      async registerTool(tool, options) {
        registered.push({ tool, options });
      },
    };
    chrome.__test.setRuntimeResponder((message) => {
      if (message.type === 'GET_ADAPTERS') {
        const matching = adapter();
        matching.site.origin = window.location.origin;
        matching.site.routePatterns = ['/tests/index.html'];
        return {
          ok: true,
          adapters: [{ versionId: 'version_1', manifest: matching }],
        };
      }
      if (message.type === 'START_JOB') return { ok: true, jobId: 'job_1' };
      if (message.type === 'GET_JOB') {
        jobReads += 1;
        if (jobReads === 1) return { ok: true, job: { status: 'running' } };
        return { ok: true, job: { status: 'completed', result: { count: 1 } } };
      }
      return { ok: true };
    });

    await WebMcpSourceBootstrap.registerAdapters();
    equal(registered.length, 1);
    equal(registered[0].tool.name, 'search_products');
    deepEqual(await registered[0].tool.execute({ query: 'headphones' }), { count: 1 });
    const recentTypes = chrome.__test.sentMessages.map(({ type }) => type);
    equal(recentTypes.includes('GET_ADAPTERS'), true);
    equal(recentTypes.includes('START_JOB'), true);
    equal(recentTypes.filter((type) => type === 'GET_JOB').length, 2);
    delete document.modelContext;
    chrome.__test.setRuntimeResponder(() => ({ ok: true }));
  });

  test('preserves execution-step delegation', async () => {
    const response = await new Promise((resolve) => {
      equal(WebMcpSourceBootstrap.handleMessage({
        type: WebMcpProtocol.MESSAGE_TYPES.executeStep,
        step: { op: 'extract' },
        args: {},
        tool: adapter().tool,
      }, {}, resolve), true);
    });
    equal(response.ok, true);
    equal(typeof response.result.fields, 'object');
    equal(response.result.url, window.location.href);
  });

  test('installs coordinator listeners only once', () => {
    WebMcpCoordinatorBootstrap.start();
    WebMcpCoordinatorBootstrap.start();
    equal(chrome.__test.runtimeListeners.length, 2);
    equal(chrome.__test.tabRemovedListeners.length, 1);
  });

  test('preserves the unknown background message response', async () => {
    let response;
    equal(chrome.__test.runtimeListeners[1](
      { type: 'UNKNOWN' },
      {},
      (value) => { response = value; },
    ), true);
    await Promise.resolve();
    await Promise.resolve();
    deepEqual(response, {
      ok: false,
      error: 'Unknown extension message',
    });
  });

  test('preserves background recording event guards and stop behavior', async () => {
    const initial = pageState('background_initial', 'https://example.com/search');
    const changed = pageState('background_changed', 'https://example.com/search');
    chrome.__test.setTabResponder((_tabId, message) => {
      if (message.type === 'GET_PAGE_STATE') return { ok: true, state: initial };
      if (message.type === 'RECORDING_STOP') return { ok: true, finalState: changed };
      return { ok: true };
    });

    const started = await WebMcpCoordinatorBootstrap.handleMessage({
      type: 'START_RECORDING',
      tabId: 7,
    }, {});
    equal(started.ok, true);
    equal(started.recording.status, 'recording');

    const rejectedEvent = event('rejected_background_click', 'click', 'Search');
    await WebMcpCoordinatorBootstrap.handleMessage({
      type: 'TRACE_EVENT_STARTED',
      recordingId: started.recording.id,
      event: rejectedEvent,
      beforeState: initial,
    }, { tab: { id: 99 } });
    equal(Object.keys(
      chrome.storage.session.values.activeRecording.pendingEvents,
    ).length, 0);

    const observedEvent = event('background_click', 'click', 'Search');
    await WebMcpCoordinatorBootstrap.handleMessage({
      type: 'TRACE_EVENT_STARTED',
      recordingId: started.recording.id,
      event: observedEvent,
      beforeState: initial,
    }, { tab: { id: 7 } });
    await WebMcpCoordinatorBootstrap.handleMessage({
      type: 'TRACE_EVENT_COMPLETED',
      recordingId: started.recording.id,
      eventId: observedEvent.id,
      afterState: changed,
      delta: delta(initial, changed),
    }, { tab: { id: 7 } });

    const stopped = await WebMcpCoordinatorBootstrap.handleMessage({
      type: 'STOP_RECORDING',
      learn: false,
    }, {});
    equal(stopped.ok, true);
    equal(stopped.recording.status, 'ready');
    equal(stopped.recording.eventCount, 1);
    equal(stopped.discovery, null);
    chrome.__test.setTabResponder(() => ({ ok: true }));
  });

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

  void run();
})();
