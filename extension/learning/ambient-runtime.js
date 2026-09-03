(function initializeAmbientRuntime(root, factory) {
  const runtime = factory(
    root.WebMcpAmbientCapture || (typeof module === 'object' && module.exports ? require('./ambient-capture.js') : null),
    root.WebMcpLearningSemantic || (typeof module === 'object' && module.exports ? { capturePageState: () => ({ nodes: [], semanticXml: '' }) } : null),
  );
  root.WebMcpAmbientRuntime = runtime;
  if (typeof module === 'object' && module.exports) module.exports = runtime;
}(typeof globalThis === 'undefined' ? this : globalThis, (capture, semantic) => {
  'use strict';

  const BACKEND = 'http://127.0.0.1:4317';
  const SCOPE = 'ambient_learn';
  const scopeFor = (origin) => `site_${origin.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(-80)}`;
  const message = (runtime, value) => new Promise((resolve, reject) => {
    runtime.sendMessage(value, (response) => {
      if (runtime.lastError) reject(new Error(runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error || 'Ambient background request failed'));
      else resolve(response);
    });
  });
  const policyPort = (runtime) => ({
    current: async ({ origin, scope, revision = null }) => (await message(runtime, {
      type: 'AMBIENT_POLICY_CURRENT', origin, revision, scope,
    })).policy,
  });
  const spoolPort = (runtime) => ({
    enqueue: async (completedLayer) => (await message(runtime, { type: 'AMBIENT_SPOOL_OPERATION', operation: 'enqueue', payload: { completedLayer } })).result,
    handleReceipt: async (id, receipt) => (await message(runtime, { type: 'AMBIENT_SPOOL_OPERATION', operation: 'handleReceipt', payload: { id, receipt } })).result,
    markAttempt: async (id) => (await message(runtime, { type: 'AMBIENT_SPOOL_OPERATION', operation: 'markAttempt', payload: { id } })).result,
    next: async () => (await message(runtime, { type: 'AMBIENT_SPOOL_OPERATION', operation: 'next' })).result,
  });
  const classify = async (response) => {
    const body = await response.json().catch(() => null);
    if (response.status === 409) return { outcome: 'conflict', receiptId: body?.requestId || null };
    if (!response.ok || !body || typeof body.outcome !== 'string') throw new Error(`Ambient transfer retryable: ${response.status}`);
    if (['applied', 'duplicate', 'no_change', 'rejected'].includes(body.outcome)) return { outcome: body.outcome, receiptId: body.requestId || null };
    throw new Error('Ambient transfer returned an unrecognized outcome');
  };
  const defaultObserver = ({ documentApi, windowApi }) => ({
    attach({ onObservation, onSettled }) {
      let timer = null;
      const pending = new Map();
      const project = () => {
        const page = semantic.capturePageState({ document: documentApi });
        return { ...page, evidenceIds: page.nodes.map(({ id }) => id), rawPersisted: false };
      };
      const settle = (kind = 'semantic_update') => {
        clearTimeout(timer);
        timer = setTimeout(() => pending.forEach((value, id) => {
          pending.delete(id);
          const projection = project();
          onSettled(id, { outcome: { kind, evidenceIds: projection.evidenceIds }, projection });
        }), 180);
      };
      const observe = (event, kind) => {
        if (!event.isTrusted || windowApi.__webMcpRunnerActive || windowApi.__webMcpActorActive) return;
        const target = event.target instanceof windowApi.Element ? semantic.describeElement(event.target, { argumentsByValue: new Map() }) : null;
        const id = onObservation({ kind, targetEvidenceId: target?.id, trusted: true });
        if (id) { pending.set(id, true); settle(); }
      };
      const click = (event) => observe(event, 'click');
      const focus = (event) => observe(event, 'other');
      const input = (event) => observe(event, 'fill');
      const submit = (event) => observe(event, 'submit');
      const keydown = (event) => { if (event.key === 'Enter') observe(event, 'press'); };
      const mutations = new windowApi.MutationObserver(() => settle());
      const history = windowApi.history;
      const wrap = (name) => {
        const original = history[name];
        history[name] = function wrappedHistory(...args) { const result = original.apply(this, args); settle('same_document_route'); return result; };
        return () => { history[name] = original; };
      };
      const undoPush = wrap('pushState'); const undoReplace = wrap('replaceState');
      documentApi.addEventListener('click', click, true); documentApi.addEventListener('focusin', focus, true); documentApi.addEventListener('input', input, true); documentApi.addEventListener('submit', submit, true); documentApi.addEventListener('keydown', keydown, true);
      windowApi.addEventListener('popstate', () => settle('same_document_route'));
      mutations.observe(documentApi.documentElement, { childList: true, subtree: true, characterData: true });
      return { disconnect() { clearTimeout(timer); pending.clear(); mutations.disconnect(); undoPush(); undoReplace(); documentApi.removeEventListener('click', click, true); documentApi.removeEventListener('focusin', focus, true); documentApi.removeEventListener('input', input, true); documentApi.removeEventListener('submit', submit, true); documentApi.removeEventListener('keydown', keydown, true); } };
    },
    async captureInitial() {
      const page = semantic.capturePageState({ document: documentApi });
      return { ...page, evidenceIds: page.nodes.map(({ id }) => id), rawPersisted: false };
    },
  });
  const createRuntime = ({ chromeApi = chrome, documentApi = document, fetchApi = fetch, observer = null, windowApi = window } = {}) => {
    const origin = windowApi.location.origin;
    const siteScope = { origin, routePatterns: ['^/.*$'], scopeId: scopeFor(origin) };
    const runtime = chromeApi.runtime;
    const controller = capture.createAmbientCapture({
      delivery: { deliver: async (layer) => classify(await fetchApi(`${BACKEND}/v1/ambient/layers`, { body: JSON.stringify(layer), headers: { 'Content-Type': 'application/json' }, method: 'POST' })) },
      eligibility: policyPort(runtime),
      layerSequence: { next: async (scopeId) => (await message(runtime, { type: 'AMBIENT_NEXT_LAYER_SEQUENCE', scopeId })).sequence },
      observer: observer || defaultObserver({ documentApi, windowApi }),
      spool: spoolPort(runtime),
    });
    const start = async () => {
      const pending = (await message(runtime, { type: 'AMBIENT_CONSUME_PENDING', scopeId: siteScope.scopeId, documentId: 'top' })).pending;
      const result = await controller.start({ initialObservation: pending, route: windowApi.location.pathname, siteScope });
      documentApi.documentElement.dataset.webMcpAmbient = result.attached ? 'attached' : 'policy_denied';
      return result;
    };
    windowApi.addEventListener('pagehide', () => {
      const status = controller.status();
      if (!status.lastLayerId) return;
      const pending = { fromLayerId: status.lastLayerId, kind: 'navigate', observationId: `nav_${status.eventSequence + 1}`, eventSequence: status.eventSequence + 1, targetEvidenceId: null, argumentTokens: [] };
      void message(runtime, { type: 'AMBIENT_PUT_PENDING', scopeId: siteScope.scopeId, documentId: 'top', pending });
    }, { once: true });
    chromeApi.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && changes[`ambientPolicy:${origin}`]) void controller.requestDelivery();
    });
    return Object.freeze({ controller, start });
  };
  const start = () => createRuntime().start();
  return Object.freeze({ classify, createRuntime, start });
}));
