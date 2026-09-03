(function initializeActorClient(root, factory) {
  const isCommonJS = typeof module !== 'undefined' && module.exports;
  const api = factory(
    isCommonJS ? require('../shared/protocol.js') : root.WebMcpProtocol,
    isCommonJS ? require('./runtime.js') : root.WebMcpActor,
    root,
  );
  if (isCommonJS) module.exports = api;
  root.WebMcpActorClient = api;
}(typeof globalThis === 'undefined' ? this : globalThis, (protocol, actor, root) => {
  'use strict';

  const PORT_NAME = 'webmcp-run/1:execution';
  const REPLAY_PORT_NAME = 'webmcp-run/1:replay';
  const MAX_COMPLETED_COMMANDS = 64;

  const createExecutionClient = (options = {}) => {
    const runtime = options.runtime || root.chrome?.runtime;
    const portName = options.portName || PORT_NAME;
    const documentObject = options.documentObject || root.document;
    const windowObject = options.windowObject || root.window;
    const locationObject = options.locationObject || root.location;
    const session = options.sessionStorage || root.sessionStorage;
    const now = options.now || (() => new Date().toISOString());
    const setTimer = options.setTimer || root.setTimeout;
    const clearTimer = options.clearTimer || root.clearTimeout;
    const reconnectDelayMs = options.reconnectDelayMs ?? 100;
    const actorApi = options.actor || actor;
    const outcomes = new Map();
    const controllers = new Map();
    let port = null;
    let disconnectListener = null;
    let started = false;
    let stopped = false;
    let plan = null;
    let reconnectTimer = null;
    let sequence = 0;

    const navigationSequence = (() => {
      const key = 'webmcp-execution-navigation-sequence';
      let prior = null;
      try { prior = session?.getItem(key); } catch { prior = null; }
      const value = prior === null ? 0 : Number.parseInt(prior, 10) + 1;
      try { session?.setItem(key, String(Number.isFinite(value) ? value : 0)); } catch {}
      return Number.isFinite(value) ? value : 0;
    })();

    const sender = () => ({ context: 'execution_content', documentId: null, tabId: null });
    const post = (type, requestId, runId, payload) => {
      sequence += 1;
      port?.postMessage(protocol.createEnvelope({
        type, requestId, runId, sequence, sentAt: now(), sender: sender(), payload,
      }));
    };

    const remember = (commandId, outcome) => {
      outcomes.set(commandId, outcome);
      while (outcomes.size > MAX_COMPLETED_COMMANDS) outcomes.delete(outcomes.keys().next().value);
    };

    const announceReady = async (message) => {
      plan = {
        action: message.payload.action,
        states: message.payload.states,
        requestId: message.requestId,
        runId: message.runId,
      };
      const stateId = await actorApi.detectStateId({
        action: plan.action,
        states: plan.states,
        document: documentObject,
        timeoutMs: plan.action?.runtime?.stateDetectionTimeoutMs || 0,
      });
      post(protocol.RUN_MESSAGE_TYPES.pageReady, plan.requestId, plan.runId, {
        navigationSequence,
        stateId,
        title: String(documentObject?.title || '').slice(0, 1000),
        url: locationObject.href,
      });
    };

    const execute = async (message) => {
      if (!plan || message.runId !== plan.runId || message.requestId !== plan.requestId) return;
      const commandId = message.payload?.commandId;
      if (!commandId) return;
      if (outcomes.has(commandId)) {
        const cached = outcomes.get(commandId);
        post(cached.type, message.requestId, message.runId, cached.payload);
        return;
      }
      if (controllers.size > 0) return;
      const controller = new AbortController();
      controllers.set(commandId, controller);
      const outcome = await actorApi.executeStep({
        action: plan.action,
        states: plan.states,
        command: message,
        document: documentObject,
        signal: controller.signal,
      });
      controllers.delete(commandId);
      remember(commandId, outcome);
      post(outcome.type, message.requestId, message.runId, outcome.payload);
    };

    const onMessage = (message) => {
      if (message?.protocol !== protocol.RUN_PROTOCOL) return;
      if (message.type === protocol.RUN_MESSAGE_TYPES.executionInitialize) {
        void announceReady(message);
      } else if (message.type === protocol.RUN_MESSAGE_TYPES.stepCommand) {
        void execute(message);
      }
    };
    const connect = () => {
      if (stopped || !runtime?.connect) return false;
      const nextPort = runtime.connect({ name: portName });
      port = nextPort;
      nextPort.onMessage.addListener(onMessage);
      disconnectListener = () => onDisconnect(nextPort);
      nextPort.onDisconnect.addListener(disconnectListener);
      return true;
    };
    const onDisconnect = (disconnectedPort) => {
      if (port !== disconnectedPort) return;
      port = null;
      disconnectListener = null;
      plan = null;
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
      if (!stopped && !reconnectTimer && typeof setTimer === 'function') {
        reconnectTimer = setTimer(() => {
          reconnectTimer = null;
          connect();
        }, reconnectDelayMs);
      }
    };
    const start = () => {
      if (started || !runtime?.connect) return false;
      started = true;
      stopped = false;
      connect();
      windowObject?.addEventListener?.('pagehide', () => {
        controllers.forEach((controller) => controller.abort());
      });
      return true;
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer !== null && typeof clearTimer === 'function') {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
      port?.onMessage?.removeListener?.(onMessage);
      port?.onDisconnect?.removeListener?.(disconnectListener);
      port?.disconnect?.();
      port = null;
    };
    return Object.freeze({ start, stop, __test: { onMessage, outcomes } });
  };

  const defaultClients = new Map();
  const getDefaultClient = (portName) => {
    if (!defaultClients.has(portName)) {
      defaultClients.set(portName, createExecutionClient({ portName }));
    }
    return defaultClients.get(portName);
  };
  return Object.freeze({
    PORT_NAME,
    REPLAY_PORT_NAME,
    createExecutionClient,
    start: () => getDefaultClient(PORT_NAME).start(),
    startReplay: () => getDefaultClient(REPLAY_PORT_NAME).start(),
    stop: () => getDefaultClient(PORT_NAME).stop(),
    stopReplay: () => getDefaultClient(REPLAY_PORT_NAME).stop(),
  });
}));
