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
      const settle = (observationId, kind) => {
        const timer = setTimeout(() => {
          pending.delete(observationId);
          const page = projection();
          onSettled(observationId, {
            projection: page,
            outcome: { kind, evidenceIds: page.evidenceIds },
          });
        }, 80);
        pending.set(observationId, timer);
      };
      const onClick = (event) => {
        if (!event.isTrusted || globalThis.__webMcpRunnerActive) return;
        const target = event.target instanceof Element ? semantic.describeElement(event.target, {
          argumentsByValue: new Map(), ledger: WebMcpLearningPrivacy.createLedger(),
        }) : null;
        const observationId = onObservation({ kind: 'click', targetEvidenceId: target?.id, trusted: event.isTrusted });
        if (observationId) settle(observationId, 'semantic_update');
      };
      document.addEventListener('click', onClick, true);
      return {
        disconnect() { document.removeEventListener('click', onClick, true); pending.forEach(clearTimeout); },
        discard(observationId) { clearTimeout(pending.get(observationId)); pending.delete(observationId); },
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
      siteScope: { scopeId: `site_${origin.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(-80)}`, origin, routePatterns: ['^/.*$'] },
      route: window.location.pathname,
    });
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
