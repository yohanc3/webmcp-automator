(() => {
  'use strict';

  const {
    assert: { deepEqual, equal, match },
    run,
    test,
  } = ExtensionTest;
  const privacy = WebMcpLearningPrivacy;
  const semantic = WebMcpLearningSemantic;
  const recorder = WebMcpLearningRecorder;
  const fixture = document.querySelector('#fixture');
  const secrets = Object.freeze({
    attribute: 'canary-attribute-secret-a91f27',
    form: 'ordinarytypedvalue-a91f27',
    mutation: 'canary-mutation-secret-a91f27',
    query: 'canary-query-secret-a91f27',
    visible: 'canary-visible-secret-a91f27',
  });
  let nextId = 1;

  const memoryStorage = () => {
    const values = new Map();
    return {
      getItem(key) { return values.get(key) || null; },
      removeItem(key) { values.delete(key); },
      setItem(key, value) { values.set(key, value); },
      serialized() { return [...values.values()].join('\n'); },
    };
  };

  const state = (fingerprint, url = 'https://shop.test/demo/') => ({
    capturedAt: '2026-09-03T12:00:00.000Z',
    fingerprint,
    url,
    origin: 'https://shop.test',
    title: 'Store',
    viewport: { width: 1000, height: 700, scrollX: 0, scrollY: 0 },
    nodes: [],
    collections: [],
    semanticXml: '<page schema="learning-ui/2"></page>',
    truncated: false,
  });

  const event = (id, kind = 'click') => ({
    id,
    kind,
    occurredAt: '2026-09-03T12:00:01.000Z',
    target: {
      id: `n_${id}`,
      tag: 'button',
      role: 'button',
      name: 'Search',
      css: '#search',
      attributes: { type: 'button' },
    },
    value: { redacted: false, value: null, valueType: 'null' },
  });

  const delta = (before, after) => ({
    urlChanged: before.url !== after.url,
    beforeUrl: before.url,
    afterUrl: after.url,
    titleChanged: false,
    added: [],
    removed: [],
    changed: [],
    collectionsChanged: false,
    collections: [],
    beforeFingerprint: before.fingerprint,
    afterFingerprint: after.fingerprint,
  });

  const assertSecretsAbsent = (serialized) => {
    Object.values(secrets).forEach((secret) => equal(serialized.includes(secret), false));
  };

  test('allowlists semantic evidence and redacts every seeded secret surface', () => {
    equal(globalThis.WebMcpSemantic, semantic);
    equal(globalThis.ActionMapperRecorder, recorder);
    fixture.innerHTML = `
      <h2>${secrets.visible}</h2>
      <p>${secrets.mutation}</p>
      <label>Search <input id="catalog-query" name="q" value="${secrets.form}"></label>
      <button data-testid="${secrets.attribute}" data-private="${secrets.attribute}">Search</button>
    `;
    const ledger = privacy.createLedger();
    const captured = semantic.capturePageState({ document, ledger });
    const serialized = JSON.stringify({ captured, redactions: ledger.summary() });
    assertSecretsAbsent(serialized);
    equal(serialized.includes('data-private'), false);
    equal(captured.url.includes('?'), false);
    match(serialized, /\[redacted\]/);
    fixture.replaceChildren();
  });

  test('records input, click, Enter, SPA mutation, repeats, and stop races causally', async () => {
    fixture.innerHTML = `
      <h2>${secrets.form}</h2>
      <label>Search the catalog <input id="catalog-query" name="q"></label>
      <button id="search-button" type="button" data-secret="${secrets.attribute}">Search</button>
      <div id="updates" aria-live="polite"></div>
    `;
    const input = fixture.querySelector('input');
    const button = fixture.querySelector('button');
    const updates = fixture.querySelector('#updates');
    const storage = memoryStorage();
    const session = WebMcpLearningSession.createSession({
      document,
      storage,
      acceptUntrustedEvents: true,
      quietMs: 10,
      quietDeadlineMs: 40,
      id: () => `event_${nextId++}`,
      now: () => '2026-09-03T12:00:00.000Z',
    });
    session.initialize();
    const recordingId = session.start();
    equal(typeof recordingId, 'string');
    equal(session.status().indicator, 'recording');
    equal(Boolean(document.querySelector('[data-webmcp-learning-ui="indicator"]')), true);

    button.addEventListener('click', () => {
      updates.setAttribute('role', 'status');
      updates.textContent = secrets.mutation;
    });
    input.value = secrets.form;
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));

    globalThis.__webMcpActorActive = true;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    globalThis.__webMcpActorActive = false;

    const trace = await session.stop();
    equal(session.status().status, 'ready');
    equal(session.status().indicator, 'idle');
    equal(document.querySelector('[data-webmcp-learning-ui="indicator"]'), null);
    deepEqual(trace.frames.map(({ type }) => type), [
      'page',
      'action', 'update', 'page',
      'action', 'update', 'page',
      'action', 'update', 'page',
      'action', 'update', 'page',
    ]);
    deepEqual(trace.frames.filter(({ type }) => type === 'action')
      .map(({ action }) => action.kind), ['fill', 'click', 'click', 'press']);
    const fill = trace.frames.find(({ type }) => type === 'action').action;
    equal(fill.value.value, '{{arg.query}}');
    equal(fill.value.valueType, 'string');
    equal(trace.actionTree.transitions.length, 4);

    const traceJSON = JSON.stringify(trace);
    const debugJSON = JSON.stringify(session.debug());
    assertSecretsAbsent(traceJSON);
    assertSecretsAbsent(debugJSON);
    assertSecretsAbsent(storage.serialized());
    equal(session.debug().redactions.total > 0, true);
    session.destroy();
    session.reset();
    fixture.replaceChildren();
  });

  test('completes a pending full navigation without breaking trace order', () => {
    const ledger = privacy.createLedger();
    const home = state('home');
    const results = state('results', 'https://shop.test/demo/search');
    let recording = recorder.createRecording({
      id: 'navigation',
      tabId: 7,
      state: home,
      startedAt: '2026-09-03T12:00:00.000Z',
      ledger,
    });
    recording = recorder.beginEvent(recording, event('navigate'), home);
    recording = recorder.completeNavigation(recording, results, delta);
    recording = recorder.finishRecording(
      recording,
      results,
      '2026-09-03T12:00:03.000Z',
      delta,
    );
    const trace = recorder.toTrace(recording);
    deepEqual(trace.frames.map(({ type }) => type), ['page', 'action', 'update', 'page']);
    equal(trace.frames[2].update.urlChanged, true);
    equal(trace.actionTree.finalPageId, 'page_2');
  });

  test('excludes synthetic recorder events at the pure state boundary', () => {
    const home = state('home');
    let recording = recorder.createRecording({
      id: 'synthetic',
      tabId: 7,
      state: home,
      startedAt: '2026-09-03T12:00:00.000Z',
      ledger: privacy.createLedger(),
    });
    recording = recorder.beginEvent(recording, { ...event('actor'), synthetic: true }, home);
    equal(recording.nextSequence, 1);
    equal(Object.keys(recording.pendingEvents).length, 0);
  });

  test('does not learn programmatic actor-style DOM events', async () => {
    fixture.innerHTML = '<button type="button">Actor click</button>';
    const storage = memoryStorage();
    const session = WebMcpLearningSession.createSession({
      document,
      storage,
      quietMs: 5,
      quietDeadlineMs: 20,
    });
    session.initialize();
    session.start();
    fixture.querySelector('button').dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      detail: 1,
    }));
    const trace = await session.stop();
    equal(trace.frames.filter(({ type }) => type === 'action').length, 0);
    session.destroy();
    session.reset();
    fixture.replaceChildren();
  });

  test('produces a secret-free local debug artifact with ledger summaries only', () => {
    const ledger = privacy.createLedger();
    const context = privacy.collectArguments(document);
    privacy.sanitizeText(secrets.visible, { argumentsByValue: context, ledger });
    const artifact = privacy.serializeDebugArtifact({
      schemaVersion: 'learning-trace/3',
      recordingId: 'debug',
      frames: [],
    }, ledger);
    assertSecretsAbsent(artifact);
    match(artifact, /"redactions"/);
    match(artifact, /"counts"/);
  });

  void run();
})();
