(function initializeAmbientRuntime(root, factory) {
  root.WebMcpAmbientRuntime = factory(
    root.WebMcpAmbientCapture,
    root.WebMcpAmbientRetrySpool,
    root.WebMcpLearningSemantic,
  );
}(typeof globalThis === 'undefined' ? this : globalThis, (capture, retrySpool, semantic) => {
  'use strict';

  const BACKEND = 'http://127.0.0.1:4317';
  const POLICY_SCOPE = 'ambient_learn';

  const policyKey = (origin) => `ambientPolicy:${origin}`;
  const lifecycleKey = (scopeId) => `ambientLifecycle:${scopeId}`;
  const scopeFor = (origin) => `site_${origin.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(-80)}`;

  const projection = () => {
    const page = semantic.capturePageState({ document });
    return {
      ...page,
      evidenceIds: page.nodes.map(({ id }) => id),
      privacy: { rawPersisted: false, sanitizerVersion: 'semantic-sanitizer/1' },
      redactions: { counts: {}, total: 0 },
    };
  };

  const observer = {
    attach({ onObservation, onSettled }) {
      const pending = new Map();
      let quietTimer = null;
      const settlePending = (kind = 'semantic_update') => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => pending.forEach((entry, observationId) => {
          pending.delete(observationId);
          const page = projection(); onSettled(observationId, { projection: page, outcome: { kind, evidenceIds: page.evidenceIds } });
          if (globalThis.__webMcpAmbientLastObservation?.observationId === observationId) globalThis.__webMcpAmbientLastObservation = null;
        }), 180);
      };
      const settle = (observationId) => {
        pending.set(observationId, true);
        settlePending('semantic_update');
      };
      const observe = (event, kind) => {
        if (!event.isTrusted || globalThis.__webMcpRunnerActive) return;
        const target = event.target instanceof Element ? semantic.describeElement(event.target, {
          argumentsByValue: new Map(), ledger: WebMcpLearningPrivacy.createLedger(),
        }) : null;
        const observationId = onObservation({ kind, targetEvidenceId: target?.id, trusted: event.isTrusted });
        if (observationId) {
          globalThis.__webMcpAmbientLastObservation = { observationId, kind, targetEvidenceId: target?.id || null };
          settle(observationId);
        }
      };
      const onClick = (event) => observe(event, 'click');
      const onInput = (event) => observe(event, 'fill');
      const onFocus = (event) => observe(event, 'other');
      const onSubmit = (event) => observe(event, 'submit');
      const onKeydown = (event) => { if (event.key === 'Enter') observe(event, 'press'); };
      const mutations = new MutationObserver(() => settlePending());
      mutations.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      document.addEventListener('click', onClick, true); document.addEventListener('input', onInput, true);
      document.addEventListener('focusin', onFocus, true); document.addEventListener('submit', onSubmit, true);
      const onPopstate = () => settlePending('same_document_route');
      document.addEventListener('keydown', onKeydown, true); window.addEventListener('popstate', onPopstate);
      return {
        disconnect() { document.removeEventListener('click', onClick, true); document.removeEventListener('input', onInput, true); document.removeEventListener('focusin', onFocus, true); document.removeEventListener('submit', onSubmit, true); document.removeEventListener('keydown', onKeydown, true); window.removeEventListener('popstate', onPopstate); mutations.disconnect(); clearTimeout(quietTimer); pending.clear(); },
        discard(observationId) { pending.delete(observationId); },
      };
    },
    async captureInitial() { return projection(); },
  };

  const start = async () => {
    const origin = window.location.origin;
    const result = await chrome.storage.local.get(policyKey(origin));
    const storedPolicy = result[policyKey(origin)];
    const policy = storedPolicy && {
      ...storedPolicy,
      status: storedPolicy.status || storedPolicy.decision,
      scope: POLICY_SCOPE,
    };
    const scopeId = scopeFor(origin);
    const lifecycle = await chrome.storage.session.get(lifecycleKey(scopeId));
    const prior = lifecycle[lifecycleKey(scopeId)] || { sequence: 0, pending: null };
    const storage = await retrySpool.createChromeEncryptedStorage({ chromeApi: chrome });
    const controller = capture.createAmbientCapture({
      eligibility: {
        async current({ scope }) {
          if (scope !== POLICY_SCOPE || policy?.status !== 'allowed' || policy?.origin !== origin
            || !policy.decisionId || !policy.checkedAt) return { status: 'denied' };
          return policy;
        },
      },
      observer,
      layerSequence: { async next() { prior.sequence += 1; await chrome.storage.session.set({ [lifecycleKey(scopeId)]: prior }); return prior.sequence; } },
      spool: retrySpool.createRetrySpool({ storage }),
      delivery: {
        async deliver(completedLayer) {
          const response = await fetch(`${BACKEND}/v1/ambient/layers`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(completedLayer),
          });
          const body = await response.json().catch(() => ({}));
          return { outcome: body.outcome || (response.status === 409 ? 'conflict' : 'rejected'), receiptId: body.requestId };
        },
      },
    });
    const attached = await controller.start({
      siteScope: { scopeId, origin, routePatterns: ['^/.*$'] },
      route: window.location.pathname,
      initialObservation: prior.pending,
    });
    prior.pending = null;
    await chrome.storage.session.set({ [lifecycleKey(scopeId)]: prior });
    window.addEventListener('pagehide', () => {
      const status = controller.status();
      const observed = globalThis.__webMcpAmbientLastObservation;
      prior.pending = observed && status.lastLayerId ? { observationId: observed.observationId, eventSequence: status.eventSequence, fromLayerId: status.lastLayerId, kind: observed.kind, targetEvidenceId: observed.targetEvidenceId, argumentTokens: [] } : null;
      void chrome.storage.session.set({ [lifecycleKey(scopeId)]: prior });
    }, { once: true });
    chrome.storage.onChanged?.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[policyKey(origin)]) return;
      const next = changes[policyKey(origin)].newValue;
      if (!next || next.status !== 'allowed' || next.origin !== origin
        || next.revision !== policy.revision) controller.revoke({ status: 'revoked' });
    });
    document.documentElement.dataset.webMcpAmbient = attached.attached ? 'attached' : 'policy_denied';
    return controller;
  };

  return Object.freeze({ start });
}));
