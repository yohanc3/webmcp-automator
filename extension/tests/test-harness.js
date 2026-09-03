(function initializeExtensionTest(root, factory) {
  root.ExtensionTest = factory();
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const tests = [];

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
    tests.push({ name, body });
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

  const createStorageArea = () => {
    const values = {};
    return {
      async get(key) {
        return { [key]: values[key] };
      },
      async remove(keys) {
        keys.forEach((key) => { delete values[key]; });
      },
      async set(update) {
        Object.assign(values, update);
      },
      values,
    };
  };

  const createChrome = () => {
    const runtimeListeners = [];
    const tabRemovedListeners = [];
    const sentMessages = [];
    const tabMessages = [];
    let runtimeResponder = () => ({ ok: true });
    let tabResponder = () => ({ ok: true });
    const runtime = {
      lastError: null,
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        },
      },
      sendMessage(message, callback) {
        sentMessages.push(message);
        if (callback) callback(runtimeResponder(message));
      },
    };
    return {
      runtime,
      storage: {
        local: createStorageArea(),
        session: createStorageArea(),
      },
      tabs: {
        async create() {
          return { id: 101 };
        },
        onRemoved: {
          addListener(listener) {
            tabRemovedListeners.push(listener);
          },
        },
        async query() {
          return [];
        },
        async remove() {},
        async sendMessage(tabId, message) {
          tabMessages.push({ tabId, message });
          return tabResponder(tabId, message);
        },
      },
      __test: {
        runtimeListeners,
        sentMessages,
        setRuntimeResponder(responder) {
          runtimeResponder = responder;
        },
        setTabResponder(responder) {
          tabResponder = responder;
        },
        tabMessages,
        tabRemovedListeners,
      },
    };
  };

  const render = (results) => {
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
  };

  const run = async () => {
    const results = [];
    for (const { name, body } of tests) {
      try {
        await body();
        results.push({ name, passed: true });
      } catch (error) {
        results.push({ name, passed: false, error: error.message });
      }
    }
    render(results);
  };

  return {
    assert: { deepEqual, equal, match },
    fakes: { createChrome },
    fixtures: {
      adapter,
      delta,
      event,
      locator,
      pageState,
    },
    run,
    test,
  };
}));
