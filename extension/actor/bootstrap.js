(function initializeActorBootstrap(root, factory) {
  const isCommonJS = typeof module !== 'undefined' && module.exports;
  const api = factory(
    isCommonJS ? require('../shared/protocol.js') : root.WebMcpProtocol,
    root,
  );

  if (isCommonJS) module.exports = api;
  root.WebMcpActorBootstrap = api;
}(typeof globalThis === 'undefined' ? this : globalThis, (protocol, root) => {
  'use strict';

  const PORT_NAME = 'webmcp-run/1:execution';
  const REPLAY_PORT_NAME = 'webmcp-run/1:replay';
  const BINDING_PROTOCOL = 'webmcp-internal/1';
  const BINDING_TYPE = 'execution.binding';

  const cloneJson = (value) => JSON.parse(JSON.stringify(value));

  const createActorBridge = (options = {}) => {
    const runtime = options.runtime || root.chrome?.runtime;
    const actor = options.actor || root.WebMcpActor;
    const documentObject = options.documentObject || root.document;
    const now = options.now || (() => new Date().toISOString());
    const schedule = options.schedule || ((callback, delay) => root.setTimeout(callback, delay));
    const cancelSchedule = options.cancelSchedule || ((timer) => root.clearTimeout(timer));
    const reconnectDelayMs = options.reconnectDelayMs ?? 50;
    const portName = options.portName || PORT_NAME;
    const MutationObserverClass = options.MutationObserver
      || documentObject?.defaultView?.MutationObserver
      || root.MutationObserver;
    let activeCommand = null;
    let binding = null;
    let port = null;
    let reconnectTimer = null;
    let revisionObserver = null;
    let pageRevision = 0;
    let sequence = 0;
    let started = false;

    const validBinding = (message) => Boolean(
      message
      && message.protocol === BINDING_PROTOCOL
      && message.type === BINDING_TYPE
      && typeof message.requestId === 'string'
      && typeof message.runId === 'string'
      && Number.isInteger(message.payload?.tabId)
      && typeof message.payload?.documentId === 'string'
      && Number.isInteger(message.payload?.lastAcceptedSequence)
      && message.payload.lastAcceptedSequence >= 0
      && Number.isInteger(message.payload?.navigationSequence)
      && message.payload.navigationSequence >= 0
      && typeof message.payload?.requiresPrecondition === 'boolean'
      && message.payload.action
      && Array.isArray(message.payload.states),
    );

    const postEnvelope = (type, payload) => {
      if (!port || !binding) return;
      sequence += 1;
      port.postMessage(protocol.createEnvelope({
        type,
        requestId: binding.requestId,
        runId: binding.runId,
        sequence,
        sentAt: now(),
        sender: {
          context: 'execution_content',
          documentId: binding.documentId,
          tabId: binding.tabId,
        },
        payload,
      }));
    };

    const announcePage = async (currentBinding) => {
      const readinessTimeoutMs = currentBinding.pendingStep?.timeoutMs
        || currentBinding.action.steps?.[0]?.timeoutMs
        || 5000;
      let stateId = null;
      let preconditionSatisfied = false;
      let pendingStepSatisfied = null;
      try {
        [stateId, preconditionSatisfied, pendingStepSatisfied] = await Promise.all([
          actor.detectStateId({
            action: currentBinding.action,
            arguments: currentBinding.arguments,
            document: documentObject,
            states: currentBinding.states,
            timeoutMs: readinessTimeoutMs,
          }),
          currentBinding.requiresPrecondition
            ? actor.evaluateConditionSet({
              action: currentBinding.action,
              arguments: currentBinding.arguments,
              document: documentObject,
              set: currentBinding.action.precondition.checks,
              states: currentBinding.states,
              timeoutMs: readinessTimeoutMs,
            })
            : Promise.resolve(true),
          currentBinding.pendingStep
            ? actor.evaluateConditionSet({
              action: currentBinding.action,
              arguments: currentBinding.arguments,
              document: documentObject,
              set: currentBinding.pendingStep.expect,
              states: currentBinding.states,
              step: currentBinding.pendingStep,
              timeoutMs: readinessTimeoutMs,
            })
            : Promise.resolve(null),
        ]);
      } catch (error) {
        stateId = null;
        preconditionSatisfied = false;
        pendingStepSatisfied = false;
      }
      if (binding !== currentBinding || !port) return;
      postEnvelope(protocol.RUN_MESSAGE_TYPES.pageReady, {
        navigationSequence: currentBinding.navigationSequence,
        pageRevision,
        pendingStepSatisfied,
        preconditionSatisfied,
        stateId,
        title: documentObject.title || '',
        url: documentObject.location.href,
      });
    };

    const executeCommand = async (message) => {
      if (!binding
        || message.protocol !== protocol.RUN_PROTOCOL
        || message.type !== protocol.RUN_MESSAGE_TYPES.stepCommand
        || message.requestId !== binding.requestId
        || message.runId !== binding.runId) {
        return;
      }
      activeCommand?.abort();
      const controller = new AbortController();
      activeCommand = controller;
      const outcome = await actor.executeStep({
        action: binding.action,
        actionStartedAt: Date.parse(binding.actionStartedAt),
        command: message,
        document: documentObject,
        signal: controller.signal,
        states: binding.states,
      });
      if (activeCommand !== controller || binding?.runId !== message.runId) return;
      activeCommand = null;
      const payload = cloneJson(outcome.payload);
      if (outcome.type === protocol.RUN_MESSAGE_TYPES.stepCompleted && payload.effect) {
        payload.effect.pageRevisionAfter = pageRevision;
      }
      postEnvelope(outcome.type, payload);
    };

    const handlePortMessage = (message) => {
      if (validBinding(message)) {
        activeCommand?.abort();
        activeCommand = null;
        binding = {
          action: cloneJson(message.payload.action),
          actionStartedAt: message.payload.actionStartedAt,
          arguments: cloneJson(message.payload.arguments || {}),
          documentId: message.payload.documentId,
          lastAcceptedSequence: message.payload.lastAcceptedSequence,
          navigationSequence: message.payload.navigationSequence,
          pendingStep: message.payload.pendingStep && cloneJson(message.payload.pendingStep),
          requiresPrecondition: message.payload.requiresPrecondition,
          requestId: message.requestId,
          runId: message.runId,
          states: cloneJson(message.payload.states),
          tabId: message.payload.tabId,
        };
        sequence = binding.lastAcceptedSequence;
        void announcePage(binding);
        return;
      }
      void executeCommand(message);
    };

    const connect = () => {
      if (!started || port || !runtime?.connect) return;
      try {
        port = runtime.connect({ name: portName });
        port.onMessage.addListener(handlePortMessage);
        port.onDisconnect.addListener(() => {
          port = null;
          binding = null;
          activeCommand?.abort();
          activeCommand = null;
          if (started && !reconnectTimer) {
            reconnectTimer = schedule(() => {
              reconnectTimer = null;
              connect();
            }, reconnectDelayMs);
          }
        });
      } catch (error) {
        port = null;
        if (!reconnectTimer) {
          reconnectTimer = schedule(() => {
            reconnectTimer = null;
            connect();
          }, reconnectDelayMs);
        }
      }
    };

    const start = () => {
      if (started) return;
      started = true;
      if (!revisionObserver && MutationObserverClass && documentObject?.documentElement) {
        revisionObserver = new MutationObserverClass(() => { pageRevision += 1; });
        revisionObserver.observe(documentObject.documentElement, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
      }
      connect();
    };

    const stop = () => {
      started = false;
      activeCommand?.abort();
      activeCommand = null;
      binding = null;
      if (reconnectTimer) cancelSchedule(reconnectTimer);
      reconnectTimer = null;
      revisionObserver?.disconnect();
      revisionObserver = null;
      port?.disconnect?.();
      port = null;
    };

    return {
      start,
      stop,
      __test: {
        getBinding: () => binding && cloneJson(binding),
        handlePortMessage,
      },
    };
  };

  let defaultBridge = null;
  let defaultReplayBridge = null;
  const getDefaultBridge = () => {
    if (!defaultBridge) defaultBridge = createActorBridge();
    return defaultBridge;
  };
  const getDefaultReplayBridge = () => {
    if (!defaultReplayBridge) {
      defaultReplayBridge = createActorBridge({ portName: REPLAY_PORT_NAME });
    }
    return defaultReplayBridge;
  };

  return {
    BINDING_PROTOCOL,
    BINDING_TYPE,
    PORT_NAME,
    REPLAY_PORT_NAME,
    createActorBridge,
    start: () => getDefaultBridge().start(),
    startReplay: () => getDefaultReplayBridge().start(),
    stop: () => getDefaultBridge().stop(),
    stopReplay: () => getDefaultReplayBridge().stop(),
  };
}));
