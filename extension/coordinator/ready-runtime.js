(function initializeReadyRuntime(root, factory) {
  const isCommonJS = typeof module !== 'undefined' && module.exports;
  const api = factory(
    isCommonJS ? require('./run-coordinator.js') : root.WebMcpRunCoordinator,
    isCommonJS ? require('./chrome-adapters.js') : root.WebMcpChromeCoordinatorAdapters,
    isCommonJS ? require('../shared/protocol.js') : root.WebMcpProtocol,
    root,
  );

  if (isCommonJS) module.exports = api;
  root.WebMcpReadyRuntime = api;
}(typeof globalThis === 'undefined' ? this : globalThis, (
  runCoordinatorApi,
  chromeAdapters,
  protocol,
  root,
) => {
  'use strict';

  const BACKEND = 'http://127.0.0.1:4317';
  const MESSAGE_TYPES = Object.freeze({
    getPolicyReviewState: 'GET_POLICY_REVIEW_STATE',
    submitRunConfirmation: 'SUBMIT_RUN_CONFIRMATION',
  });
  const HANDLED_MESSAGES = new Set(Object.values(MESSAGE_TYPES));
  const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

  const cloneJson = (value) => JSON.parse(JSON.stringify(value));

  const validateActionList = (list) => ({
    valid: Boolean(
      list
      && list.schemaVersion === 'action-list/1'
      && typeof list.listId === 'string'
      && list.publication?.status === 'published'
      && DIGEST_PATTERN.test(list.publication?.contentDigest || '')
      && list.policy?.status === 'allowed'
      && Array.isArray(list.policy?.scopes)
      && typeof list.site?.origin === 'string'
      && Array.isArray(list.site?.routePatterns)
      && Array.isArray(list.states)
      && Array.isArray(list.actions)
      && list.actions.length > 0
    ),
  });

  const policyRevisionFor = (listOrRun) => (
    listOrRun?.policy?.checkedAt
    || listOrRun?.listPolicy?.checkedAt
    || listOrRun?.publication?.contentDigest
    || listOrRun?.listDigest
    || null
  );

  const createReadyRuntime = (options = {}) => {
    const chromeApi = options.chromeApi || root.chrome;
    const fetchApi = options.fetchApi || root.fetch.bind(root);
    const backend = options.backend || BACKEND;
    const request = async (path, requestOptions = {}) => {
      const { timeoutMs = 5000, ...fetchOptions } = requestOptions;
      const controller = new AbortController();
      const timeout = root.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchApi(`${backend}${path}`, {
          ...fetchOptions,
          headers: {
            'Content-Type': 'application/json',
            ...(fetchOptions.headers || {}),
          },
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error || `Backend request failed with status ${response.status}`);
        }
        return body;
      } catch (error) {
        if (controller.signal.aborted) throw new Error('Backend request timed out');
        throw error;
      } finally {
        root.clearTimeout(timeout);
      }
    };

    const discoverActionLists = async ({ origin, url }) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (error) {
        throw new Error('Action-list discovery requires an absolute page URL');
      }
      if (parsed.origin !== origin) {
        throw new Error('Action-list discovery origin does not match the page URL');
      }
      const query = new URLSearchParams({ origin, url: parsed.href });
      const body = await request(`/v1/action-lists?${query.toString()}`);
      if (!Array.isArray(body.actionLists)) {
        throw new Error('Action-list discovery returned an invalid response');
      }
      return body.actionLists.filter((list) => validateActionList(list).valid);
    };

    const registry = {
      async resolveExact({ actionId, actionVersion, expectedDigest, listId, revision }) {
        if (!Number.isInteger(revision) || revision < 1 || !DIGEST_PATTERN.test(expectedDigest)) {
          throw new Error('The exact published action reference is invalid');
        }
        const list = await request(
          `/v1/action-lists/${encodeURIComponent(listId)}/revisions/${revision}`,
        );
        const actionMatches = list.actions?.filter((action) => (
          action.id === actionId && action.version === actionVersion
        )) || [];
        if (!validateActionList(list).valid
          || list.listId !== listId
          || list.publication.revision !== revision
          || list.publication.contentDigest !== expectedDigest
          || actionMatches.length !== 1) {
          throw new Error('The exact published action is unavailable or ambiguous');
        }
        return {
          digest: list.publication.contentDigest,
          list: cloneJson(list),
        };
      },
    };

    const storage = options.storage
      || chromeAdapters.createChromeRunStorage(chromeApi.storage.local);
    const localObservations = options.localObservations
      || chromeAdapters.createChromeObservationStore(chromeApi.storage.local);
    const observations = options.observations || {
      async save(observation) {
        await localObservations.save(observation);
        await request('/v1/run-observations', {
          method: 'POST',
          body: JSON.stringify(observation),
        }).catch(() => {});
      },
    };
    const tabs = options.tabs
      || chromeAdapters.createChromeTabs(chromeApi, chromeApi.storage.local);
    const coordinator = options.coordinator || new runCoordinatorApi.DurableRunCoordinator({
      observations,
      registry,
      storage,
      tabs,
      validateActionList,
    });

    const reviewPort = {
      name: runCoordinatorApi.PORT_NAMES.review,
      sender: { url: chromeApi.runtime?.getURL?.('popup.html') || 'chrome-extension://local/popup.html' },
      onMessage: { addListener() {} },
      onDisconnect: { addListener() {} },
      postMessage() {},
    };
    const reviewBinding = coordinator.bindPort(reviewPort);
    let started = false;

    const currentRunBinding = (run) => {
      let origin = null;
      try {
        origin = new URL(run.source.url).origin;
      } catch (error) {
        origin = null;
      }
      const boundary = run.confirmation?.boundary || 'before_step';
      const page = boundary === 'before_run' ? {
        documentId: run.source.documentId,
        navigationSequence: null,
        pageRevision: null,
        stateId: null,
        url: run.source.url,
      } : run.execution;
      const actorSenderKey = boundary === 'before_run'
        ? null
        : `execution_content:${run.execution.tabId}:${run.execution.documentId}`;
      return {
        actorSequence: actorSenderKey
          ? run.lastAcceptedSequenceBySender?.[actorSenderKey] || 0
          : null,
        boundary,
        confirmationId: run.confirmation?.binding?.confirmationId || null,
        documentId: page.documentId,
        listDigest: run.listDigest,
        navigationSequence: page.navigationSequence,
        origin,
        pageRevision: page.pageRevision,
        policyRevision: policyRevisionFor(run),
        stateId: page.stateId,
        stepId: run.confirmation?.stepId || null,
        url: page.url,
      };
    };

    const confirmationState = (run) => {
      if (!run) return { confirmation: null, context: {}, policy: null };
      const binding = cloneJson(run.confirmation.binding || currentRunBinding(run));
      const currentBinding = currentRunBinding(run);
      const stepIndex = run.action.steps.findIndex(({ id }) => id === binding.stepId);
      return {
        confirmation: {
          actionTitle: run.action.tool.title,
          argumentPreview: cloneJson(run.confirmation.argumentPreview || {}),
          binding,
          boundary: binding.boundary,
          documentId: binding.documentId,
          listDigest: binding.listDigest,
          origin: binding.origin,
          policyRevision: binding.policyRevision,
          runId: run.runId,
          sensitiveArguments: cloneJson(run.action.safety.sensitiveArguments || []),
          step: cloneJson(run.action.steps[stepIndex]),
          stepId: binding.stepId,
          stepIndex,
          summary: run.confirmation.summary,
        },
        context: {
          ...currentBinding,
          requestedScope: run.action.safety.class,
        },
        policy: {
          checkedAt: run.listPolicy.checkedAt,
          decision: run.listPolicy.status,
          expiresAt: run.listPolicy.expiresAt,
          origin: binding.origin,
          reasonCode: run.policyDecision?.reasonCode || 'PUBLISHED_POLICY_ALLOWED',
          revision: binding.policyRevision,
          scopes: cloneJson(run.listPolicy.scopes),
          source: run.listPolicy.basis,
        },
      };
    };

    const getPolicyReviewState = async () => {
      const runs = await storage.list();
      const pending = runs
        .filter((run) => run.status === 'awaiting_confirmation')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null;
      return confirmationState(pending);
    };

    const sameBinding = (left, right) => (
      left
      && right
      && [
        'actorSequence',
        'boundary',
        'confirmationId',
        'documentId',
        'listDigest',
        'navigationSequence',
        'origin',
        'pageRevision',
        'policyRevision',
        'stateId',
        'stepId',
        'url',
      ]
        .every((field) => left[field] === right[field])
    );

    const submitRunConfirmation = async (decision) => {
      if (!decision || typeof decision.approved !== 'boolean'
        || typeof decision.runId !== 'string' || typeof decision.stepId !== 'string') {
        throw new Error('An exact run confirmation decision is required');
      }
      const run = await storage.load(decision.runId);
      if (!run || run.status !== 'awaiting_confirmation'
        || run.confirmation?.stepId !== decision.stepId) {
        throw new Error('The run confirmation is no longer pending');
      }
      const exactBinding = run.confirmation.binding;
      if (!sameBinding(decision.binding, exactBinding)) {
        throw new Error('The run confirmation binding is stale');
      }

      const senderKey = 'review_ui:none:none';
      const sequence = (run.lastAcceptedSequenceBySender?.[senderKey] || 0) + 1;
      const accepted = await coordinator.receive(reviewPort, reviewBinding, protocol.createEnvelope({
        type: protocol.RUN_MESSAGE_TYPES.runConfirm,
        requestId: run.requestId,
        runId: run.runId,
        sequence,
        sender: { context: 'review_ui', documentId: null, tabId: null },
        payload: { approved: decision.approved, stepId: decision.stepId },
      }));
      if (!accepted) throw new Error('The run confirmation was rejected');
      return getPolicyReviewState();
    };

    const handleMessage = async (message) => {
      if (message.type === MESSAGE_TYPES.getPolicyReviewState) {
        return { ok: true, state: await getPolicyReviewState() };
      }
      if (message.type === MESSAGE_TYPES.submitRunConfirmation) {
        return { ok: true, state: await submitRunConfirmation(message.decision) };
      }
      return { ok: false, error: 'Unknown ready-runtime message' };
    };

    const start = () => {
      if (started) return coordinator;
      started = true;
      if (chromeApi.runtime?.onConnect && chromeApi.tabs?.onRemoved) {
        chromeAdapters.installChromeCoordinator({ chromeApi, coordinator });
      } else {
        void coordinator.recover();
      }
      return coordinator;
    };

    return {
      coordinator,
      discoverActionLists,
      getPolicyReviewState,
      handleMessage,
      handlesMessage: (message) => HANDLED_MESSAGES.has(message?.type),
      registry,
      start,
      submitRunConfirmation,
      validateActionList,
    };
  };

  let defaultRuntime = null;
  const getDefaultRuntime = () => {
    if (!defaultRuntime) defaultRuntime = createReadyRuntime();
    return defaultRuntime;
  };

  return {
    MESSAGE_TYPES,
    createReadyRuntime,
    discoverActionLists: (...args) => getDefaultRuntime().discoverActionLists(...args),
    handleMessage: (...args) => getDefaultRuntime().handleMessage(...args),
    handlesMessage: (...args) => getDefaultRuntime().handlesMessage(...args),
    start: () => getDefaultRuntime().start(),
    validateActionList,
  };
}));
