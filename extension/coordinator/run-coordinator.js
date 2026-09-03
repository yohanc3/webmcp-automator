(function initializeRunCoordinator(root, factory) {
  const state = typeof module !== 'undefined' && module.exports
    ? require('./run-state.js')
    : root.WebMcpRunState;
  const api = factory(state);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.WebMcpRunCoordinator = api;
}(typeof globalThis === 'undefined' ? this : globalThis, (runState) => {
  'use strict';

  const {
    RUN_STATUSES,
    acceptEvent,
    clone,
    createRunRecord,
    isTerminal,
    transitionRun,
    updateRun,
  } = runState;

  const PORT_NAMES = Object.freeze({
    execution: 'webmcp-run/1:execution',
    review: 'webmcp-run/1:review',
    source: 'webmcp-run/1:source',
  });

  const MESSAGE_TYPES = Object.freeze({
    executionInitialize: 'execution.initialize',
    pageReady: 'page.ready',
    runAccepted: 'run.accepted',
    runAwaitingConfirmation: 'run.awaiting_confirmation',
    runCancel: 'run.cancel',
    runConfirm: 'run.confirm',
    runError: 'run.error',
    runRequest: 'run.request',
    runResult: 'run.result',
    stepCommand: 'step.command',
    stepCompleted: 'step.completed',
    stepFailed: 'step.failed',
  });

  const ERROR_CODES = Object.freeze({
    cancelled: 'CANCELLED',
    confirmationDenied: 'CONFIRMATION_DENIED',
    executionTabClosed: 'EXECUTION_TAB_CLOSED',
    internalError: 'INTERNAL_ERROR',
    invalidArguments: 'INVALID_ARGUMENTS',
    navigationOutOfScope: 'NAVIGATION_OUT_OF_SCOPE',
    planNotFound: 'PLAN_NOT_FOUND',
    planVersionMismatch: 'PLAN_VERSION_MISMATCH',
    policyBlocked: 'POLICY_BLOCKED',
    preconditionFailed: 'PRECONDITION_FAILED',
    timeout: 'TIMEOUT',
    transportDisconnected: 'TRANSPORT_DISCONNECTED',
  });

  const RUN_PROTOCOL = 'webmcp-run/1';
  const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
  const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
  const MAX_EVENT_CACHE = 256;

  const canonicalize = (value) => {
    if (Array.isArray(value)) {
      return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((result, key) => ({
        ...result,
        [key]: canonicalize(value[key]),
      }), {});
    }
    return value;
  };

  const canonicalStringify = (value) => JSON.stringify(canonicalize(value));

  const defaultDigest = async (value) => {
    const bytes = new TextEncoder().encode(canonicalStringify(value));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const hexadecimal = Array.from(new Uint8Array(hash))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return `sha256:${hexadecimal}`;
  };

  const createError = (
    code,
    message,
    { stepId = null, retryable = false, observed = {} } = {},
  ) => ({ code, message, stepId, retryable, observed });

  const parseUrl = (value) => {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  };

  const routeMatches = (list, url) => {
    const parsed = parseUrl(url);
    if (!parsed || parsed.origin !== list.site.origin) {
      return false;
    }
    return list.site.routePatterns.some((pattern) => new RegExp(pattern).test(
      `${parsed.pathname}${parsed.search}`,
    ));
  };

  const requiredScope = (action) => action.safety.class;

  const defaultPolicyAuthorize = ({ list, action, origin, now }) => {
    const expiresAt = list.policy.expiresAt ? Date.parse(list.policy.expiresAt) : null;
    const allowed = list.policy.status === 'allowed'
      && list.policy.scopes.includes(requiredScope(action))
      && list.site.origin === origin
      && (expiresAt === null || expiresAt > Date.parse(now));
    return {
      allowed,
      reasonCode: allowed ? 'PUBLISHED_POLICY_ALLOWED' : 'POLICY_NOT_CURRENT_OR_INSUFFICIENT',
    };
  };

  const validateInputProperty = (value, property) => {
    if (property.type === 'integer' && !Number.isInteger(value)) return false;
    if (property.type === 'number' && (typeof value !== 'number' || Number.isNaN(value))) return false;
    if (property.type === 'string' && typeof value !== 'string') return false;
    if (property.type === 'boolean' && typeof value !== 'boolean') return false;
    if (property.enum && !property.enum.includes(value)) return false;
    if (typeof value === 'string' && property.minLength !== undefined
      && value.length < property.minLength) return false;
    if (typeof value === 'string' && property.maxLength !== undefined
      && value.length > property.maxLength) return false;
    if (typeof value === 'number' && property.minimum !== undefined
      && value < property.minimum) return false;
    if (typeof value === 'number' && property.maximum !== undefined
      && value > property.maximum) return false;
    return true;
  };

  const validateArguments = (inputSchema, args) => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const names = Object.keys(args);
    if (inputSchema.additionalProperties === false
      && names.some((name) => !inputSchema.properties[name])) return false;
    if (inputSchema.required.some((name) => !Object.hasOwn(args, name))) return false;
    return names.every((name) => validateInputProperty(args[name], inputSchema.properties[name]));
  };

  const validateEnvelopeBase = (message) => Boolean(
    message
    && message.protocol === RUN_PROTOCOL
    && typeof message.type === 'string'
    && IDENTIFIER_PATTERN.test(message.requestId || '')
    && Number.isInteger(message.sequence)
    && message.sequence >= 1
    && !Number.isNaN(Date.parse(message.sentAt))
    && message.sender
    && message.payload
    && typeof message.payload === 'object',
  );

  const validateRunRequest = (message) => Boolean(
    validateEnvelopeBase(message)
    && message.type === MESSAGE_TYPES.runRequest
    && message.runId === null
    && message.sequence === 1
    && message.sender.context === 'source_content'
    && IDENTIFIER_PATTERN.test(message.payload.listId || '')
    && IDENTIFIER_PATTERN.test(message.payload.actionId || '')
    && Number.isInteger(message.payload.actionVersion)
    && message.payload.actionVersion >= 1
    && parseUrl(message.payload.sourceUrl)
    && message.payload.arguments
    && typeof message.payload.arguments === 'object'
    && !Array.isArray(message.payload.arguments),
  );

  const makeEnvelope = (record, type, payload, sequence) => ({
    protocol: RUN_PROTOCOL,
    type,
    requestId: record.requestId,
    runId: record.runId,
    sequence,
    sentAt: record.updatedAt,
    sender: {
      context: 'service_worker',
      tabId: null,
      documentId: null,
    },
    payload,
  });

  const messageMatchesSource = (message, source) => (
    message.sender.context === 'source_content'
    && message.sender.tabId === source.tabId
    && message.sender.documentId === source.documentId
  );

  const pageSatisfiesStep = (step, page) => step.expect.checks.every((check) => {
    if (check.kind === 'url') return new RegExp(check.pattern).test(page.url);
    if (check.kind === 'state') return page.stateId === check.stateId;
    return false;
  });

  const expectsNavigation = (step) => (
    step.op === 'click'
    && step.expect.checks.some((check) => check.kind === 'url')
  );

  const redactedArgumentPreview = (action, args) => Object.keys(args).reduce((preview, name) => ({
    ...preview,
    [name]: action.safety.sensitiveArguments.includes(name) ? '[redacted]' : '[provided]',
  }), {});

  const trimDigestCache = (cache) => {
    const entries = Object.entries(cache);
    if (entries.length <= MAX_EVENT_CACHE) return cache;
    return Object.fromEntries(entries.slice(entries.length - MAX_EVENT_CACHE));
  };

  class DurableRunCoordinator {
    constructor({
      storage,
      tabs,
      registry,
      observations,
      validateMessage = validateEnvelopeBase,
      validateActionList = () => ({ valid: true }),
      authorize = defaultPolicyAuthorize,
      digest = defaultDigest,
      now = () => new Date().toISOString(),
      randomId = () => crypto.randomUUID(),
      setTimer = (callback, delay) => setTimeout(callback, delay),
      clearTimer = (timer) => clearTimeout(timer),
      afterPersist = async () => {},
    }) {
      if (!storage || !tabs || !registry || !observations) {
        throw new Error('Coordinator storage, tabs, registry, and observations are required');
      }
      this.storage = storage;
      this.tabs = tabs;
      this.registry = registry;
      this.observations = observations;
      this.validateMessage = validateMessage;
      this.validateActionList = validateActionList;
      this.authorize = authorize;
      this.digest = digest;
      this.now = now;
      this.randomId = randomId;
      this.setTimer = setTimer;
      this.clearTimer = clearTimer;
      this.afterPersist = afterPersist;
      this.sourcePorts = new Map();
      this.executionPorts = new Map();
      this.executionPortReady = new WeakMap();
      this.reviewPorts = new Set();
      this.runQueues = new Map();
      this.deadlineTimers = new Map();
    }

    sourceKey(source) {
      return `${source.tabId}:${source.documentId}`;
    }

    async persist(record) {
      const durable = clone(record);
      durable.acceptedEventDigests = trimDigestCache(durable.acceptedEventDigests);
      durable.dispatchedCommandDigests = trimDigestCache(durable.dispatchedCommandDigests);
      await this.storage.save(durable);
      await this.afterPersist(clone(durable));
      return durable;
    }

    enqueue(runId, task) {
      const current = this.runQueues.get(runId) || Promise.resolve();
      const next = current.then(task, task);
      const tracked = next.catch(() => {}).finally(() => {
        if (this.runQueues.get(runId) === tracked) this.runQueues.delete(runId);
      });
      this.runQueues.set(runId, tracked);
      return next;
    }

    bindPort(port) {
      const sender = port.sender || {};
      const tabId = sender.tab?.id ?? null;
      const documentId = sender.documentId ?? null;
      const requiresDocument = port.name !== PORT_NAMES.review;
      if (requiresDocument
        && (!Number.isInteger(tabId) || typeof documentId !== 'string' || !documentId)) {
        throw new Error('Run ports require a concrete sender tab and document');
      }
      if (!Object.values(PORT_NAMES).includes(port.name)) {
        throw new Error(`Unsupported run port: ${port.name}`);
      }

      const binding = {
        documentId,
        tabId,
        url: sender.url || sender.tab?.url || null,
      };
      if (requiresDocument && !parseUrl(binding.url)) {
        throw new Error('Run port sender URL is invalid');
      }

      if (port.name === PORT_NAMES.source) {
        this.sourcePorts.set(this.sourceKey(binding), port);
        void this.resumeSource(binding, port);
      } else if (port.name === PORT_NAMES.execution) {
        this.executionPorts.set(tabId, port);
        const ready = this.resumeExecutionTab(tabId).catch(() => {});
        this.executionPortReady.set(port, ready);
      } else {
        this.reviewPorts.add(port);
        void this.resumeReview(port);
      }

      port.onMessage.addListener((message) => {
        void this.receive(port, binding, message);
      });
      port.onDisconnect.addListener(() => {
        void this.disconnect(port, binding);
      });
      return binding;
    }

    async disconnect(port, binding) {
      if (port.name === PORT_NAMES.source) {
        this.sourcePorts.delete(this.sourceKey(binding));
        const runs = await this.storage.list();
        await Promise.all(runs
          .filter((run) => !isTerminal(run.status)
            && run.source.tabId === binding.tabId
            && run.source.documentId === binding.documentId)
          .map((run) => this.enqueue(run.runId, () => this.fail(
            run.runId,
            createError(
              ERROR_CODES.transportDisconnected,
              'The source document closed before the run completed',
            ),
          ))));
        return;
      }
      if (port.name === PORT_NAMES.execution) {
        this.executionPortReady.delete(port);
        if (this.executionPorts.get(binding.tabId) === port) {
          this.executionPorts.delete(binding.tabId);
        }
        return;
      }
      this.reviewPorts.delete(port);
    }

    async receive(port, binding, message) {
      try {
        if (port.name === PORT_NAMES.execution) {
          await this.executionPortReady.get(port);
        }
        const trustedMessage = port.name === PORT_NAMES.review ? message : {
          ...message,
          sender: {
            context: port.name === PORT_NAMES.source ? 'source_content' : 'execution_content',
            documentId: binding.documentId,
            tabId: binding.tabId,
          },
        };
        if (port.name === PORT_NAMES.source && trustedMessage.type === MESSAGE_TYPES.runRequest) {
          await this.acceptRequest(port, binding, trustedMessage);
          return;
        }
        if (!validateEnvelopeBase(trustedMessage) || !this.validateMessage(trustedMessage)) {
          throw new Error('Run message failed validation');
        }
        if (!IDENTIFIER_PATTERN.test(trustedMessage.runId || '')) {
          throw new Error('Run message requires a run ID');
        }
        await this.enqueue(trustedMessage.runId, async () => {
          if (port.name === PORT_NAMES.source) {
            await this.receiveSourceEvent(binding, trustedMessage);
          } else if (port.name === PORT_NAMES.execution) {
            await this.receiveActorEvent(binding, trustedMessage);
          } else {
            await this.receiveReviewEvent(trustedMessage);
          }
        });
      } catch {
        return false;
      }
      return true;
    }

    async acceptRequest(port, source, request) {
      if (!validateRunRequest(request) || !this.validateMessage(request)) {
        throw new Error('Run request failed validation');
      }
      if (!messageMatchesSource(request, source)) {
        throw new Error('Run request sender does not match its bound source port');
      }
      const sourceUrl = parseUrl(request.payload.sourceUrl);
      const senderUrl = parseUrl(source.url);
      if (!sourceUrl || !senderUrl || sourceUrl.origin !== senderUrl.origin) {
        throw new Error('Run request source origin does not match its bound source port');
      }

      const existing = (await this.storage.list()).find((run) => (
        run.requestId === request.requestId
        && run.source.tabId === source.tabId
        && run.source.documentId === source.documentId
      ));
      if (existing) {
        await this.replayKnownState(port, existing);
        return existing;
      }

      const startedAt = this.now();
      let record = createRunRecord({
        runId: `run_${this.randomId().replaceAll('-', '_')}`,
        request,
        source,
        now: startedAt,
        deadlineAt: null,
      });
      record.nextCoordinatorSequence = 2;
      await this.persist(record);

      return this.resolveCreatedRun(record);
    }

    async resolveCreatedRun(inputRecord) {
      let record = inputRecord;
      let resolved;
      try {
        resolved = await this.registry.resolveExact({
          actionId: record.actionId,
          actionVersion: record.actionVersion,
          listId: record.listId,
        });
      } catch {
        return this.fail(record.runId, createError(
          ERROR_CODES.planNotFound,
          'The exact published action could not be resolved',
        ));
      }

      const list = resolved?.list;
      const action = list?.actions?.find((candidate) => (
        candidate.id === record.actionId && candidate.version === record.actionVersion
      ));
      const planDigest = resolved?.digest || list?.publication?.contentDigest;
      const validation = list ? this.validateActionList(list) : { valid: false };
      if (!list || !action || validation.valid === false) {
        return this.fail(record.runId, createError(
          ERROR_CODES.planNotFound,
          'The exact published action is unavailable or invalid',
        ));
      }
      if (list.publication.status !== 'published'
        || action.lifecycle !== 'published'
        || !SHA256_PATTERN.test(planDigest || '')
        || planDigest !== list.publication.contentDigest) {
        return this.fail(record.runId, createError(
          ERROR_CODES.planVersionMismatch,
          'The resolved action revision or digest is not executable',
        ));
      }
      if (!routeMatches(list, record.source.url)) {
        return this.fail(record.runId, createError(
          ERROR_CODES.preconditionFailed,
          'The action is not valid for the source page route',
        ));
      }
      if (!validateArguments(action.tool.inputSchema, record.arguments)) {
        return this.fail(record.runId, createError(
          ERROR_CODES.invalidArguments,
          'The invocation arguments do not match the published tool schema',
        ));
      }

      const decision = await this.authorize({
        action,
        list,
        now: this.now(),
        origin: parseUrl(record.source.url).origin,
      });
      if (!decision?.allowed) {
        return this.fail(record.runId, createError(
          ERROR_CODES.policyBlocked,
          'Current policy does not authorize this action',
          { observed: { reasonCode: decision?.reasonCode || 'POLICY_BLOCKED' } },
        ));
      }

      record = await this.persist(transitionRun(record, RUN_STATUSES.policyChecked, {
        action: clone(action),
        states: clone(list.states || []),
        listDigest: planDigest,
        policyDecision: {
          checkedAt: this.now(),
          reasonCode: decision.reasonCode || 'ALLOWED',
        },
        site: clone(list.site),
        listPolicy: clone(list.policy),
        deadlineAt: new Date(
          Date.parse(record.createdAt) + action.runtime.maxDurationMs,
        ).toISOString(),
      }, this.now()));
      this.scheduleDeadline(record);

      if (action.safety.confirmation === 'before_run') {
        return this.awaitConfirmation(record, action.steps[0].id, 'before_run');
      }
      return this.openExecutionTab(record);
    }

    async openExecutionTab(inputRecord) {
      let record = await this.persist(transitionRun(
        inputRecord,
        RUN_STATUSES.openingTab,
        {},
        this.now(),
      ));
      const inUseTabIds = (await this.storage.list())
        .filter((run) => !isTerminal(run.status) && run.runId !== record.runId)
        .map((run) => run.execution.tabId)
        .filter(Number.isInteger);
      const reusable = this.tabs.findReusable
        ? await this.tabs.findReusable({
          excludeTabIds: inUseTabIds,
          origin: record.site.origin,
          url: record.source.url,
        })
        : null;
      const tab = reusable || await this.tabs.create({ active: false, url: record.source.url });
      record = await this.persist(transitionRun(record, RUN_STATUSES.waitingForPage, {
        execution: {
          documentId: null,
          navigationSequence: -1,
          stateId: null,
          tabId: tab.id,
          url: tab.url || record.source.url,
        },
      }, this.now()));
      await this.sendAccepted(record);
      return record;
    }

    async sendAccepted(inputRecord) {
      let record = inputRecord;
      if (!record.acceptedEnvelope) {
        const envelope = makeEnvelope(record, MESSAGE_TYPES.runAccepted, {
          executionTabId: record.execution.tabId,
          planDigest: record.listDigest,
        }, record.nextCoordinatorSequence);
        record = await this.persist(updateRun(record, {
          acceptedEnvelope: envelope,
          nextCoordinatorSequence: record.nextCoordinatorSequence + 1,
        }, this.now()));
      }
      const port = this.sourcePorts.get(this.sourceKey(record.source));
      if (port) port.postMessage(record.acceptedEnvelope);
      return record;
    }

    async replayKnownState(port, record) {
      if (record.terminal && !record.terminal.dispatched) {
        await this.dispatchTerminal(record, port);
      } else if (record.acceptedEnvelope) {
        port.postMessage(record.acceptedEnvelope);
      }
    }

    async receiveSourceEvent(source, message) {
      const record = await this.storage.load(message.runId);
      if (!record || !messageMatchesSource(message, source)) {
        throw new Error('Source event does not match its durable run binding');
      }
      if (message.type !== MESSAGE_TYPES.runCancel) {
        throw new Error(`Unsupported source event: ${message.type}`);
      }
      await this.acceptAndPersistEvent(record, message);
      await this.cancel(record.runId, message.payload.reason);
    }

    async receiveReviewEvent(message) {
      const record = await this.storage.load(message.runId);
      if (!record || message.sender.context !== 'review_ui') {
        throw new Error('Review event does not match an active run');
      }
      if (message.type !== MESSAGE_TYPES.runConfirm) {
        throw new Error(`Unsupported review event: ${message.type}`);
      }
      const accepted = await this.acceptAndPersistEvent(record, message);
      if (accepted.duplicate) return;
      const current = accepted.record;
      if (current.status !== RUN_STATUSES.awaitingConfirmation
        || current.confirmation.stepId !== message.payload.stepId) {
        return;
      }
      if (!message.payload.approved) {
        await this.fail(current.runId, createError(
          ERROR_CODES.confirmationDenied,
          'The requested action was denied',
          { stepId: current.confirmation.stepId },
        ));
        return;
      }

      const resumeStatus = current.confirmation.resumeStatus;
      let next = await this.persist(transitionRun(current, resumeStatus, {
        confirmation: {
          ...current.confirmation,
          approvedAt: this.now(),
        },
      }, this.now()));
      if (resumeStatus === RUN_STATUSES.openingTab) {
        next = await this.openExecutionTabFromConfirmation(next);
      } else {
        await this.prepareConfirmedStep(next);
      }
    }

    async submitConfirmation({ approved, runId, stepId }) {
      const record = await this.storage.load(runId);
      if (!record || record.status !== RUN_STATUSES.awaitingConfirmation
        || record.confirmation?.stepId !== stepId || typeof approved !== 'boolean') {
        throw new Error('Confirmation does not match an active durable run');
      }
      const identity = 'review_ui:none:none';
      const sequence = (record.lastAcceptedSequenceBySender[identity] || 0) + 1;
      const message = {
        protocol: RUN_PROTOCOL,
        type: MESSAGE_TYPES.runConfirm,
        requestId: record.requestId,
        runId,
        sequence,
        sentAt: this.now(),
        sender: { context: 'review_ui', documentId: null, tabId: null },
        payload: { approved, stepId },
      };
      await this.enqueue(runId, () => this.receiveReviewEvent(message));
      return this.storage.load(runId);
    }

    async openExecutionTabFromConfirmation(record) {
      const inUseTabIds = (await this.storage.list())
        .filter((run) => !isTerminal(run.status) && run.runId !== record.runId)
        .map((run) => run.execution.tabId)
        .filter(Number.isInteger);
      const reusable = this.tabs.findReusable
        ? await this.tabs.findReusable({
          excludeTabIds: inUseTabIds,
          origin: record.site.origin,
          url: record.source.url,
        })
        : null;
      const tab = reusable || await this.tabs.create({ active: false, url: record.source.url });
      const next = await this.persist(transitionRun(record, RUN_STATUSES.waitingForPage, {
        execution: {
          documentId: null,
          navigationSequence: -1,
          stateId: null,
          tabId: tab.id,
          url: tab.url || record.source.url,
        },
      }, this.now()));
      await this.sendAccepted(next);
      return next;
    }

    async receiveActorEvent(binding, message) {
      let record = await this.storage.load(message.runId);
      if (!record || record.execution.tabId !== binding.tabId) {
        throw new Error('Actor event does not match its execution tab');
      }
      if (message.sender.context !== 'execution_content'
        || message.sender.tabId !== binding.tabId
        || message.sender.documentId !== binding.documentId) {
        throw new Error('Actor event sender does not match its bound execution port');
      }
      const accepted = await this.acceptAndPersistEvent(record, message);
      if (accepted.duplicate || isTerminal(accepted.record.status)) return;
      record = accepted.record;

      if (message.type === MESSAGE_TYPES.pageReady) {
        await this.handlePageReady(record, binding, message);
      } else if (message.type === MESSAGE_TYPES.stepCompleted) {
        await this.handleStepCompleted(record, binding, message);
      } else if (message.type === MESSAGE_TYPES.stepFailed) {
        await this.handleStepFailed(record, binding, message);
      } else {
        throw new Error(`Unsupported actor event: ${message.type}`);
      }
    }

    async acceptAndPersistEvent(record, message) {
      const eventDigest = await this.digest(message);
      const accepted = acceptEvent(record, message, eventDigest, this.now());
      if (accepted.duplicate) return accepted;
      accepted.record = await this.persist(accepted.record);
      return accepted;
    }

    async handlePageReady(record, binding, message) {
      const { payload } = message;
      const pageUrl = parseUrl(payload.url);
      if (!pageUrl || !record.action.runtime.allowedOrigins.includes(pageUrl.origin)) {
        await this.fail(record.runId, createError(
          ERROR_CODES.navigationOutOfScope,
          'The execution tab navigated outside the published origin allowlist',
          { observed: { origin: pageUrl?.origin || null } },
        ));
        return;
      }
      if (payload.navigationSequence > record.action.runtime.maxNavigations) {
        await this.fail(record.runId, createError(
          ERROR_CODES.navigationOutOfScope,
          'The execution tab exceeded the published navigation budget',
          { observed: { navigationSequence: payload.navigationSequence } },
        ));
        return;
      }
      if (payload.navigationSequence < record.execution.navigationSequence) {
        throw new Error('Stale page readiness event');
      }

      const execution = {
        documentId: binding.documentId,
        navigationSequence: payload.navigationSequence,
        stateId: payload.stateId,
        tabId: binding.tabId,
        url: payload.url,
      };
      record = await this.persist(updateRun(record, { execution }, this.now()));

      if (record.status === RUN_STATUSES.waitingForNavigation && record.pendingCommand) {
        const step = record.action.steps[record.pendingCommand.stepIndex];
        const documentChanged = record.pendingCommand.documentId !== binding.documentId;
        if (documentChanged && pageSatisfiesStep(step, payload)) {
          await this.completePendingStep(record, {
            effect: {
              navigationExpected: true,
              navigationObserved: true,
              postconditionSatisfied: true,
              stateAfter: payload.stateId,
              stateBefore: record.pendingCommand.stateBefore,
              urlAfter: payload.url,
              urlBefore: record.pendingCommand.urlBefore,
              urlChanged: payload.url !== record.pendingCommand.urlBefore,
            },
            result: null,
          });
          return;
        }
        return;
      }
      if (record.status !== RUN_STATUSES.waitingForPage) return;

      const allowedState = record.action.precondition.allowedStateIds.includes(payload.stateId);
      const allowedUrl = record.action.precondition.urlPatterns.some(
        (pattern) => new RegExp(pattern).test(payload.url),
      );
      if (record.stepIndex === 0 && (!allowedState || !allowedUrl)) {
        await this.fail(record.runId, createError(
          ERROR_CODES.preconditionFailed,
          'The execution page does not satisfy the action precondition',
          { observed: { stateId: payload.stateId } },
        ));
        return;
      }
      await this.prepareNextStep(record);
    }

    async prepareNextStep(record) {
      if (record.stepIndex >= record.action.steps.length) {
        await this.complete(record);
        return;
      }
      const step = record.action.steps[record.stepIndex];
      if (record.action.safety.confirmation === 'before_step'
        && record.action.safety.confirmationStepId === step.id
        && !record.confirmation?.approvedAt) {
        await this.awaitConfirmation(record, step.id, 'before_step');
        return;
      }

      const targetStatus = step.op === 'extract'
        ? RUN_STATUSES.extracting
        : RUN_STATUSES.dispatchingStep;
      const commandId = `command_${this.randomId().replaceAll('-', '_')}`;
      const sequence = record.nextCoordinatorSequence;
      const envelope = makeEnvelope(record, MESSAGE_TYPES.stepCommand, {
        arguments: clone(record.arguments),
        commandId,
        step: clone(step),
        stepIndex: record.stepIndex,
      }, sequence);
      const commandDigest = await this.digest(envelope);
      const next = await this.persist(transitionRun(record, targetStatus, {
        nextCoordinatorSequence: sequence + 1,
        pendingCommand: {
          commandDigest,
          commandId,
          deadlineAt: null,
          dispatchedAt: null,
          documentId: record.execution.documentId,
          expectsNavigation: expectsNavigation(step),
          stateBefore: record.execution.stateId,
          stepId: step.id,
          stepIndex: record.stepIndex,
          urlBefore: record.execution.url,
          envelope,
        },
      }, this.now()));
      await this.dispatchPreparedStep(next);
    }

    async prepareConfirmedStep(record) {
      const step = record.action.steps[record.stepIndex];
      const commandId = `command_${this.randomId().replaceAll('-', '_')}`;
      const envelope = makeEnvelope(record, MESSAGE_TYPES.stepCommand, {
        arguments: clone(record.arguments),
        commandId,
        step: clone(step),
        stepIndex: record.stepIndex,
      }, record.nextCoordinatorSequence);
      const commandDigest = await this.digest(envelope);
      const prepared = await this.persist(updateRun(record, {
        nextCoordinatorSequence: record.nextCoordinatorSequence + 1,
        pendingCommand: {
          commandDigest,
          commandId,
          deadlineAt: null,
          dispatchedAt: null,
          documentId: record.execution.documentId,
          expectsNavigation: expectsNavigation(step),
          stateBefore: record.execution.stateId,
          stepId: step.id,
          stepIndex: record.stepIndex,
          urlBefore: record.execution.url,
          envelope,
        },
      }, this.now()));
      await this.dispatchPreparedStep(prepared);
    }

    async dispatchPreparedStep(record) {
      if (!record.pendingCommand) throw new Error('There is no prepared step to dispatch');
      const isExtract = record.action.steps[record.pendingCommand.stepIndex].op === 'extract';
      const waitingStatus = isExtract
        ? RUN_STATUSES.extracting
        : record.pendingCommand.expectsNavigation
          ? RUN_STATUSES.waitingForNavigation
          : RUN_STATUSES.waitingForEffect;
      let durable = record;
      if (record.status === RUN_STATUSES.dispatchingStep) {
        const dispatchedAt = this.now();
        const step = record.action.steps[record.pendingCommand.stepIndex];
        durable = await this.persist(transitionRun(record, waitingStatus, {
          pendingCommand: {
            ...record.pendingCommand,
            deadlineAt: new Date(Date.parse(dispatchedAt) + step.timeoutMs).toISOString(),
            dispatchedAt,
          },
          dispatchedCommandDigests: {
            ...record.dispatchedCommandDigests,
            [record.pendingCommand.commandDigest]: record.pendingCommand.commandId,
          },
        }, this.now()));
      } else if (record.status === RUN_STATUSES.extracting
        && !record.pendingCommand.dispatchedAt) {
        const dispatchedAt = this.now();
        const step = record.action.steps[record.pendingCommand.stepIndex];
        durable = await this.persist(updateRun(record, {
          pendingCommand: {
            ...record.pendingCommand,
            deadlineAt: new Date(Date.parse(dispatchedAt) + step.timeoutMs).toISOString(),
            dispatchedAt,
          },
          dispatchedCommandDigests: {
            ...record.dispatchedCommandDigests,
            [record.pendingCommand.commandDigest]: record.pendingCommand.commandId,
          },
        }, this.now()));
      }

      this.scheduleDeadline(durable);

      const port = this.executionPorts.get(durable.execution.tabId);
      if (!port) return durable;
      port.postMessage(durable.pendingCommand.envelope);
      return durable;
    }

    async handleStepCompleted(record, binding, message) {
      if (![RUN_STATUSES.waitingForEffect, RUN_STATUSES.waitingForNavigation,
        RUN_STATUSES.extracting].includes(record.status)) return;
      const pending = record.pendingCommand;
      if (!pending
        || pending.commandId !== message.payload.commandId
        || pending.stepId !== message.payload.stepId
        || pending.stepIndex !== message.payload.stepIndex
        || pending.documentId !== binding.documentId) {
        throw new Error('Step completion does not match the pending command');
      }
      if (!message.payload.effect.postconditionSatisfied) {
        await this.fail(record.runId, createError(
          'POSTCONDITION_FAILED',
          'The actor did not observe the published postcondition',
          { stepId: pending.stepId },
        ));
        return;
      }
      await this.completePendingStep(record, message.payload);
    }

    async completePendingStep(record, payload) {
      const pending = record.pendingCommand;
      const completedAt = this.now();
      const durationMs = pending.dispatchedAt
        ? Math.max(0, Date.parse(completedAt) - Date.parse(pending.dispatchedAt))
        : 0;
      const patch = {
        completedSteps: [...record.completedSteps, pending.stepId],
        execution: {
          ...record.execution,
          stateId: payload.effect.stateAfter,
          url: payload.effect.urlAfter,
        },
        pendingCommand: null,
        result: payload.result === undefined || payload.result === null
          ? record.result
          : clone(payload.result),
        stepIndex: record.stepIndex + 1,
        stepObservations: [...record.stepObservations, {
          durationMs,
          locatorStrategyIndex: payload.locatorStrategyIndex ?? null,
          matchCount: payload.matchCount ?? null,
          postconditionSatisfied: payload.effect.postconditionSatisfied,
          status: 'completed',
          stepId: pending.stepId,
        }],
      };

      if (patch.stepIndex >= record.action.steps.length) {
        const ready = await this.persist(updateRun(record, patch, completedAt));
        await this.complete(ready);
        return;
      }
      const nextStep = record.action.steps[patch.stepIndex];
      const nextStatus = nextStep.op === 'extract'
        ? RUN_STATUSES.extracting
        : RUN_STATUSES.dispatchingStep;
      let next;
      if (record.action.safety.confirmation === 'before_step'
        && record.action.safety.confirmationStepId === nextStep.id
        && !record.confirmation?.approvedAt) {
        next = await this.persist(transitionRun(record, RUN_STATUSES.awaitingConfirmation, {
          ...patch,
          confirmation: this.confirmationRecord(record, nextStep.id, 'before_step', nextStatus),
        }, this.now()));
        await this.sendConfirmation(next);
        return;
      }

      next = await this.persist(transitionRun(record, nextStatus, patch, completedAt));

      const commandId = `command_${this.randomId().replaceAll('-', '_')}`;
      const envelope = makeEnvelope(next, MESSAGE_TYPES.stepCommand, {
        arguments: clone(next.arguments),
        commandId,
        step: clone(nextStep),
        stepIndex: next.stepIndex,
      }, next.nextCoordinatorSequence);
      const commandDigest = await this.digest(envelope);
      next = await this.persist(updateRun(next, {
        nextCoordinatorSequence: next.nextCoordinatorSequence + 1,
        pendingCommand: {
          commandDigest,
          commandId,
          deadlineAt: null,
          dispatchedAt: null,
          documentId: next.execution.documentId,
          expectsNavigation: expectsNavigation(nextStep),
          stateBefore: next.execution.stateId,
          stepId: nextStep.id,
          stepIndex: next.stepIndex,
          urlBefore: next.execution.url,
          envelope,
        },
      }, this.now()));
      await this.dispatchPreparedStep(next);
    }

    async handleStepFailed(record, binding, message) {
      const pending = record.pendingCommand;
      if (!pending
        || pending.commandId !== message.payload.commandId
        || pending.stepIndex !== message.payload.stepIndex
        || pending.documentId !== binding.documentId) {
        throw new Error('Step failure does not match the pending command');
      }
      await this.fail(record.runId, {
        ...message.payload.error,
        observed: clone(message.payload.error.observed || {}),
      });
    }

    confirmationRecord(record, stepId, boundary, resumeStatus) {
      return {
        argumentPreview: redactedArgumentPreview(record.action, record.arguments),
        boundary,
        requestedAt: this.now(),
        resumeStatus,
        stepId,
        summary: `Approve ${record.action.tool.title} before step ${stepId}`,
      };
    }

    async awaitConfirmation(record, stepId, boundary) {
      const resumeStatus = boundary === 'before_run'
        ? RUN_STATUSES.openingTab
        : record.action.steps[record.stepIndex].op === 'extract'
          ? RUN_STATUSES.extracting
          : RUN_STATUSES.dispatchingStep;
      const next = await this.persist(transitionRun(record, RUN_STATUSES.awaitingConfirmation, {
        confirmation: this.confirmationRecord(record, stepId, boundary, resumeStatus),
      }, this.now()));
      await this.sendConfirmation(next);
      return next;
    }

    async sendConfirmation(inputRecord) {
      let record = inputRecord;
      if (!record.confirmation.envelope) {
        const envelope = makeEnvelope(record, MESSAGE_TYPES.runAwaitingConfirmation, {
          argumentPreview: record.confirmation.argumentPreview,
          stepId: record.confirmation.stepId,
          summary: record.confirmation.summary,
        }, record.nextCoordinatorSequence);
        record = await this.persist(updateRun(record, {
          confirmation: { ...record.confirmation, envelope },
          nextCoordinatorSequence: record.nextCoordinatorSequence + 1,
        }, this.now()));
      }
      this.reviewPorts.forEach((port) => port.postMessage(record.confirmation.envelope));
      const sourcePort = this.sourcePorts.get(this.sourceKey(record.source));
      if (sourcePort) sourcePort.postMessage(record.confirmation.envelope);
      return record;
    }

    async complete(record) {
      if (isTerminal(record.status)) return record;
      const payload = {
        actionId: record.actionId,
        actionVersion: record.actionVersion,
        data: clone(record.result),
        evidence: {
          completedSteps: [...record.completedSteps],
          finalStateId: record.execution.stateId,
          finalUrl: record.execution.url,
        },
      };
      return this.terminal(record, RUN_STATUSES.completed, MESSAGE_TYPES.runResult, payload);
    }

    async fail(runId, error) {
      const record = await this.storage.load(runId);
      if (!record || isTerminal(record.status)) return record;
      return this.terminal(record, RUN_STATUSES.failed, MESSAGE_TYPES.runError, error);
    }

    async cancel(runId, reason = 'The run was cancelled') {
      const record = await this.storage.load(runId);
      if (!record || isTerminal(record.status)) return record;
      return this.terminal(record, RUN_STATUSES.cancelled, MESSAGE_TYPES.runError, createError(
        ERROR_CODES.cancelled,
        reason,
        { stepId: record.pendingCommand?.stepId || null },
      ));
    }

    async terminal(record, status, type, payload) {
      if (isTerminal(record.status)) return record;
      const envelope = makeEnvelope(record, type, clone(payload), record.nextCoordinatorSequence);
      const failedStepObservation = type === MESSAGE_TYPES.runError && record.pendingCommand
        ? [{
          durationMs: record.pendingCommand.dispatchedAt
            ? Math.max(0, Date.parse(this.now()) - Date.parse(record.pendingCommand.dispatchedAt))
            : 0,
          locatorStrategyIndex: null,
          matchCount: null,
          postconditionSatisfied: false,
          status: status === RUN_STATUSES.cancelled ? 'cancelled' : 'failed',
          stepId: record.pendingCommand.stepId,
        }]
        : [];
      let terminalRecord = await this.persist(transitionRun(record, status, {
        error: type === MESSAGE_TYPES.runError ? clone(payload) : null,
        nextCoordinatorSequence: record.nextCoordinatorSequence + 1,
        stepObservations: [...record.stepObservations, ...failedStepObservation],
        terminal: {
          dispatched: false,
          envelope,
        },
      }, this.now()));
      this.clearDeadline(record.runId);
      terminalRecord = await this.storeObservation(terminalRecord);
      try {
        await this.dispatchTerminal(terminalRecord);
      } finally {
        await this.closeExecutionTab(terminalRecord);
      }
      return this.storage.load(record.runId);
    }

    async closeExecutionTab(record) {
      if (record.action?.runtime.closeExecutionTab
        && Number.isInteger(record.execution.tabId)) {
        await this.tabs.remove(record.execution.tabId).catch(() => {});
      }
    }

    async dispatchTerminal(inputRecord, providedPort = null) {
      if (!inputRecord.terminal || inputRecord.terminal.dispatched) return inputRecord;
      const port = providedPort || this.sourcePorts.get(this.sourceKey(inputRecord.source));
      if (!port) return inputRecord;
      port.postMessage(inputRecord.terminal.envelope);
      const record = await this.persist(updateRun(inputRecord, {
        terminal: {
          ...inputRecord.terminal,
          dispatched: true,
          dispatchedAt: this.now(),
        },
      }, this.now()));
      return record;
    }

    async storeObservation(inputRecord) {
      if (inputRecord.observationStored) return inputRecord;
      const observation = {
        actionId: inputRecord.actionId,
        actionVersion: inputRecord.actionVersion,
        errorCode: inputRecord.error?.code || null,
        finalStateId: inputRecord.execution.stateId,
        finishedAt: inputRecord.updatedAt,
        listDigest: inputRecord.listDigest,
        listId: inputRecord.listId,
        runId: inputRecord.runId,
        schemaVersion: 'run-observation/1',
        startedAt: inputRecord.createdAt,
        status: inputRecord.status === RUN_STATUSES.completed ? 'completed' : inputRecord.status,
        steps: clone(inputRecord.stepObservations),
      };
      await this.observations.save(observation);
      return this.persist(updateRun(inputRecord, { observationStored: true }, this.now()));
    }

    scheduleDeadline(record) {
      this.clearDeadline(record.runId);
      if (!record.deadlineAt || isTerminal(record.status)) return;
      const deadlines = [record.deadlineAt, record.pendingCommand?.deadlineAt]
        .filter(Boolean)
        .map((value) => Date.parse(value));
      const delay = Math.max(0, Math.min(...deadlines) - Date.parse(this.now()));
      const timer = this.setTimer(() => {
        void this.enqueue(record.runId, () => this.timeout(record.runId));
      }, delay);
      this.deadlineTimers.set(record.runId, timer);
    }

    clearDeadline(runId) {
      const timer = this.deadlineTimers.get(runId);
      if (timer !== undefined) this.clearTimer(timer);
      this.deadlineTimers.delete(runId);
    }

    async timeout(runId) {
      const record = await this.storage.load(runId);
      if (!record || isTerminal(record.status)) return record;
      const now = Date.parse(this.now());
      const actionExpired = record.deadlineAt && Date.parse(record.deadlineAt) <= now;
      const stepExpired = record.pendingCommand?.deadlineAt
        && Date.parse(record.pendingCommand.deadlineAt) <= now;
      if (!actionExpired && !stepExpired) {
        this.scheduleDeadline(record);
        return record;
      }
      return this.fail(runId, createError(
        ERROR_CODES.timeout,
        stepExpired
          ? 'The pending step exceeded its published timeout'
          : 'The action exceeded its published duration limit',
        { stepId: record.pendingCommand?.stepId || null },
      ));
    }

    async tabClosed(tabId) {
      const runs = await this.storage.list();
      const executionRuns = runs
        .filter((run) => !isTerminal(run.status) && run.execution.tabId === tabId)
        .map((run) => this.enqueue(run.runId, () => this.fail(
          run.runId,
          createError(
            ERROR_CODES.executionTabClosed,
            'The background execution tab was closed',
            { stepId: run.pendingCommand?.stepId || null },
          ),
        )));
      const sourceRuns = runs
        .filter((run) => !isTerminal(run.status) && run.source.tabId === tabId)
        .map((run) => this.enqueue(run.runId, () => this.fail(
          run.runId,
          createError(
            ERROR_CODES.transportDisconnected,
            'The source tab closed before the run completed',
            { stepId: run.pendingCommand?.stepId || null },
          ),
        )));
      await Promise.all([...executionRuns, ...sourceRuns]);
    }

    async recover() {
      const runs = await this.storage.list();
      for (const run of runs) {
        if (isTerminal(run.status)) {
          if (!run.observationStored) await this.storeObservation(run);
          const current = await this.storage.load(run.runId);
          if (current.terminal && !current.terminal.dispatched) {
            await this.dispatchTerminal(current);
          }
          await this.closeExecutionTab(current);
          continue;
        }
        const actionExpired = run.deadlineAt
          && Date.parse(run.deadlineAt) <= Date.parse(this.now());
        const stepExpired = run.pendingCommand?.deadlineAt
          && Date.parse(run.pendingCommand.deadlineAt) <= Date.parse(this.now());
        if (actionExpired || stepExpired) {
          await this.timeout(run.runId);
          continue;
        }
        if (run.status === RUN_STATUSES.created) {
          await this.resolveCreatedRun(run);
          continue;
        }
        this.scheduleDeadline(run);
        const decision = await this.authorize({
          action: run.action,
          list: { policy: run.listPolicy, site: run.site },
          now: this.now(),
          origin: parseUrl(run.source.url)?.origin,
        });
        if (!decision?.allowed) {
          await this.fail(run.runId, createError(
            ERROR_CODES.policyBlocked,
            'Current policy no longer authorizes this recovered action',
            { observed: { reasonCode: decision?.reasonCode || 'POLICY_BLOCKED' } },
          ));
          continue;
        }
        if ([RUN_STATUSES.policyChecked, RUN_STATUSES.openingTab].includes(run.status)) {
          if (run.status === RUN_STATUSES.policyChecked) {
            await this.openExecutionTab(run);
          } else {
            const inUseTabIds = runs
              .filter((candidate) => !isTerminal(candidate.status)
                && candidate.runId !== run.runId)
              .map((candidate) => candidate.execution.tabId)
              .filter(Number.isInteger);
            const reusable = this.tabs.findReusable
              ? await this.tabs.findReusable({
                excludeTabIds: inUseTabIds,
                origin: run.site.origin,
                url: run.source.url,
              })
              : null;
            if (reusable) {
              const waiting = await this.persist(transitionRun(run, RUN_STATUSES.waitingForPage, {
                execution: {
                  documentId: null,
                  navigationSequence: -1,
                  stateId: null,
                  tabId: reusable.id,
                  url: reusable.url || run.source.url,
                },
              }, this.now()));
              await this.sendAccepted(waiting);
            } else if (run.action.safety.idempotency === 'safe') {
              const tab = await this.tabs.create({ active: false, url: run.source.url });
              const waiting = await this.persist(transitionRun(run, RUN_STATUSES.waitingForPage, {
                execution: {
                  documentId: null,
                  navigationSequence: -1,
                  stateId: null,
                  tabId: tab.id,
                  url: tab.url || run.source.url,
                },
              }, this.now()));
              await this.sendAccepted(waiting);
            } else {
              await this.fail(run.runId, createError(
                ERROR_CODES.transportDisconnected,
                'Execution tab creation was interrupted before its identity was persisted',
                { retryable: run.action.safety.idempotency === 'safe' },
              ));
            }
          }
          continue;
        }
        if (run.status === RUN_STATUSES.dispatchingStep) {
          await this.dispatchPreparedStep(run);
          continue;
        }
        if (Number.isInteger(run.execution.tabId)) {
          const tab = await this.tabs.get(run.execution.tabId).catch(() => null);
          if (!tab) {
            await this.tabClosed(run.execution.tabId);
          }
        }
      }
    }

    async resumeSource(binding, port) {
      const runs = await this.storage.list();
      for (const run of runs.filter((candidate) => (
        candidate.source.tabId === binding.tabId
        && candidate.source.documentId === binding.documentId
      ))) {
        if (run.terminal && !run.terminal.dispatched) {
          await this.dispatchTerminal(run, port);
        } else if (!run.terminal && run.acceptedEnvelope) {
          port.postMessage(run.acceptedEnvelope);
        }
      }
    }

    async resumeReview(port) {
      const runs = await this.storage.list();
      runs.filter((run) => (
        run.status === RUN_STATUSES.awaitingConfirmation && run.confirmation?.envelope
      )).forEach((run) => port.postMessage(run.confirmation.envelope));
    }

    async resumeExecutionTab(tabId) {
      const runs = await this.storage.list();
      for (const run of runs.filter((candidate) => (
        !isTerminal(candidate.status) && candidate.execution.tabId === tabId
      ))) {
        await this.enqueue(run.runId, async () => {
          let current = await this.storage.load(run.runId);
          if (!current || isTerminal(current.status) || current.execution.tabId !== tabId) return;

          const port = this.executionPorts.get(tabId);
          if (!port) return;
          const initialization = makeEnvelope(current, MESSAGE_TYPES.executionInitialize, {
            action: clone(current.action),
            states: clone(current.states || []),
          }, current.nextCoordinatorSequence);
          current = await this.persist(updateRun(current, {
            nextCoordinatorSequence: current.nextCoordinatorSequence + 1,
          }, this.now()));
          port.postMessage(initialization);

          if ([RUN_STATUSES.waitingForEffect, RUN_STATUSES.extracting].includes(current.status)
            && current.pendingCommand) {
            if (current.action.safety.idempotency === 'safe') {
              await this.dispatchPreparedStep(current);
            } else {
              await this.fail(current.runId, createError(
                ERROR_CODES.transportDisconnected,
                'A non-repeatable command has an uncertain completion state after restart',
                { stepId: current.pendingCommand.stepId },
              ));
            }
          }
        });
      }
    }
  }

  return {
    DurableRunCoordinator,
    ERROR_CODES,
    MESSAGE_TYPES,
    PORT_NAMES,
    RUN_PROTOCOL,
    canonicalStringify,
    createError,
    defaultDigest,
    defaultPolicyAuthorize,
    routeMatches,
    validateArguments,
    validateEnvelopeBase,
    validateRunRequest,
  };
}));
