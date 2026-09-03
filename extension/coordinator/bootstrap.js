(function initializeCoordinatorBootstrap(root, factory) {
  const api = factory(
    root.WebMcpAmbientRetrySpool,
    root.WebMcpErrors,
    root.WebMcpProtocol || (typeof module === 'object' && module.exports ? require('../shared/protocol.js') : null),
    root.WebMcpAmbientScope || (typeof module === 'object' && module.exports ? require('../shared/ambient-scope.js') : null),
    root.WebMcpRunCoordinator || (typeof module === 'object' && module.exports ? require('./run-coordinator.js') : null),
    root.WebMcpChromeCoordinatorAdapters || (typeof module === 'object' && module.exports ? require('./chrome-adapters.js') : null),
    root.WebMcpCandidateReplay || (typeof module === 'object' && module.exports ? require('./candidate-replay.js') : null),
  );
  root.WebMcpCoordinatorBootstrap = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'undefined' ? this : globalThis, (retrySpool, publicErrors, protocol, ambientScope, runCoordinatorApi, chromeAdapters, candidateReplayApi) => {
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
    candidateReplayRunner = null,
    durableCoordinator = null,
    fetchApi = fetch,
    isExecutionTab = async () => false,
    now = () => new Date().toISOString(),
    retrySpoolApi = retrySpool,
  } = {}) => {
    let queue = Promise.resolve();
    let storage = null;
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
    const confirmationFor = async ({ origin, runId = null } = {}) => {
      if (!durableCoordinator) return null;
      const runs = await durableCoordinator.storage.list();
      const record = runs.find((run) => (
        run.status === 'awaiting_confirmation'
        && (!runId || run.runId === runId)
        && (!origin || run.site?.origin === origin)
      ));
      if (!record) return null;
      const stepIndex = record.action.steps.findIndex(({ id }) => id === record.confirmation.stepId);
      return {
        actionTitle: record.action.tool.title,
        argumentPreview: record.confirmation.argumentPreview,
        documentId: record.execution.documentId,
        listDigest: record.listDigest,
        origin: record.site.origin,
        policy: {
          ...record.listPolicy,
          origin: record.site.origin,
          policyRevision: record.listPolicy?.checkedAt || record.policyDecision?.checkedAt,
        },
        policyRevision: record.listPolicy?.checkedAt || record.policyDecision?.checkedAt,
        requiredScope: record.action.safety.class,
        runId: record.runId,
        sensitiveArguments: record.action.safety.sensitiveArguments,
        step: record.action.steps[stepIndex] || null,
        stepId: record.confirmation.stepId,
        stepIndex,
        summary: record.confirmation.summary,
      };
    };

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
      const response = await fetchApi(`http://127.0.0.1:4317${path}`, { headers: { 'X-WebMCP-Internal': 'ambient-v1' } });
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
    const getAdapters = async (origin, sourceUrl) => {
      const url = sourceUrl || origin;
      const result = await requestRegistry(
        `/v1/action-lists?origin=${encodeURIComponent(origin)}&url=${encodeURIComponent(url)}`,
      );
      if (!result.response.ok || !Array.isArray(result.body?.actionLists)) {
        throw new Error('Published action-list discovery was unavailable');
      }
      return { actionLists: result.body.actionLists, stale: false };
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
      const extensionUiMessage = [
        'GET_POLICY_REVIEW_STATE',
        'OPEN_CANDIDATE_EVIDENCE',
        'REQUEST_RETRY_SPOOL_DELETION',
        'SET_OWNED_DEMO_OVERRIDE',
        'START_CANDIDATE_REPLAY',
        'SUBMIT_CANDIDATE_REVIEW',
        'SUBMIT_POLICY_DECISION',
        'SUBMIT_RUN_CONFIRMATION',
      ].includes(message?.type);
      if (extensionUiMessage && (sender.tab || (sender.id && chromeApi.runtime?.id && sender.id !== chromeApi.runtime.id))) {
        return { ok: false, error: 'This decision is accepted only from trusted extension UI' };
      }
      const ambientMessage = String(message?.type || '').startsWith('AMBIENT_');
      if (ambientMessage && sender.tab?.id && await isExecutionTab(sender.tab.id)) {
        return { ok: false, error: 'Ambient capture is disabled in execution tabs' };
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
          const confirmation = await confirmationFor({ origin });
          return { ok: true, state: {
            ...mapState,
            context: {
              actionMapDigest: mapState.actionMap?.digest || null,
              actionMapRevision: mapState.actionMap?.revision || null,
              documentId: confirmation?.documentId || null,
              listDigest: confirmation?.listDigest || mapState.candidate?.listDigest || null,
              listRevision: mapState.candidate?.listRevision || null,
              origin,
              policyRevision: confirmation?.policyRevision ?? policy?.revision ?? null,
              runId: confirmation?.runId || null,
              requestedScope: 'ambient_learn',
              siteScopeId: scopeId,
              stepId: confirmation?.stepId || null,
            },
            confirmation,
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
        case 'START_CANDIDATE_REPLAY':
        {
          if (!candidateReplayRunner) return { ok: false, error: 'Candidate actor replay is unavailable' };
          const tabs = await chromeApi.tabs?.query?.({ active: true, lastFocusedWindow: true }) || [];
          const sourceTab = tabs[0];
          const origin = originFromUrl(sourceTab?.url);
          try {
            const { candidate } = await currentReviewCandidate(origin);
            const exact = await requestRegistry(`/v1/action-lists/${encodeURIComponent(candidate.listId)}/revisions/${candidate.listRevision}`);
            if (!exact.response.ok || unquotedETag(responseHeader(exact.response, 'ETag')) !== candidate.listDigest) {
              throw new Error('Candidate action list changed before replay');
            }
            const report = await candidateReplayRunner.runCandidate({
              digest: candidate.listDigest,
              list: exact.body,
              sourceTabId: sourceTab.id,
              sourceUrl: sourceTab.url,
            });
            const result = await requestBackend(`/v1/action-lists/${encodeURIComponent(candidate.listId)}/revisions/${candidate.listRevision}/candidate-review/replay`, {
              body: JSON.stringify({ expectedDigest: candidate.listDigest, report }),
              method: 'POST',
            });
            return { ok: true, result };
          } catch (error) {
            return { ok: false, error: `Candidate replay failed: ${error.message}` };
          }
        }
        case 'OPEN_CANDIDATE_EVIDENCE':
        {
          const reference = message.reference || {};
          if (typeof reference.id !== 'string' || reference.id.length === 0) {
            return { ok: false, error: 'Candidate evidence was not resolved: A bounded evidence reference is required' };
          }
          const tabs = await chromeApi.tabs?.query?.({ active: true, lastFocusedWindow: true }) || [];
          const origin = originFromUrl(tabs[0]?.url);
          try {
            const { candidate } = await currentReviewCandidate(origin);
            if (reference.actionMapDigest && reference.actionMapDigest !== candidate.actionMapDigest) {
              throw new Error('Evidence reference does not match the current action-map binding');
            }
            const result = await requestBackend(`/v1/action-lists/${encodeURIComponent(candidate.listId)}/revisions/${candidate.listRevision}/candidate-review/evidence/${encodeURIComponent(reference.id)}`);
            return { ok: true, result };
          } catch (error) {
            return { ok: false, error: `Candidate evidence was not resolved: ${error.message}` };
          }
        }
        case 'SUBMIT_RUN_CONFIRMATION':
        {
          if (!durableCoordinator) {
            return { ok: false, error: 'No matching exact coordinator run confirmation is pending' };
          }
          const supplied = message.decision || {};
          const tabs = await chromeApi.tabs?.query?.({ active: true, lastFocusedWindow: true }) || [];
          const origin = originFromUrl(tabs[0]?.url);
          const expected = await confirmationFor({ origin, runId: supplied.runId });
          if (!expected || typeof supplied.approved !== 'boolean') {
            return { ok: false, error: 'No matching exact coordinator run confirmation is pending' };
          }
          const fields = ['runId', 'listDigest', 'stepId', 'origin', 'documentId', 'policyRevision'];
          if (fields.some((field) => supplied[field] !== expected[field])) {
            return { ok: false, error: 'Run confirmation does not match the current exact binding' };
          }
          await durableCoordinator.submitConfirmation({
            approved: supplied.approved,
            runId: expected.runId,
            stepId: expected.stepId,
          });
          return { ok: true };
        }
        case protocol.MESSAGE_TYPES.pageReady:
          if (Number.isInteger(sender.tab?.id)) {
            void Promise.resolve(chromeApi.tabs.sendMessage?.(sender.tab.id, {
              type: protocol.MESSAGE_TYPES.refreshAdapters,
            })).catch(() => {});
          }
          return { recordingActive: false, recordingId: null };
        case protocol.MESSAGE_TYPES.getBackendHealth:
          return { ok: true, health: await requestBackend('/health') };
        case protocol.MESSAGE_TYPES.getAdapters:
          return { ok: true, ...(await getAdapters(message.origin, sender.tab?.url)) };
        case protocol.MESSAGE_TYPES.webMcpStatus:
          await set('session', 'webMcpStatus', { available: message.available, registered: message.registered || 0, tabId: sender.tab?.id || null, updatedAt: now() });
          return { ok: true };
        default: return { ok: false, error: 'Unknown extension message' };
      }
    };
    return Object.freeze({ handleMessage, retryMetadata, retrySpoolReady: Boolean(retrySpoolApi) });
  };

  const createDurableCoordinator = ({ chromeApi = chrome, fetchApi = fetch, now, tabs = null } = {}) => {
    if (!runCoordinatorApi?.DurableRunCoordinator || !chromeAdapters) {
      throw new Error('Durable run coordinator dependencies are unavailable');
    }
    const area = chromeApi.storage.local;
    const localObservations = chromeAdapters.createChromeObservationStore(area);
    return new runCoordinatorApi.DurableRunCoordinator({
      storage: chromeAdapters.createChromeRunStorage(area),
      observations: {
        async save(observation) {
          await localObservations.save(observation);
          const response = await fetchApi('http://127.0.0.1:4317/v1/run-observations', {
            body: JSON.stringify(observation),
            headers: { 'Content-Type': 'application/json', 'X-WebMCP-Internal': 'ambient-v1' },
            method: 'POST',
          }).catch(() => null);
          const body = await response?.json?.().catch(() => null);
          if (!response?.ok) throw new Error('Run observation feedback delivery failed');
          const candidate = body?.actionListCandidate;
          const scopeId = body?.feedback?.scopeId;
          if (response?.ok && scopeId && candidate?.status === 'candidate'
            && validRevision(candidate.revision) && validDigest(candidate.digest)) {
            await chromeApi.storage.session.set({
              [`${CANDIDATE_PREFIX}${scopeId}`]: {
                digest: candidate.digest,
                listId: candidate.listId,
                revision: candidate.revision,
                status: candidate.status,
              },
            });
          }
        },
      },
      tabs: tabs || chromeAdapters.createChromeTabs(chromeApi, area),
      ...(now ? { now } : {}),
      registry: {
        async resolveExact({ actionId, actionVersion, listId }) {
          const response = await fetchApi(
            `http://127.0.0.1:4317/v1/action-lists/${encodeURIComponent(listId)}/revisions/${actionVersion}`,
            { headers: { 'X-WebMCP-Internal': 'ambient-v1' } },
          );
          const list = await response.json().catch(() => null);
          if (!response.ok || !list || !list.actions?.some((action) => (
            action.id === actionId && action.version === actionVersion
          ))) throw new Error('Exact published action was unavailable');
          return {
            digest: response.headers?.get?.('X-Content-Digest')
              || list.publication?.contentDigest,
            list,
          };
        },
      },
    });
  };

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    const tabs = chromeAdapters.createChromeTabs(chrome, chrome.storage.local);
    const durable = createDurableCoordinator({ tabs });
    const replayTabs = {
      ...tabs,
      // Candidate replay always gets a fresh isolated actor tab. Sharing a reusable
      // execution tab could cross-bind a live run to the replay-only coordinator.
      findReusable: async () => null,
    };
    const replay = candidateReplayApi?.createReplayRunner?.({ chromeApi: chrome, tabs: replayTabs });
    chromeAdapters.installChromeCoordinator({
      chromeApi: chrome,
      coordinator: durable,
      portHandlers: replay ? { [candidateReplayApi.PORT_NAME]: replay.bindPort } : {},
      tabClosedHandlers: replay ? [replay.tabClosed] : [],
    });
    const coordinator = createCoordinator({
      candidateReplayRunner: replay,
      durableCoordinator: durable,
      isExecutionTab: async (tabId) => (await durable.storage.list()).some((run) => (
        run.execution?.tabId === tabId && !['completed', 'failed', 'cancelled'].includes(run.status)
      )),
    });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      coordinator.handleMessage(message, sender).then(sendResponse).catch((error) => sendResponse(publicErrors?.legacyResponseFor?.(error) || { ok: false, error: error.message }));
      return true;
    });
  };
  return Object.freeze({ createCoordinator, createDurableCoordinator, start });
}));
