(function initializeSourceBootstrap(root, factory) {
  const isCommonJS = typeof module !== 'undefined' && module.exports;
  const sourceBootstrap = factory(
    isCommonJS ? require('../shared/protocol.js') : root.WebMcpProtocol,
    isCommonJS ? require('../shared/errors.js') : root.WebMcpErrors,
    root,
  );

  if (isCommonJS) module.exports = sourceBootstrap;
  root.WebMcpSourceBootstrap = sourceBootstrap;
}(typeof globalThis === 'undefined' ? this : globalThis, (protocol, publicErrors, root) => {
  'use strict';

  const {
    MESSAGE_TYPES,
    RUN_MESSAGE_TYPES,
    RUN_PROTOCOL,
    createEnvelope,
    createMessage,
    isMessage,
    sendRuntimeMessage,
  } = protocol;

  const PORT_NAME = 'webmcp-run/1:source';
  const ACTION_LIST_VERSION = 'action-list/1';
  const MAX_MESSAGE_BYTES = 64 * 1024;
  const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
  const TERMINAL_MESSAGE_TYPES = new Set([
    RUN_MESSAGE_TYPES.runError,
    RUN_MESSAGE_TYPES.runResult,
  ]);
  const COORDINATOR_MESSAGE_TYPES = new Set([
    RUN_MESSAGE_TYPES.runAccepted,
    ...TERMINAL_MESSAGE_TYPES,
  ]);
  const ALLOWED_ERROR_CODES = new Set(Object.values(publicErrors.PUBLIC_ERROR_CODES));

  const isPlainObject = (value) => (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null)
  );

  const cloneJson = (value) => JSON.parse(JSON.stringify(value));

  const jsonByteLength = (value) => {
    const serialized = JSON.stringify(value);
    if (typeof root.TextEncoder === 'function') {
      return new root.TextEncoder().encode(serialized).byteLength;
    }
    return serialized.length;
  };

  const validateProperty = (value, schema, path) => {
    const errors = [];
    const expectedType = schema.type;
    const typeMatches = (
      (expectedType === 'string' && typeof value === 'string')
      || (expectedType === 'number' && typeof value === 'number' && Number.isFinite(value))
      || (expectedType === 'integer' && Number.isInteger(value))
      || (expectedType === 'boolean' && typeof value === 'boolean')
    );

    if (!typeMatches) return [`${path} must be a ${expectedType}`];

    if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => allowed === value)) {
      errors.push(`${path} must be one of the allowed values`);
    }
    if (typeof value === 'string') {
      if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
        errors.push(`${path} must contain at least ${schema.minLength} characters`);
      }
      if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
        errors.push(`${path} must contain at most ${schema.maxLength} characters`);
      }
    }
    if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum) {
        errors.push(`${path} must be at least ${schema.minimum}`);
      }
      if (typeof schema.maximum === 'number' && value > schema.maximum) {
        errors.push(`${path} must be at most ${schema.maximum}`);
      }
    }

    return errors;
  };

  const validateArguments = (input, schema) => {
    if (!isPlainObject(input)) {
      return { valid: false, errors: ['arguments must be an object'] };
    }
    if (!isPlainObject(schema)
      || schema.type !== 'object'
      || !isPlainObject(schema.properties)
      || !Array.isArray(schema.required)
      || schema.additionalProperties !== false) {
      return { valid: false, errors: ['tool inputSchema is not supported'] };
    }

    const errors = [];
    const propertyNames = new Set(Object.keys(schema.properties));
    schema.required.forEach((name) => {
      if (!Object.prototype.hasOwnProperty.call(input, name)) {
        errors.push(`arguments.${name} is required`);
      }
    });
    Object.entries(input).forEach(([name, value]) => {
      if (!propertyNames.has(name)) {
        errors.push(`arguments.${name} is not allowed`);
        return;
      }
      errors.push(...validateProperty(value, schema.properties[name], `arguments.${name}`));
    });

    return { valid: errors.length === 0, errors };
  };

  const publicFailure = (code, message, options = {}) => {
    const error = new Error(message);
    Object.assign(error, publicErrors.createPublicError(code, message, options));
    return error;
  };

  const cancellationFailure = (message = 'The WebMCP execution was cancelled') => {
    const error = new Error(message);
    error.name = 'AbortError';
    error.code = publicErrors.PUBLIC_ERROR_CODES.cancelled;
    error.stepId = null;
    error.retryable = false;
    error.observed = {};
    return error;
  };

  const regexMatches = (patterns, value) => patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(value);
    } catch (error) {
      return false;
    }
  });

  const routeMatches = (routePatterns, url) => {
    try {
      const currentUrl = new URL(url);
      return regexMatches(routePatterns, currentUrl.pathname + currentUrl.search);
    } catch (error) {
      return false;
    }
  };

  const requiredPolicyScope = (action) => {
    if (action.safety?.class === 'danger') return 'danger';
    if (action.safety?.writesExternalState) return 'write';
    return 'read';
  };

  const listIsEligible = (list, url, currentTime) => {
    if (!isPlainObject(list)
      || list.schemaVersion !== ACTION_LIST_VERSION
      || list.publication?.status !== 'published'
      || !Number.isInteger(list.publication?.revision)
      || list.publication.revision < 1
      || !DIGEST_PATTERN.test(list.publication?.contentDigest || '')
      || list.policy?.status !== 'allowed'
      || !Array.isArray(list.policy?.scopes)
      || !list.policy.scopes.includes('inject')
      || !Array.isArray(list.site?.routePatterns)
      || !Array.isArray(list.actions)
      || !Number.isFinite(Date.parse(list.policy.checkedAt))) {
      return false;
    }

    let currentUrl;
    try {
      currentUrl = new URL(url);
    } catch (error) {
      return false;
    }
    if (currentUrl.origin !== list.site.origin
      || !routeMatches(list.site.routePatterns, currentUrl.href)) {
      return false;
    }
    if (list.policy.expiresAt) {
      const expiresAt = Date.parse(list.policy.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= currentTime.getTime()) return false;
    }
    return true;
  };

  const actionIsEligible = (list, action, url) => (
    isPlainObject(action)
    && action.lifecycle === 'published'
    && Number.isInteger(action.version)
    && isPlainObject(action.tool)
    && isPlainObject(action.tool.inputSchema)
    && isPlainObject(action.tool.annotations)
    && typeof action.tool.name === 'string'
    && typeof action.tool.title === 'string'
    && typeof action.tool.description === 'string'
    && Array.isArray(action.precondition?.urlPatterns)
    && regexMatches(action.precondition.urlPatterns, url)
    && list.policy.scopes.includes(requiredPolicyScope(action))
  );

  const registrationKeyFor = (list, action) => [
    list.publication.contentDigest,
    action.id,
    action.version,
  ].join(':');

  const actionReferenceFor = (list, action) => Object.freeze({
    actionId: action.id,
    actionVersion: action.version,
    inputSchema: cloneJson(action.tool.inputSchema),
    listDigest: list.publication.contentDigest,
    listId: list.listId,
    listRevision: list.publication.revision,
    registrationKey: registrationKeyFor(list, action),
  });

  const projectTool = (action, execute) => ({
    name: action.tool.name,
    title: action.tool.title,
    description: action.tool.description,
    inputSchema: cloneJson(action.tool.inputSchema),
    annotations: cloneJson(action.tool.annotations),
    execute,
  });

  const createSourceBridge = (options = {}) => {
    const runtime = options.runtime || root.chrome?.runtime;
    const documentObject = options.documentObject || root.document;
    const windowObject = options.windowObject || root.window;
    const locationObject = options.locationObject || root.location;
    const now = options.now || (() => new Date());
    const randomId = options.randomId || (() => root.crypto.randomUUID());
    const schedule = options.schedule || ((callback, delay) => root.setTimeout(callback, delay));
    const cancelSchedule = options.cancelSchedule || ((timer) => root.clearTimeout(timer));
    const reconnectDelayMs = options.reconnectDelayMs ?? 25;
    const maxReconnectAttempts = options.maxReconnectAttempts ?? 4;
    const discoveryRetryDelayMs = options.discoveryRetryDelayMs ?? 250;
    const maxDiscoveryRetryAttempts = options.maxDiscoveryRetryAttempts ?? 4;
    const refreshActionLists = options.refreshActionLists || null;
    const modelContext = options.modelContext || documentObject?.modelContext;
    const registrationControllers = new Map();
    const registrationKeysByName = new Map();
    const requests = new Map();
    const outbox = new Map();
    let actionLists = [];
    let currentUrl = locationObject?.href || '';
    let port = null;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    let discoveryRetryTimer = null;
    let discoveryRetryAttempts = 0;
    let pageHidden = false;
    let started = false;
    let stopped = false;
    let refreshGeneration = 0;
    let registrationQueue = Promise.resolve();

    const staleRegistrationResult = () => ({
      available: typeof modelContext?.registerTool === 'function',
      registered: registrationControllers.size,
      stale: true,
    });

    const outboxKey = (requestId, type) => `${requestId}:${type}`;

    const cleanupRequest = (record) => {
      requests.delete(record.requestId);
      outbox.delete(outboxKey(record.requestId, RUN_MESSAGE_TYPES.runRequest));
      outbox.delete(outboxKey(record.requestId, RUN_MESSAGE_TYPES.runCancel));
      record.signal?.removeEventListener?.('abort', record.abortListener);
    };

    const settleRequest = (record, kind, value, cleanup = true) => {
      if (!record.settled) {
        record.settled = true;
        if (kind === 'resolve') record.resolve(value);
        else record.reject(value);
      }
      if (cleanup) cleanupRequest(record);
    };

    const acknowledgeTerminal = (record, terminalSequence) => {
      if (!port || !record.runId) return;
      port.postMessage(createEnvelope({
        type: RUN_MESSAGE_TYPES.runAck,
        requestId: record.requestId,
        runId: record.runId,
        sequence: terminalSequence + 1,
        sentAt: now().toISOString(),
        sender: { context: 'source_content', tabId: null, documentId: null },
        payload: { terminalSequence },
      }));
    };

    const failTransport = () => {
      const failure = publicFailure(
        publicErrors.PUBLIC_ERROR_CODES.transportDisconnected,
        'The extension transport could not reconnect',
        { retryable: true },
      );
      requests.forEach((record) => settleRequest(record, 'reject', failure));
      outbox.clear();
    };

    const postOutbox = () => {
      if (!port) return;
      outbox.forEach((message) => port.postMessage(message));
    };

    function handlePortMessage(message) {
      if (!isPlainObject(message)) return;
      try {
        if (jsonByteLength(message) > MAX_MESSAGE_BYTES) return;
      } catch (error) {
        return;
      }
      const record = requests.get(message?.requestId);
      if (!record || !validCoordinatorEnvelope(message, record)) return;

      if (message.type === RUN_MESSAGE_TYPES.runAccepted) {
        if (!isPlainObject(message.payload)
          || message.payload.planDigest !== record.action.listDigest
          || !Number.isInteger(message.payload.executionTabId)) {
          return;
        }
        reconnectAttempts = 0;
        record.lastSequence = message.sequence;
        record.runId = message.runId;
        outbox.delete(outboxKey(record.requestId, RUN_MESSAGE_TYPES.runRequest));
        if (record.cancelRequested) sendCancellation(record);
        return;
      }

      if (message.type === RUN_MESSAGE_TYPES.runResult) {
        if (!isPlainObject(message.payload)
          || message.payload.actionId !== record.action.actionId
          || message.payload.actionVersion !== record.action.actionVersion
          || !isPlainObject(message.payload.evidence)
          || !Array.isArray(message.payload.evidence.completedSteps)) {
          return;
        }
        reconnectAttempts = 0;
        record.lastSequence = message.sequence;
        record.runId = message.runId;
        acknowledgeTerminal(record, message.sequence);
        settleRequest(record, 'resolve', message.payload.data);
        return;
      }

      if (message.type === RUN_MESSAGE_TYPES.runError && validPublicError(message.payload)) {
        reconnectAttempts = 0;
        record.lastSequence = message.sequence;
        record.runId = message.runId;
        acknowledgeTerminal(record, message.sequence);
        const failure = publicFailure(
          message.payload.code,
          message.payload.message,
          message.payload,
        );
        settleRequest(record, 'reject', failure);
      }
    }

    function handlePortDisconnect() {
      const disconnectedPort = port;
      port = null;
      disconnectedPort?.onMessage?.removeListener?.(handlePortMessage);
      disconnectedPort?.onDisconnect?.removeListener?.(handlePortDisconnect);
      scheduleReconnect();
    }

    const connectPort = () => {
      if (port || stopped) return port;
      if (!runtime?.connect) {
        failTransport();
        return null;
      }
      try {
        port = runtime.connect({ name: PORT_NAME });
        port.onMessage.addListener(handlePortMessage);
        port.onDisconnect.addListener(handlePortDisconnect);
        postOutbox();
        return port;
      } catch (error) {
        port = null;
        scheduleReconnect();
        return null;
      }
    };

    const scheduleReconnect = () => {
      if (reconnectTimer || stopped || (outbox.size === 0 && requests.size === 0)) return;
      if (reconnectAttempts >= maxReconnectAttempts) {
        failTransport();
        return;
      }
      reconnectAttempts += 1;
      reconnectTimer = schedule(() => {
        reconnectTimer = null;
        connectPort();
      }, reconnectDelayMs * reconnectAttempts);
    };

    const sendEnvelope = (message) => {
      const key = outboxKey(message.requestId, message.type);
      outbox.set(key, message);
      const activePort = connectPort();
      if (activePort) activePort.postMessage(message);
    };

    const validPublicError = (payload) => (
      isPlainObject(payload)
      && ALLOWED_ERROR_CODES.has(payload.code)
      && typeof payload.message === 'string'
      && payload.message.length > 0
      && (payload.stepId === null || typeof payload.stepId === 'string')
      && typeof payload.retryable === 'boolean'
      && isPlainObject(payload.observed)
    );

    const validCoordinatorEnvelope = (message, record) => {
      if (!isPlainObject(message)
        || message.protocol !== RUN_PROTOCOL
        || !COORDINATOR_MESSAGE_TYPES.has(message.type)
        || message.requestId !== record.requestId
        || !Number.isInteger(message.sequence)
        || message.sequence <= record.lastSequence
        || message.sender?.context !== 'service_worker'
        || typeof message.runId !== 'string'
        || message.runId.length === 0) {
        return false;
      }
      return !record.runId || record.runId === message.runId;
    };

    const sendCancellation = (record) => {
      if (!record.runId) return;
      sendEnvelope(createEnvelope({
        type: RUN_MESSAGE_TYPES.runCancel,
        requestId: record.requestId,
        runId: record.runId,
        sequence: record.lastSequence + 1,
        sentAt: now().toISOString(),
        sender: { context: 'source_content', tabId: null, documentId: null },
        payload: { reason: record.cancelReason },
      }));
    };

    const cancelRequest = (record, reason) => {
      if (record.cancelRequested) return;
      record.cancelRequested = true;
      record.cancelReason = reason;
      settleRequest(record, 'reject', cancellationFailure(reason), false);
      if (record.runId) sendCancellation(record);
    };

    const invoke = (action, input, client = {}) => {
      const validation = validateArguments(input, action.inputSchema);
      if (!validation.valid) {
        return Promise.reject(publicFailure(
          publicErrors.PUBLIC_ERROR_CODES.invalidArguments,
          validation.errors.join('; '),
        ));
      }
      if (client.signal?.aborted) return Promise.reject(cancellationFailure());

      const requestId = `req_${randomId().replace(/[^a-z0-9_.-]/gi, '').toLowerCase()}`;
      return new Promise((resolve, reject) => {
        const record = {
          abortListener: null,
          action,
          cancelReason: '',
          cancelRequested: false,
          lastSequence: 1,
          reject,
          requestId,
          resolve,
          runId: null,
          settled: false,
          signal: client.signal || null,
        };
        record.abortListener = () => cancelRequest(record, 'Tool invocation was cancelled');
        record.signal?.addEventListener?.('abort', record.abortListener, { once: true });
        requests.set(requestId, record);
        const message = createEnvelope({
          type: RUN_MESSAGE_TYPES.runRequest,
          requestId,
          runId: null,
          sequence: 1,
          sentAt: now().toISOString(),
          sender: { context: 'source_content', tabId: null, documentId: null },
          payload: {
            listId: action.listId,
            listDigest: action.listDigest,
            listRevision: action.listRevision,
            actionId: action.actionId,
            actionVersion: action.actionVersion,
            sourceUrl: locationObject.href,
            arguments: cloneJson(input),
          },
        });
        if (jsonByteLength(message) > MAX_MESSAGE_BYTES) {
          settleRequest(record, 'reject', publicFailure(
            publicErrors.PUBLIC_ERROR_CODES.invalidArguments,
            'The invocation arguments exceed the source message size limit',
          ));
          return;
        }
        sendEnvelope(message);
      });
    };

    const eligibleActions = (lists) => {
      const eligible = lists.flatMap((list) => {
        if (!listIsEligible(list, locationObject.href, now())) return [];
        return list.actions
          .filter((action) => actionIsEligible(list, action, locationObject.href))
          .map((action) => ({ action, list }));
      });
      const nameCounts = eligible.reduce((counts, { action }) => {
        counts.set(action.tool.name, (counts.get(action.tool.name) || 0) + 1);
        return counts;
      }, new Map());
      return eligible.filter(({ action }) => nameCounts.get(action.tool.name) === 1);
    };

    const removeRegistration = (key, expectedController = null) => {
      const registration = registrationControllers.get(key);
      if (!registration
        || (expectedController && registration.controller !== expectedController)) return;
      registration.controller.abort();
      registrationControllers.delete(key);
      if (registrationKeysByName.get(registration.name) === key) {
        registrationKeysByName.delete(registration.name);
      }
    };

    const unregisterAll = () => {
      Array.from(registrationControllers.keys()).forEach(removeRegistration);
    };

    const applyActionLists = async (lists = []) => {
      actionLists = Array.isArray(lists) ? lists.slice() : [];
      start();
      const generation = refreshGeneration + 1;
      refreshGeneration = generation;

      if (typeof modelContext?.registerTool !== 'function') {
        unregisterAll();
        if (runtime?.sendMessage) {
          await sendRuntimeMessage(runtime, createMessage(MESSAGE_TYPES.webMcpStatus, {
            available: false,
          })).catch(() => {});
        }
        return { available: false, registered: 0 };
      }

      const eligible = eligibleActions(actionLists);
      const desiredKeys = new Set(eligible.map(({ action, list }) => (
        registrationKeyFor(list, action)
      )));
      requests.forEach((record) => {
        if (!desiredKeys.has(record.action.registrationKey)) {
          cancelRequest(record, 'The registered action changed or is no longer eligible');
        }
      });
      Array.from(registrationControllers.keys())
        .filter((key) => !desiredKeys.has(key))
        .forEach(removeRegistration);

      for (const { action, list } of eligible) {
        const key = registrationKeyFor(list, action);
        if (registrationControllers.has(key)) continue;
        const conflictingKey = registrationKeysByName.get(action.tool.name);
        if (conflictingKey && conflictingKey !== key) removeRegistration(conflictingKey);

        const controller = new AbortController();
        const actionReference = actionReferenceFor(list, action);
        registrationControllers.set(key, { controller, name: action.tool.name });
        registrationKeysByName.set(action.tool.name, key);
        try {
          await modelContext.registerTool(
            projectTool(action, (input, client) => invoke(actionReference, input, client)),
            { signal: controller.signal },
          );
        } catch (error) {
          removeRegistration(key, controller);
          throw error;
        }
        if (generation !== refreshGeneration) {
          removeRegistration(key, controller);
          continue;
        }
      }

      if (runtime?.sendMessage) {
        await sendRuntimeMessage(runtime, createMessage(MESSAGE_TYPES.webMcpStatus, {
          available: true,
          registered: registrationControllers.size,
        })).catch(() => {});
      }
      return { available: true, registered: registrationControllers.size };
    };

    const enqueueRegistration = (task) => {
      const result = registrationQueue.then(task, task);
      registrationQueue = result.catch(() => {});
      return result;
    };

    const registerActionLists = (lists = []) => (
      enqueueRegistration(() => applyActionLists(lists))
    );

    const discoveryToken = () => Object.freeze({
      generation: refreshGeneration,
      url: locationObject.href,
    });

    const registerDiscoveredActionLists = (lists, token) => {
      if (!token) return Promise.resolve(staleRegistrationResult());
      return enqueueRegistration(() => {
        if (stopped
          || pageHidden
          || token.generation !== refreshGeneration
          || token.url !== locationObject.href) {
          return staleRegistrationResult();
        }
        return applyActionLists(lists);
      });
    };

    const clearDiscoveryRetry = (resetAttempts = false) => {
      if (discoveryRetryTimer) cancelSchedule(discoveryRetryTimer);
      discoveryRetryTimer = null;
      if (resetAttempts) discoveryRetryAttempts = 0;
    };

    const scheduleDiscoveryRetry = () => {
      if (discoveryRetryTimer
        || stopped
        || pageHidden
        || !refreshActionLists
        || discoveryRetryAttempts >= maxDiscoveryRetryAttempts) return;
      discoveryRetryAttempts += 1;
      discoveryRetryTimer = schedule(() => {
        discoveryRetryTimer = null;
        void refreshRegistrations().catch(() => {});
      }, discoveryRetryDelayMs * discoveryRetryAttempts);
    };

    async function refreshRegistrations() {
      if (!refreshActionLists || stopped || pageHidden) return staleRegistrationResult();
      const token = discoveryToken();
      let origin;
      try {
        origin = new URL(token.url).origin;
      } catch (error) {
        return staleRegistrationResult();
      }
      try {
        const lists = await refreshActionLists({ origin, url: token.url });
        const result = await registerDiscoveredActionLists(lists, token);
        if (!result.stale) clearDiscoveryRetry(true);
        return result;
      } catch (error) {
        if (token.generation === refreshGeneration && token.url === locationObject.href) {
          scheduleDiscoveryRetry();
        }
        throw error;
      }
    }

    const cancelForNavigation = () => {
      const nextUrl = locationObject.href;
      if (nextUrl === currentUrl) return;
      currentUrl = nextUrl;
      requests.forEach((record) => cancelRequest(record, 'Source page navigated'));
      if (!refreshActionLists) {
        void registerActionLists(actionLists);
        return;
      }

      refreshGeneration += 1;
      actionLists = [];
      unregisterAll();
      clearDiscoveryRetry(true);
      void refreshRegistrations().catch(() => {});
    };

    const resumeAfterPageShow = () => {
      pageHidden = false;
      const previousUrl = currentUrl;
      cancelForNavigation();
      if (previousUrl === locationObject.href && refreshActionLists) {
        void refreshRegistrations().catch(() => {});
      }
    };

    const start = () => {
      if (started) return;
      started = true;
      stopped = false;
      connectPort();
      windowObject?.addEventListener?.('pagehide', () => {
        pageHidden = true;
        refreshGeneration += 1;
        clearDiscoveryRetry();
        requests.forEach((record) => cancelRequest(record, 'Source page unloaded'));
      });
      windowObject?.addEventListener?.('popstate', cancelForNavigation);
      windowObject?.addEventListener?.('hashchange', cancelForNavigation);
      windowObject?.addEventListener?.('pageshow', resumeAfterPageShow);
      windowObject?.navigation?.addEventListener?.('navigatesuccess', cancelForNavigation);
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      refreshGeneration += 1;
      unregisterAll();
      requests.forEach((record) => {
        cancelRequest(record, 'Source bridge stopped');
        cleanupRequest(record);
      });
      outbox.clear();
      if (reconnectTimer) cancelSchedule(reconnectTimer);
      reconnectTimer = null;
      clearDiscoveryRetry();
      port?.onMessage?.removeListener?.(handlePortMessage);
      port?.onDisconnect?.removeListener?.(handlePortDisconnect);
      port?.disconnect?.();
      port = null;
    };

    return {
      PORT_NAME,
      discoveryToken,
      refreshRegistrations,
      registerDiscoveredActionLists,
      registerActionLists,
      retryDiscovery: scheduleDiscoveryRetry,
      start,
      stop,
      __test: {
        getOutbox: () => Array.from(outbox.values()),
        getRegistrationCount: () => registrationControllers.size,
        getRequestCount: () => requests.size,
        handlePortMessage,
      },
    };
  };

  let defaultBridge = null;
  const getDefaultBridge = () => {
    if (!defaultBridge) {
      defaultBridge = createSourceBridge({
        refreshActionLists: async ({ origin, url }) => {
          const response = await sendLegacyMessage(createMessage(MESSAGE_TYPES.getAdapters, {
            origin,
            sourceUrl: url,
          }));
          if (!response?.ok) {
            throw new Error(response?.error || 'Could not discover published actions');
          }
          return Array.isArray(response?.actionLists) ? response.actionLists : [];
        },
      });
    }
    return defaultBridge;
  };

  const sendLegacyMessage = (message) => sendRuntimeMessage(root.chrome.runtime, message);

  const initialize = async () => {
    getDefaultBridge().start();
    return sendLegacyMessage(createMessage(MESSAGE_TYPES.pageReady, {
      state: root.WebMcpSemantic?.capturePageState?.() || null,
    }));
  };

  const registerAdapters = async () => {
    if (!root.document.modelContext?.registerTool) {
      await sendLegacyMessage(createMessage(MESSAGE_TYPES.webMcpStatus, {
        available: false,
      })).catch(() => {});
      return;
    }
    const bridge = getDefaultBridge();
    bridge.start();
    const token = bridge.discoveryToken();
    let response;
    try {
      response = await sendLegacyMessage(createMessage(MESSAGE_TYPES.getAdapters, {
        origin: root.location.origin,
        sourceUrl: token.url,
      }));
      if (!response?.ok) throw new Error(response?.error || 'Could not discover actions');
    } catch (error) {
      bridge.retryDiscovery();
      throw error;
    }
    await bridge.registerDiscoveredActionLists(
      Array.isArray(response.actionLists) ? response.actionLists : [],
      token,
    );
  };

  const handleMessage = (message, _sender, sendResponse) => {
    if (isMessage(message, MESSAGE_TYPES.executeStep)) {
      root.WebMcpRunner.executeStep(message.step, message.args, message.tool)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse(publicErrors.legacyResponseFor(error)));
      return true;
    }
    if (isMessage(message, MESSAGE_TYPES.refreshAdapters)) {
      registerAdapters()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse(publicErrors.legacyResponseFor(error)));
      return true;
    }
    return undefined;
  };

  return {
    ACTION_LIST_VERSION,
    MAX_MESSAGE_BYTES,
    PORT_NAME,
    createSourceBridge,
    handleMessage,
    initialize,
    projectTool,
    registerActionLists: (...args) => getDefaultBridge().registerActionLists(...args),
    registerAdapters,
    start: () => getDefaultBridge().start(),
    stop: () => getDefaultBridge().stop(),
    validateArguments,
  };
}));
