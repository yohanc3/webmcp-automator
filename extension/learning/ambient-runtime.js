(function initializeAmbientRuntime(root, factory) {
  const runtime = factory(
    root.WebMcpAmbientCapture || (typeof module === 'object' && module.exports ? require('./ambient-capture.js') : null),
    root.WebMcpLearningSemantic || (typeof module === 'object' && module.exports ? { capturePageState: () => ({ nodes: [], semanticXml: '' }), describeElement: () => ({ id: 'node_test' }) } : null),
    root.WebMcpLearningPrivacy || (typeof module === 'object' && module.exports ? require('./privacy.js') : null), root.WebMcpAmbientScope || (typeof module === 'object' && module.exports ? require('../shared/ambient-scope.js') : null));
  root.WebMcpAmbientRuntime = runtime;
  if (typeof module === 'object' && module.exports) module.exports = runtime;
}(typeof globalThis === 'undefined' ? this : globalThis, (capture, semantic, privacy, ambientScope) => {
  'use strict';

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
  const defaultObserver = ({ documentApi, privacyApi = privacy, semanticApi = semantic, windowApi }) => ({
    attach({ onObservation, onSettled }) {
      let timer = null;
      const pending = new Map();
      const project = () => {
        const ledger = privacyApi.createLedger();
        const page = semanticApi.capturePageState({ document: documentApi, ledger });
        return { ...page, evidenceIds: page.nodes.map(({ id }) => id), rawPersisted: false, redactions: ledger.summary() };
      };
      const settle = (kind = 'semantic_update') => {
        clearTimeout(timer);
        timer = setTimeout(() => pending.forEach((value, id) => {
          pending.delete(id);
          const projection = project();
          onSettled(id, { outcome: { kind, evidenceIds: projection.evidenceIds }, projection });
        }), 180);
      };
      const navigationCausing = (event, kind) => {
        const target = event.target;
        if (kind === 'submit') return true;
        if (kind === 'press') return Boolean(target?.form);
        return Boolean(target?.closest?.('a[href], button[type="submit"], input[type="submit"], input[type="image"]'));
      };
      const observe = (event, kind) => {
        if (!event.isTrusted || windowApi.__webMcpRunnerActive || windowApi.__webMcpActorActive) return;
        const target = event.target instanceof windowApi.Element ? semanticApi.describeElement(event.target, { argumentsByValue: new Map() }) : null;
          const id = onObservation({ kind, navigation: navigationCausing(event, kind), targetEvidenceId: target?.id, trusted: true });
        if (id) {
          pending.set(id, true);
          settle();
        }
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
      const popstate = () => settle('same_document_route');
      windowApi.addEventListener('popstate', popstate);
      mutations.observe(documentApi.documentElement, { childList: true, subtree: true, characterData: true });
      return {
        disconnect() { clearTimeout(timer); pending.clear(); mutations.disconnect(); undoPush(); undoReplace(); documentApi.removeEventListener('click', click, true); documentApi.removeEventListener('focusin', focus, true); documentApi.removeEventListener('input', input, true); documentApi.removeEventListener('submit', submit, true); documentApi.removeEventListener('keydown', keydown, true); windowApi.removeEventListener('popstate', popstate); },
      };
    },
    async captureInitial() {
      const ledger = privacyApi.createLedger();
      const page = semanticApi.capturePageState({ document: documentApi, ledger });
      return { ...page, evidenceIds: page.nodes.map(({ id }) => id), rawPersisted: false, redactions: ledger.summary() };
    },
  });
  const createRuntime = ({ chromeApi = chrome, documentApi = document, observer = null, privacyApi = privacy, semanticApi = semantic, windowApi = window } = {}) => {
    const origin = ambientScope.originFor(windowApi.location.origin);
    if (!origin) throw new Error('Ambient learning supports HTTP(S) origins only');
    const siteScope = { origin, routePatterns: ['^/.*$'], scopeId: ambientScope.scopeFor(origin) };
    const runtime = chromeApi.runtime;
    const observerPort = observer || defaultObserver({ documentApi, privacyApi, semanticApi, windowApi });
    let observerConnection = null;
    const controller = capture.createAmbientCapture({
      delivery: { deliver: async (completedLayer) => (await message(runtime, { type: 'AMBIENT_DELIVER_LAYER', completedLayer })).receipt },
      eligibility: policyPort(runtime),
      layerSequence: { next: async (scopeId) => (await message(runtime, { type: 'AMBIENT_NEXT_LAYER_SEQUENCE', scopeId })).sequence },
      onNavigationPending: (pending) => void message(runtime, { type: 'AMBIENT_PUT_PENDING', scopeId: siteScope.scopeId, documentId: 'top', pending }),
      onNavigationSettled: (observationId) => void message(runtime, { type: 'AMBIENT_CLEAR_PENDING', scopeId: siteScope.scopeId, documentId: 'top', observationId }),
      observer: {
        attach(options) { observerConnection = observerPort.attach(options); return observerConnection; },
        captureInitial: (...args) => observerPort.captureInitial(...args),
      },
      spool: spoolPort(runtime),
    });
    const start = async () => {
      const pending = (await message(runtime, { type: 'AMBIENT_CONSUME_PENDING', scopeId: siteScope.scopeId, documentId: 'top' })).pending;
      const result = await controller.start({ initialObservation: pending, route: windowApi.location.pathname, siteScope });
      documentApi.documentElement.dataset.webMcpAmbient = result.attached ? 'attached' : 'policy_denied';
      return result;
    };
    chromeApi.storage.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !changes[`ambientPolicy:${origin}`]) return;
      const changed = changes[`ambientPolicy:${origin}`].newValue;
      if (!changed || changed.status !== 'allowed') {
        controller.revoke(changed || { status: 'revoked' });
        return;
      }
      void policyPort(runtime).current({ origin, scope: 'ambient_learn' }).then((policy) => {
        if (policy?.status !== 'allowed') controller.revoke(policy);
        else void controller.requestDelivery();
      });
      if (!controller.status().attached) void start();
    });
    return Object.freeze({ controller, start });
  };
  const start = () => createRuntime().start();
  return Object.freeze({ createRuntime, defaultObserver, start });
}));
