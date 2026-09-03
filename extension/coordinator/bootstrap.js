(function initializeCoordinatorBootstrap(root, factory) {
  const api = factory(
    root.WebMcpAmbientRetrySpool,
    root.WebMcpErrors,
    root.WebMcpProtocol || (typeof module === 'object' && module.exports ? require('../shared/protocol.js') : null), root.WebMcpAmbientScope || (typeof module === 'object' && module.exports ? require('../shared/ambient-scope.js') : null),
  );
  root.WebMcpCoordinatorBootstrap = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'undefined' ? this : globalThis, (retrySpool, publicErrors, protocol, ambientScope) => {
  'use strict';

  const POLICY_PREFIX = 'ambientPolicy:';
  const LIFECYCLE_PREFIX = 'ambientLifecycle:';
  const CANDIDATE_PREFIX = 'ambientActionListCandidate:';
  const RECORD_KEY = 'ambientRetryRecords';
  const KEY_NAME = 'ambientRetryKey';
  const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

  const explicitOrigin = (value) => {
    try {
      const origin = new URL(value).origin;
      return origin === value ? origin : null;
    } catch (error) {
      return null;
    }
  };
  const originFromUrl = (value) => ambientScope.originFor(value);
  const validDigest = (value) => typeof value === 'string' && DIGEST_PATTERN.test(value);
  const validRevision = (value) => Number.isInteger(value) && value > 0;
  const responseHeader = (response, name) => response.headers?.get?.(name) || null;
  const unquotedETag = (value) => (
    typeof value === 'string' && /^"[^"]+"$/.test(value) ? value.slice(1, -1) : null
  );

  const createCoordinator = ({
    chromeApi = chrome,
    fetchApi = fetch,
    manifest = globalThis.WebMcpManifest,
    now = () => new Date().toISOString(),
    retrySpoolApi = retrySpool,
  } = {}) => {
    let queue = Promise.resolve();
    let storage = null;
    const advancingJobs = new Set();
    const serial = (work) => {
      const result = queue.then(work, work);
      queue = result.catch(() => {});
      return result;
    };
    const get = async (area, key, fallback = null) => {
      const values = await chromeApi.storage[area].get(key);
      return values[key] ?? fallback;
    };
    const set = (area, key, value) => chromeApi.storage[area].set({ [key]: value });
    const policyKey = (origin) => `${POLICY_PREFIX}${origin}`;
    const lifecycleKey = (scopeId) => `${LIFECYCLE_PREFIX}${scopeId}`;
    const candidateKey = (scopeId) => `${CANDIDATE_PREFIX}${scopeId}`;

    const currentPolicy = async ({ origin, scope, revision = null }) => {
      const normalized = explicitOrigin(origin);
      const policy = normalized ? await get('local', policyKey(normalized)) : null;
      const valid = policy?.status === 'allowed'
        && policy.origin === normalized
        && Array.isArray(policy.scopes)
        && policy.scopes.includes(scope)
        && typeof policy.checkedAt === 'string'
        && !Number.isNaN(Date.parse(policy.checkedAt))
        && validRevision(policy.revision)
        && (!policy.expiresAt || Date.parse(policy.expiresAt) > Date.parse(now()))
        && (revision === null || policy.revision === revision);
      return valid ? policy : { origin: normalized, revision: policy?.revision ?? null, scopes: [], status: 'denied' };
    };

    const savePolicy = (incoming, activeOrigin = null) => serial(async () => {
      const origin = originFromUrl(activeOrigin) || explicitOrigin(incoming?.origin);
      if (!origin) throw new Error('An explicit origin is required');
      const existing = await get('local', policyKey(origin));
      const policy = {
        checkedAt: now(),
        decisionId: incoming.decisionId || `policy_${Date.now()}`,
        expiresAt: incoming.expiresAt || null,
        origin,
        revision: (Number.isInteger(existing?.revision) ? existing.revision : 0) + 1,
        scopes: Array.isArray(incoming.scopes) ? incoming.scopes : [incoming.scope || 'ambient_learn'],
        source: incoming.source || 'local_policy_review',
        status: incoming.enabled === false ? 'revoked' : (incoming.decision || incoming.status || 'allowed'),
        overrideAudit: incoming.overrideAudit || null,
      };
      await set('local', policyKey(origin), policy);
      return policy;
    });

    const lifecycle = (scopeId, mutate) => serial(async () => {
      const key = lifecycleKey(scopeId);
      const state = await get('session', key, { nextLayerSequence: 0, pending: {} });
      const result = mutate(state);
      await set('session', key, state);
      return result;
    });

    const requestBackend = async (path, options = {}) => {
      const response = await fetchApi(`http://127.0.0.1:4317${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', 'X-WebMCP-Internal': 'ambient-v1', ...(options.headers || {}) },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Backend request failed with status ${response.status}`);
      return body;
    };
    const requestRegistry = async (path) => {
      const response = await fetchApi(`http://127.0.0.1:4317${path}`);
      const body = await response.json().catch(() => null);
      return { body, response };
    };
    const actionListCandidate = (value) => {
      if (
        !value || typeof value !== 'object'
        || typeof value.listId !== 'string' || value.listId.length === 0
        || value.status !== 'candidate' || !validRevision(value.revision) || !validDigest(value.digest)
      ) return null;
      return {
        digest: value.digest,
        listId: value.listId,
        revision: value.revision,
        status: 'candidate',
      };
    };
    const saveCandidate = async (completedLayer, receipt) => {
      const pointer = actionListCandidate(receipt.actionListCandidate);
      const scopeId = completedLayer?.siteScope?.scopeId;
      if (!pointer || !scopeId || !['applied', 'duplicate'].includes(receipt.outcome)) {
        return null;
      }
      await set('session', candidateKey(scopeId), pointer);
      return pointer;
    };
    const deliverAmbientLayer = async (completedLayer) => {
      const response = await fetchApi('http://127.0.0.1:4317/v1/ambient/layers', {
        body: JSON.stringify(completedLayer),
        headers: { 'Content-Type': 'application/json', 'X-WebMCP-Internal': 'ambient-v1' },
        method: 'POST',
      });
      const body = await response.json().catch(() => null);
      if (response.status === 409) return { outcome: 'conflict', receiptId: body?.requestId || null };
      if (!response.ok || !body || typeof body.outcome !== 'string') throw new Error(`Ambient delivery retryable: ${response.status}`);
      if (!['applied', 'duplicate', 'no_change', 'rejected'].includes(body.outcome)) throw new Error('Ambient delivery returned an invalid receipt');
      const receipt = {
        actionListCandidate: actionListCandidate(body.actionListCandidate),
        outcome: body.outcome,
        receiptId: body.requestId || null,
      };
      await saveCandidate(completedLayer, receipt);
      return receipt;
    };
    const tabMessage = (tabId, value) => chromeApi.tabs.sendMessage(tabId, value);
    const getJobs = () => get('session', 'jobs', {});
    const changeJob = (id, mutate) => serial(async () => {
      const jobs = await getJobs();
      if (!jobs[id]) return null;
      mutate(jobs[id]);
      jobs[id].updatedAt = now();
      await set('session', 'jobs', jobs);
      return jobs[id];
    });
    const reportRun = async (job, outcome, details = {}) => {
      await requestBackend('/api/runs', {
        body: JSON.stringify({
          error: details.error || null,
          failedStep: details.failedStep ?? null,
          observed: details.observed || null,
          outcome,
          url: details.url || job.sourceUrl,
          versionId: job.adapter.versionId,
        }),
        method: 'POST',
      }).catch(() => {});
    };
    const finishJob = async (id, status, details = {}) => {
      const job = await changeJob(id, (current) => {
        current.finishedAt = now();
        current.status = status;
        if (status === 'completed') current.result = details.result;
        if (status === 'failed') {
          current.error = details.error;
          current.failedStep = details.failedStep;
        }
      });
      if (!job) return;
      await reportRun(job, status === 'completed' ? 'success' : 'failure', details);
      await Promise.resolve(chromeApi.tabs.remove?.(job.tabId)).catch(() => {});
    };
    const advanceJob = async (id) => {
      if (advancingJobs.has(id)) return;
      advancingJobs.add(id);
      try {
        while (true) {
          const job = (await getJobs())[id];
          if (!job || ['completed', 'failed'].includes(job.status)) return;
          if (job.status === 'waiting-navigation') return;
          const steps = job.adapter.manifest.tool.steps;
          if (job.stepIndex >= steps.length) {
            if (job.result === null) {
              let extraction;
              try {
                extraction = await tabMessage(job.tabId, {
                  type: 'EXECUTE_STEP',
                  step: { expectNavigation: false, key: null, literalValue: null, op: 'extract', target: {}, timeoutMs: 5000, valueFrom: null },
                  args: job.args,
                  tool: job.adapter.manifest.tool,
                });
              } catch (error) {
                extraction = { error: error.message, ok: false };
              }
              if (!extraction?.ok) {
                await finishJob(id, 'failed', { error: extraction?.error || 'Could not extract adapter output', failedStep: job.stepIndex });
                return;
              }
              await changeJob(id, (current) => { current.result = extraction.result; });
              continue;
            }
            await finishJob(id, 'completed', { result: job.result });
            return;
          }

          const step = steps[job.stepIndex];
          await changeJob(id, (current) => { current.status = 'running'; });
          let response;
          try {
            response = await tabMessage(job.tabId, { type: 'EXECUTE_STEP', step, args: job.args, tool: job.adapter.manifest.tool });
          } catch (error) {
            const attempts = (job.transportAttempts || 0) + 1;
            if (attempts <= 20) {
              await changeJob(id, (current) => {
                current.status = 'starting';
                current.transportAttempts = attempts;
              });
              setTimeout(() => { void advanceJob(id); }, 250);
              return;
            }
            response = { error: `Execution page did not become ready: ${error.message}`, ok: false };
          }
          if (!response?.ok) {
            await finishJob(id, 'failed', { error: response?.error || 'Adapter step failed', failedStep: job.stepIndex });
            return;
          }
          await changeJob(id, (current) => {
            current.result = response.result ?? current.result;
            current.stepIndex += 1;
            current.status = response.navigating ? 'waiting-navigation' : 'running';
            current.transportAttempts = 0;
          });
          if (response.navigating) return;
        }
      } finally {
        advancingJobs.delete(id);
      }
    };
    const getAdapters = async (origin) => {
      const cache = await get('local', 'adapterCache', {});
      try {
        const body = await requestBackend(`/api/adapters?origin=${encodeURIComponent(origin)}`);
        cache[origin] = { adapters: body.adapters, fetchedAt: now() };
        await set('local', 'adapterCache', cache);
        return { adapters: body.adapters, stale: false };
      } catch (error) {
        if (cache[origin]) return { adapters: cache[origin].adapters, error: error.message, stale: true };
        throw error;
      }
    };
    const startJob = async (adapter, args, sourceUrl, sourceTabId) => {
      const validation = manifest.validateManifest(adapter.manifest);
      if (!validation.valid || !manifest.manifestMatchesLocation(validation.manifest, sourceUrl)) throw new Error('This adapter is not valid for the current page');
      const tab = await chromeApi.tabs.create({ active: false, url: 'about:blank' });
      const job = { adapter: { ...adapter, manifest: validation.manifest }, args, createdAt: now(), error: null, id: crypto.randomUUID(), result: null, sourceTabId, sourceUrl, status: 'starting', stepIndex: 0, tabId: tab.id, updatedAt: now() };
      await serial(async () => { const jobs = await getJobs(); jobs[job.id] = job; await set('session', 'jobs', jobs); });
      try {
        await chromeApi.tabs.update(tab.id, { url: sourceUrl });
      } catch (error) {
        await finishJob(job.id, 'failed', { error: `Could not navigate execution tab: ${error.message}`, failedStep: 0 });
        throw error;
      }
      setTimeout(() => { void advanceJob(job.id); }, 300);
      return job.id;
    };
    const pageReady = async (sender) => {
      const tabId = sender.tab?.id;
      const job = Object.values(await getJobs()).find((candidate) => candidate.tabId === tabId && !['completed', 'failed'].includes(candidate.status));
      if (job) {
        if (job.status === 'waiting-navigation') await changeJob(job.id, (current) => { current.status = 'running'; });
        setTimeout(() => { void advanceJob(job.id); }, 0);
      }
      return { recordingActive: false, recordingId: null };
    };

    const ownedSpool = async () => {
      if (!retrySpoolApi) throw new Error('Ambient retry spool was unavailable during coordinator initialization');
      if (!storage) storage = await retrySpoolApi.createChromeEncryptedStorage({ chromeApi, keyName: KEY_NAME, recordKey: RECORD_KEY });
      return retrySpoolApi.createRetrySpool({ storage });
    };
    const spool = (operation, payload = {}) => serial(async () => {
      const instance = await ownedSpool();
      switch (operation) {
        case 'enqueue': return instance.enqueue(payload.completedLayer);
        case 'next': return instance.next();
        case 'markAttempt': return instance.markAttempt(payload.id);
        case 'handleReceipt': return instance.handleReceipt(payload.id, payload.receipt);
        case 'list': return instance.list();
        case 'remove': return instance.remove(payload.id);
        case 'removeMatching': {
          const records = await instance.list();
          const matching = records.filter((record) => record.completedLayer?.siteScope?.origin === payload.origin && record.completedLayer?.siteScope?.scopeId === payload.scopeId);
          for (const record of matching) await instance.remove(record.id);
          return { deleted: matching.length, scopeId: payload.scopeId };
        }
        default: throw new Error('Unknown ambient spool operation');
      }
    });
    const retryMetadata = async (origin = null, scopeId = null) => {
      const records = await spool('list');
      const matching = records.filter((record) => record.completedLayer?.siteScope?.origin === origin && record.completedLayer?.siteScope?.scopeId === scopeId);
      const oldest = [...matching].sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0];
      return { count: matching.length, scopeId, expiresAt: oldest ? new Date(oldest.expiresAt).toISOString() : null, oldestAt: oldest ? new Date(oldest.enqueuedAt).toISOString() : null };
    };
    const unavailableActionMap = (reason) => ({ actionMap: null, actionMapStatus: { reason, status: 'unavailable' }, candidate: null });
    const currentActionMap = async (scopeId) => {
      let headResult;
      try {
        headResult = await requestRegistry(`/v1/action-maps/${encodeURIComponent(scopeId)}/head`);
      } catch (error) {
        return unavailableActionMap('Action-map registry is unavailable.');
      }
      if (headResult.response.status === 404) {
        return { actionMap: null, actionMapStatus: { status: 'no_map' }, candidate: null };
      }
      const head = headResult.body;
      if (
        !headResult.response.ok || !head || head.siteScopeId !== scopeId
        || !validRevision(head.revision) || !validDigest(head.digest)
      ) return unavailableActionMap('Action-map head was malformed or did not match this site scope.');

      let contextResult;
      try {
        contextResult = await requestRegistry(`/v1/action-maps/${encodeURIComponent(scopeId)}/context?revision=${head.revision}`);
      } catch (error) {
        return unavailableActionMap('Action-map context is unavailable.');
      }
      const context = contextResult.body;
      if (
        !contextResult.response.ok || !context || context.siteScopeId !== scopeId
        || context.revision !== head.revision || context.digest !== head.digest
        || !validDigest(context.digest) || !Array.isArray(context.actions)
      ) return unavailableActionMap('Action-map context was malformed or did not match the current revision.');

      return {
        actionMap: {
          actions: context.actions,
          digest: head.digest,
          revision: head.revision,
          scopeId,
          states: Array.isArray(context.states) ? context.states : [],
        },
        actionMapStatus: { status: 'available' },
        candidate: null,
      };
    };
    const currentCandidate = async ({ actionMap, scopeId }) => {
      const pointer = actionListCandidate(await get('session', candidateKey(scopeId)));
      if (!pointer || pointer.revision !== actionMap.revision) return null;
      let result;
      try {
        result = await requestRegistry(`/v1/action-lists/${encodeURIComponent(pointer.listId)}/revisions/${pointer.revision}`);
      } catch (error) {
        return null;
      }
      const document = result.body;
      if (
        !result.response.ok || unquotedETag(responseHeader(result.response, 'ETag')) !== pointer.digest
        || !document || document.listId !== pointer.listId
        || document.publication?.revision !== pointer.revision
      ) return null;
      let review;
      try {
        review = await requestRegistry(`/v1/action-lists/${encodeURIComponent(pointer.listId)}/revisions/${pointer.revision}/candidate-review`);
      } catch (error) {
        return null;
      }
      if (
        !review.response.ok || !review.body || review.body?.binding?.candidateDigest !== pointer.digest
        || review.body?.binding?.actionMapDigest !== actionMap.digest
        || review.body?.binding?.actionMapRevision !== actionMap.revision
      ) return null;
      return {
        actionMapDigest: actionMap.digest,
        actionMapRevision: actionMap.revision,
        actions: Array.isArray(document.actions) ? document.actions : [],
        contentDigest: pointer.digest,
        listDigest: pointer.digest,
        listId: pointer.listId,
        listRevision: pointer.revision,
        publication: document.publication,
        revision: pointer.revision,
        review: review.body,
        ...(review.body.policyDecision ? { policyDecision: review.body.policyDecision, policyDecisionId: review.body.policyDecision.id } : {}),
        ...(review.body.replayReport ? { replayReport: review.body.replayReport, replayReportId: review.body.replayReport.id } : {}),
        status: review.body.status,
        title: document.title || document.listId,
      };
    };

    const currentReviewCandidate = async (origin) => {
      const scopeId = ambientScope.scopeFor(origin);
      if (!scopeId) throw new Error('The active origin does not have an ambient scope');
      const mapState = await currentActionMap(scopeId);
      if (!mapState.actionMap) throw new Error('The exact action-map binding is unavailable');
      const candidate = await currentCandidate({ actionMap: mapState.actionMap, scopeId });
      if (!candidate || candidate.status !== 'candidate') throw new Error('No current candidate is available for review');
      return { candidate, mapState, scopeId };
    };

    const handleMessage = async (message, sender = {}) => {
      const extensionUiMessage = ['SUBMIT_CANDIDATE_REVIEW', 'SUBMIT_POLICY_DECISION', 'SET_OWNED_DEMO_OVERRIDE', 'REQUEST_RETRY_SPOOL_DELETION'].includes(message?.type);
      if (extensionUiMessage && (sender.tab || (sender.id && chromeApi.runtime?.id && sender.id !== chromeApi.runtime.id))) {
        return { ok: false, error: 'This decision is accepted only from trusted extension UI' };
      }
      const ambientMessage = String(message?.type || '').startsWith('AMBIENT_');
      if (ambientMessage && sender.tab?.id) {
        const hidden = Object.values(await getJobs()).some((job) => job.tabId === sender.tab.id && !['completed', 'failed'].includes(job.status));
        if (hidden) return { ok: false, error: 'Ambient capture is disabled in execution tabs' };
      }
      switch (message?.type) {
        case 'AMBIENT_POLICY_CURRENT': return { ok: true, policy: await currentPolicy(message) };
        case 'AMBIENT_NEXT_LAYER_SEQUENCE': return { ok: true, sequence: await lifecycle(message.scopeId, (state) => { state.nextLayerSequence += 1; return state.nextLayerSequence; }) };
        case 'AMBIENT_PUT_PENDING': return { ok: true, pending: await lifecycle(message.scopeId, (state) => { const key = String(sender.tab?.id ?? message.documentId); state.pending[key] = message.pending; return state.pending[key]; }) };
        case 'AMBIENT_CLEAR_PENDING': return { ok: true, cleared: await lifecycle(message.scopeId, (state) => { const key = String(sender.tab?.id ?? message.documentId); if (state.pending[key]?.observationId !== message.observationId) return false; delete state.pending[key]; return true; }) };
        case 'AMBIENT_CONSUME_PENDING': return { ok: true, pending: await lifecycle(message.scopeId, (state) => { const key = String(sender.tab?.id ?? message.documentId); const pending = state.pending[key] || null; delete state.pending[key]; return pending; }) };
        case 'AMBIENT_SPOOL_OPERATION': return { ok: true, result: await spool(message.operation, message.payload) };
        case 'AMBIENT_DELIVER_LAYER': return { ok: true, receipt: await deliverAmbientLayer(message.completedLayer) };
        case 'GET_POLICY_REVIEW_STATE': {
          const tabs = sender.tab ? [sender.tab] : (await chromeApi.tabs?.query?.({ active: true, lastFocusedWindow: true }) || []);
          const origin = originFromUrl(tabs[0]?.url);
          if (!origin) return { ok: true, state: { actionMapStatus: { status: 'no_map' }, context: { origin: null, requestedScope: 'ambient_learn' }, policy: { status: 'denied', scopes: [] }, retrySpool: { count: 0 } } };
          const stored = await get('local', policyKey(origin));
          const policy = await currentPolicy({ origin, scope: 'ambient_learn', revision: stored?.revision ?? null });
          const scopeId = ambientScope.scopeFor(origin);
          const mapState = await currentActionMap(scopeId);
          if (mapState.actionMap) {
            mapState.candidate = await currentCandidate({ actionMap: mapState.actionMap, scopeId });
          }
          return { ok: true, state: {
            ...mapState,
            context: {
              actionMapDigest: mapState.actionMap?.digest || null,
              actionMapRevision: mapState.actionMap?.revision || null,
              origin,
              policyRevision: policy?.revision ?? null,
              requestedScope: 'ambient_learn',
              siteScopeId: scopeId,
            },
            overrideAudit: stored?.overrideAudit || null,
            policy,
            retrySpool: await retryMetadata(origin, scopeId),
          } };
        }
        case 'SET_OWNED_DEMO_OVERRIDE':
        {
          const tabs = sender.tab ? [sender.tab] : await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
          const override = message.override;
          const origin = originFromUrl(tabs[0]?.url);
          if (origin !== 'http://127.0.0.1:4317' || override.origin !== origin || override.requestedScope !== 'ambient_learn') return { ok: false, error: 'Owned demo override is not valid for this active origin' };
          if (override.enabled === false && override.reasonCode === 'OWNED_DEMO_OVERRIDE_DISABLED') return { ok: true, policy: await savePolicy({ ...override, decision: 'revoked', scope: 'ambient_learn', source: 'owned_demo_override', overrideAudit: { enabled: false, actor: 'local user', changedAt: now(), reason: override.reasonCode } }, tabs[0]?.url) };
          if (Number.isNaN(Date.parse(override.acknowledgedAt || ''))) return { ok: false, error: 'Owned demo enable requires an acknowledgement time' };
          if (override.enabled !== true || override.reasonCode !== 'OWNED_DEMO_EXPLICIT_OVERRIDE') return { ok: false, error: 'Owned demo override is not valid for this active origin' };
          return { ok: true, policy: await savePolicy({ ...override, decision: 'allowed', scope: 'ambient_learn', source: 'owned_demo_override', overrideAudit: { enabled: true, actor: 'local user', changedAt: now(), reason: override.reasonCode } }, tabs[0]?.url) };
        }
        case 'SUBMIT_POLICY_DECISION': {
          const tabs = sender.tab ? [sender.tab] : await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
          const decision = message.decision || {};
          const origin = originFromUrl(tabs[0]?.url);
          if (!origin || (decision.origin && decision.origin !== origin) || !['denied', 'revoked'].includes(decision.decision) || decision.scope !== 'ambient_learn') return { ok: false, error: 'Only ambient deny or revoke decisions are supported' };
          return { ok: true, policy: await savePolicy(decision, origin) };
        }
        case 'REQUEST_RETRY_SPOOL_DELETION': {
          const tabs = sender.tab ? [sender.tab] : await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
          const origin = originFromUrl(tabs[0]?.url);
          const scopeId = ambientScope.scopeFor(origin);
          if (!origin || !scopeId) return { ok: false, error: 'An active HTTP(S) tab is required' };
          return { ok: true, ...(await spool('removeMatching', { origin, scopeId })) };
        }
        case 'SUBMIT_CANDIDATE_REVIEW': {
          const supplied = message.decision;
          if (!supplied || typeof supplied !== 'object' || !['approve', 'reject'].includes(supplied.decision)) return { ok: false, error: 'A complete candidate-review decision is required' };
          const tabs = await chromeApi.tabs?.query?.({ active: true, lastFocusedWindow: true }) || [];
          const origin = originFromUrl(tabs[0]?.url);
          if (!origin) return { ok: false, error: 'An active origin is required' };
          try {
            const { candidate, scopeId } = await currentReviewCandidate(origin);
            const expected = { actionMapDigest: candidate.actionMapDigest, actionMapRevision: candidate.actionMapRevision, listDigest: candidate.listDigest, listId: candidate.listId, listRevision: candidate.listRevision };
            if (supplied.decision === 'approve') Object.assign(expected, { policyDecisionId: candidate.policyDecisionId, replayReportId: candidate.replayReportId });
            if (Object.keys(expected).some((key) => supplied[key] !== expected[key])) throw new Error('Candidate-review envelope does not match the current authoritative binding');
            if (supplied.decision === 'reject') {
              const rejected = await requestBackend(`/v1/action-lists/${encodeURIComponent(candidate.listId)}/revisions/${candidate.listRevision}/candidate-review`, {
                body: JSON.stringify({ decision: supplied.decision, expectedDigest: candidate.listDigest }), method: 'POST',
              });
              return { ok: true, result: rejected };
            }
            const published = await requestBackend(`/v1/action-lists/${encodeURIComponent(candidate.listId)}/revisions/${candidate.listRevision}/candidate-review`, {
              body: JSON.stringify({
                decision: supplied.decision, expectedDigest: candidate.listDigest,
                policyDecisionId: supplied.policyDecisionId,
                replayReportId: supplied.replayReportId,
              }), method: 'POST',
            });
            if (published.status !== 'published') throw new Error('Candidate review did not produce a published revision');
            await chromeApi.storage.session.remove(candidateKey(scopeId));
            return { ok: true, result: published };
          } catch (error) {
            return { ok: false, error: `Candidate review was not accepted: ${error.message}` };
          }
        }
        case 'OPEN_CANDIDATE_EVIDENCE':
          return { ok: false, error: 'Candidate evidence is explicitly unavailable without an exact server-bound evidence resolver' };
        case 'SUBMIT_RUN_CONFIRMATION':
          return { ok: false, error: 'Run confirmation remains unavailable without an exact coordinator run and step binding' };
        case protocol.MESSAGE_TYPES.pageReady:
          return pageReady(sender);
        case protocol.MESSAGE_TYPES.getBackendHealth:
          return { ok: true, health: await requestBackend('/health') };
        case protocol.MESSAGE_TYPES.getAdapters:
          return { ok: true, ...(await getAdapters(message.origin)) };
        case protocol.MESSAGE_TYPES.startJob:
          return { ok: true, jobId: await startJob(message.adapter, message.args, message.sourceUrl, sender.tab?.id) };
        case protocol.MESSAGE_TYPES.getJob: {
          const job = (await getJobs())[message.jobId];
          if (!job) return { ok: false, error: 'Job not found' };
          if (['starting', 'running'].includes(job.status)) setTimeout(() => { void advanceJob(job.id); }, 0);
          return { ok: true, job };
        }
        case protocol.MESSAGE_TYPES.webMcpStatus:
          await set('session', 'webMcpStatus', { available: message.available, registered: message.registered || 0, tabId: sender.tab?.id || null, updatedAt: now() });
          return { ok: true };
        default: return { ok: false, error: 'Unknown extension message' };
      }
    };
    const onTabRemoved = (tabId) => {
      void getJobs().then((jobs) => {
        const job = Object.values(jobs).find((candidate) => (
          candidate.tabId === tabId && !['completed', 'failed'].includes(candidate.status)
        ));
        if (job) {
          void finishJob(job.id, 'failed', {
            error: 'The background execution tab was closed',
            failedStep: job.stepIndex,
          });
        }
      });
    };
    return Object.freeze({ handleMessage, onTabRemoved, retryMetadata, retrySpoolReady: Boolean(retrySpoolApi) });
  };

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    const coordinator = createCoordinator();
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      coordinator.handleMessage(message, sender).then(sendResponse).catch((error) => sendResponse(publicErrors?.legacyResponseFor?.(error) || { ok: false, error: error.message }));
      return true;
    });
    chrome.tabs.onRemoved.addListener(coordinator.onTabRemoved);
  };
  return Object.freeze({ createCoordinator, start });
}));
