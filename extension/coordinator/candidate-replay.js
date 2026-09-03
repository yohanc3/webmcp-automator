(function initializeCandidateReplay(root, factory) {
  const isCommonJS = typeof module !== 'undefined' && module.exports;
  const api = factory(
    isCommonJS ? require('./run-coordinator.js') : root.WebMcpRunCoordinator,
    isCommonJS ? require('../shared/protocol.js') : root.WebMcpProtocol,
    root,
  );
  if (isCommonJS) module.exports = api;
  root.WebMcpCandidateReplay = api;
}(typeof globalThis === 'undefined' ? this : globalThis, (runApi, protocol, root) => {
  'use strict';

  const PORT_NAME = 'webmcp-run/1:replay';
  const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
  const clone = (value) => JSON.parse(JSON.stringify(value));

  const createMemoryStorage = () => {
    const records = new Map();
    return {
      async list() { return [...records.values()].map(clone); },
      async load(runId) { return records.has(runId) ? clone(records.get(runId)) : null; },
      async save(record) { records.set(record.runId, clone(record)); },
    };
  };

  const deriveArguments = (action, sourceUrl) => {
    const url = new URL(sourceUrl);
    const properties = action.tool?.inputSchema?.properties || {};
    return Object.fromEntries((action.tool?.inputSchema?.required || []).map((name) => {
      const property = properties[name] || {};
      if (Array.isArray(property.enum) && property.enum.length > 0) return [name, property.enum[0]];
      if (property.type === 'boolean') return [name, true];
      if (property.type === 'integer' || property.type === 'number') {
        return [name, Number.isFinite(property.minimum) ? property.minimum : 1];
      }
      return [name, url.searchParams.get(name) || url.searchParams.get('q') || 'test'];
    }));
  };

  const concreteURLFromPattern = (pattern, origin) => {
    if (typeof pattern !== 'string' || !pattern.startsWith('^') || !pattern.endsWith('$')) return null;
    let value = pattern.slice(1, -1)
      .replace(/\(\?:\\\?\.\*\)\?/g, '')
      .replace(/\\\//g, '/')
      .replace(/\\\./g, '.')
      .replace(/\/\?/g, '/');
    if (value.startsWith('/')) value = origin + value;
    if (/[()[\]{}+*?|]/.test(value)) return null;
    try {
      const url = new URL(value);
      return url.origin === origin && new RegExp(pattern).test(url.href) ? url.href : null;
    } catch (error) {
      return null;
    }
  };

  const replayURLForAction = (action, list, sourceUrl) => {
    const patterns = [...(action.precondition?.urlPatterns || [])];
    const allowedStates = new Set(action.precondition?.allowedStateIds || []);
    (list.states || []).filter(({ id }) => allowedStates.has(id)).forEach((state) => {
      (state.match?.checks || []).filter(({ kind }) => kind === 'url').forEach(({ pattern }) => patterns.push(pattern));
    });
    if (patterns.some((pattern) => {
      try { return new RegExp(pattern).test(sourceUrl); } catch (error) { return false; }
    })) return sourceUrl;
    for (const pattern of patterns) {
      const result = concreteURLFromPattern(pattern, list.site.origin);
      if (result) return result;
    }
    throw new Error(`Replay has no concrete start URL for ${action.id}`);
  };

  const executableView = ({ digest, list, now }) => {
    if (!DIGEST_PATTERN.test(digest || '')) throw new Error('Replay requires an exact candidate digest');
    const value = clone(list);
    value.publication.status = 'published';
    value.publication.contentDigest = digest;
    value.policy = {
      ...value.policy,
      status: 'allowed',
      scopes: ['inject', 'read', 'write', 'danger'],
      checkedAt: now(),
      expiresAt: null,
    };
    value.actions = value.actions.map((action) => ({
      ...action,
      lifecycle: 'published',
      safety: { ...action.safety, confirmation: 'none', confirmationStepId: null },
    }));
    return value;
  };

  const createReplayRunner = (options = {}) => {
    const now = options.now || (() => new Date().toISOString());
    const randomId = options.randomId || (() => crypto.randomUUID());
    const storage = options.storage || createMemoryStorage();
    const tabs = options.tabs;
    const plans = new Map();
    let active = false;

    if (!tabs) throw new Error('Candidate replay requires a tab adapter');

    const coordinator = options.coordinator || new runApi.DurableRunCoordinator({
      storage,
      tabs,
      observations: { async save() {} },
      validateActionList: () => ({ valid: true }),
      registry: {
        async resolveExact({ actionId, actionVersion, expectedDigest, listId, revision }) {
          const list = plans.get(listId);
          const action = list?.actions?.find((candidate) => (
            candidate.id === actionId && candidate.version === actionVersion
          ));
          if (!list
            || !action
            || list.publication?.contentDigest !== expectedDigest
            || list.publication?.revision !== revision) {
            throw new Error('The exact replay plan is no longer active');
          }
          return { digest: list.publication.contentDigest, list: clone(list) };
        },
      },
      now,
      randomId,
    });

    const bindPort = (port) => {
      if (port.name !== PORT_NAME) throw new Error('Unsupported replay actor port');
      return coordinator.bindPort({
        name: runApi.PORT_NAMES.execution,
        sender: port.sender,
        onMessage: port.onMessage,
        onDisconnect: port.onDisconnect,
        postMessage(message) { port.postMessage(message); },
        disconnect() { port.disconnect(); },
      });
    };

    const runAction = ({ action, list, sourceTabId, sourceUrl, timeoutMs }) => {
      let timer;
      return new Promise((resolve, reject) => {
        const requestId = `replay_${randomId().replaceAll('-', '_')}`;
        const sourcePort = {
          name: runApi.PORT_NAMES.source,
          sender: {
            documentId: `replay_document_${randomId().replaceAll('-', '_')}`,
            tab: { id: sourceTabId, url: sourceUrl },
            url: sourceUrl,
          },
          onDisconnect: { addListener() {} },
          onMessage: { addListener() {} },
          postMessage(message) {
            if (message.type === protocol.RUN_MESSAGE_TYPES.runResult) resolve(message.payload);
            if (message.type === protocol.RUN_MESSAGE_TYPES.runError) {
              reject(new Error(`${message.payload.code}: ${message.payload.message}`));
            }
          },
        };
        timer = root.setTimeout(() => reject(new Error('Candidate actor replay timed out')), timeoutMs);
        try {
          const binding = coordinator.bindPort(sourcePort);
          void coordinator.receive(sourcePort, binding, protocol.createEnvelope({
            type: protocol.RUN_MESSAGE_TYPES.runRequest,
            requestId,
            runId: null,
            sequence: 1,
            sentAt: now(),
            sender: { context: 'source_content', documentId: null, tabId: null },
            payload: {
              actionId: action.id,
              actionVersion: action.version,
              arguments: deriveArguments(action, sourceUrl),
              listDigest: list.publication.contentDigest,
              listId: list.listId,
              listRevision: list.publication.revision,
              sourceUrl,
            },
          })).catch(reject);
        } catch (error) {
          reject(error);
        }
      }).finally(() => root.clearTimeout?.(timer));
    };

    const runCandidate = async ({ digest, list, sourceTabId, sourceUrl }) => {
      if (active) throw new Error('Another candidate replay is already active');
      if (!Number.isInteger(sourceTabId) || new URL(sourceUrl).origin !== list.site.origin) {
        throw new Error('Candidate replay requires the active candidate origin');
      }
      active = true;
      const view = executableView({ digest, list, now });
      plans.set(view.listId, view);
      try {
        const actions = [];
        for (const action of view.actions) {
          const actionSourceUrl = replayURLForAction(action, view, sourceUrl);
          const result = await runAction({
            action,
            list: view,
            sourceTabId,
            sourceUrl: actionSourceUrl,
            timeoutMs: action.runtime.maxDurationMs + 5000,
          });
          const completed = result.evidence?.completedSteps || [];
          if (completed.length !== action.steps.length) {
            throw new Error(`Replay did not complete every step for ${action.id}`);
          }
          actions.push({
            actionId: action.id,
            actionVersion: action.version,
            stepsExecuted: completed.length,
            postconditionsVerified: completed.length,
          });
        }
        return { schemaVersion: 'candidate-replay/1', status: 'passed', actions };
      } finally {
        plans.delete(view.listId);
        active = false;
      }
    };

    return Object.freeze({
      bindPort,
      coordinator,
      runCandidate,
      tabClosed: (tabId) => coordinator.tabClosed(tabId),
    });
  };

  return Object.freeze({
    PORT_NAME, concreteURLFromPattern, createMemoryStorage, createReplayRunner,
    deriveArguments, executableView, replayURLForAction,
  });
}));
