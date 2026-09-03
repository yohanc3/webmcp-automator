(function initializeRunState(root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.WebMcpRunState = api;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const RUN_RECORD_VERSION = 'coordinator-run/1';

  const RUN_STATUSES = Object.freeze({
    awaitingConfirmation: 'awaiting_confirmation',
    cancelled: 'cancelled',
    completed: 'completed',
    created: 'created',
    dispatchingStep: 'dispatching_step',
    extracting: 'extracting',
    failed: 'failed',
    openingTab: 'opening_tab',
    policyChecked: 'policy_checked',
    waitingForEffect: 'waiting_for_effect',
    waitingForNavigation: 'waiting_for_navigation',
    waitingForPage: 'waiting_for_page',
  });

  const TERMINAL_STATUSES = Object.freeze([
    RUN_STATUSES.cancelled,
    RUN_STATUSES.completed,
    RUN_STATUSES.failed,
  ]);

  const LEGAL_TRANSITIONS = Object.freeze({
    [RUN_STATUSES.created]: Object.freeze([
      RUN_STATUSES.policyChecked,
      RUN_STATUSES.cancelled,
      RUN_STATUSES.failed,
    ]),
    [RUN_STATUSES.policyChecked]: Object.freeze([
      RUN_STATUSES.awaitingConfirmation,
      RUN_STATUSES.openingTab,
      RUN_STATUSES.cancelled,
      RUN_STATUSES.failed,
    ]),
    [RUN_STATUSES.openingTab]: Object.freeze([
      RUN_STATUSES.waitingForPage,
      RUN_STATUSES.cancelled,
      RUN_STATUSES.failed,
    ]),
    [RUN_STATUSES.waitingForPage]: Object.freeze([
      RUN_STATUSES.awaitingConfirmation,
      RUN_STATUSES.dispatchingStep,
      RUN_STATUSES.extracting,
      RUN_STATUSES.cancelled,
      RUN_STATUSES.failed,
    ]),
    [RUN_STATUSES.dispatchingStep]: Object.freeze([
      RUN_STATUSES.waitingForEffect,
      RUN_STATUSES.waitingForNavigation,
      RUN_STATUSES.cancelled,
      RUN_STATUSES.failed,
    ]),
    [RUN_STATUSES.waitingForEffect]: Object.freeze([
      RUN_STATUSES.awaitingConfirmation,
      RUN_STATUSES.dispatchingStep,
      RUN_STATUSES.extracting,
      RUN_STATUSES.completed,
      RUN_STATUSES.cancelled,
      RUN_STATUSES.failed,
    ]),
    [RUN_STATUSES.waitingForNavigation]: Object.freeze([
      RUN_STATUSES.awaitingConfirmation,
      RUN_STATUSES.dispatchingStep,
      RUN_STATUSES.extracting,
      RUN_STATUSES.completed,
      RUN_STATUSES.cancelled,
      RUN_STATUSES.failed,
    ]),
    [RUN_STATUSES.awaitingConfirmation]: Object.freeze([
      RUN_STATUSES.openingTab,
      RUN_STATUSES.dispatchingStep,
      RUN_STATUSES.extracting,
      RUN_STATUSES.cancelled,
      RUN_STATUSES.failed,
    ]),
    [RUN_STATUSES.extracting]: Object.freeze([
      RUN_STATUSES.completed,
      RUN_STATUSES.cancelled,
      RUN_STATUSES.failed,
    ]),
    [RUN_STATUSES.completed]: Object.freeze([]),
    [RUN_STATUSES.failed]: Object.freeze([]),
    [RUN_STATUSES.cancelled]: Object.freeze([]),
  });

  const clone = (value) => {
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  };

  const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

  const assertRecord = (record) => {
    if (!record || record.schemaVersion !== RUN_RECORD_VERSION) {
      throw new Error('Invalid durable run record');
    }
    if (!Object.values(RUN_STATUSES).includes(record.status)) {
      throw new Error(`Unknown durable run status: ${record.status}`);
    }
    if (!record.runId || !record.requestId || !record.source) {
      throw new Error('Durable run identity is incomplete');
    }
    return record;
  };

  const createRunRecord = ({
    runId,
    request,
    source,
    now,
    deadlineAt,
  }) => assertRecord({
    schemaVersion: RUN_RECORD_VERSION,
    runId,
    requestId: request.requestId,
    source: {
      tabId: source.tabId,
      documentId: source.documentId,
      url: source.url,
    },
    execution: {
      tabId: null,
      documentId: null,
      navigationSequence: -1,
      url: null,
      stateId: null,
    },
    listId: request.payload.listId,
    listDigest: null,
    actionId: request.payload.actionId,
    actionVersion: request.payload.actionVersion,
    action: null,
    states: [],
    arguments: clone(request.payload.arguments),
    status: RUN_STATUSES.created,
    stepIndex: 0,
    completedSteps: [],
    pendingCommand: null,
    confirmation: null,
    result: null,
    error: null,
    lastAcceptedSequenceBySender: {},
    acceptedEventDigests: {},
    dispatchedCommandDigests: {},
    stepObservations: [],
    terminal: null,
    observationStored: false,
    createdAt: now,
    updatedAt: now,
    deadlineAt,
  });

  const transitionRun = (record, nextStatus, patch = {}, now = new Date().toISOString()) => {
    assertRecord(record);
    if (record.status === nextStatus) {
      throw new Error(`Self-transition is not legal: ${record.status}`);
    }
    if (!LEGAL_TRANSITIONS[record.status].includes(nextStatus)) {
      throw new Error(`Illegal run transition: ${record.status} -> ${nextStatus}`);
    }

    return assertRecord({
      ...clone(record),
      ...clone(patch),
      status: nextStatus,
      updatedAt: now,
    });
  };

  const updateRun = (record, patch, now = new Date().toISOString()) => {
    assertRecord(record);
    if (isTerminal(record.status)
      && Object.keys(patch).some((key) => !['observationStored', 'terminal'].includes(key))) {
      throw new Error('Terminal run state is immutable');
    }
    return assertRecord({
      ...clone(record),
      ...clone(patch),
      updatedAt: now,
    });
  };

  const senderKey = (message) => [
    message.sender.context,
    message.sender.tabId ?? 'none',
    message.sender.documentId ?? 'none',
  ].join(':');

  const acceptEvent = (record, message, digest, now = new Date().toISOString()) => {
    assertRecord(record);
    const identity = senderKey(message);
    const lastSequence = record.lastAcceptedSequenceBySender[identity] || 0;
    const priorDigest = record.acceptedEventDigests[digest];

    if (priorDigest) {
      return { duplicate: true, record };
    }
    if (message.sequence <= lastSequence) {
      throw new Error(`Out-of-order event sequence from ${identity}`);
    }

    return {
      duplicate: false,
      record: updateRun(record, {
        lastAcceptedSequenceBySender: {
          ...record.lastAcceptedSequenceBySender,
          [identity]: message.sequence,
        },
        acceptedEventDigests: {
          ...record.acceptedEventDigests,
          [digest]: {
            type: message.type,
            sequence: message.sequence,
          },
        },
      }, now),
    };
  };

  return {
    LEGAL_TRANSITIONS,
    RUN_RECORD_VERSION,
    RUN_STATUSES,
    TERMINAL_STATUSES,
    acceptEvent,
    assertRecord,
    clone,
    createRunRecord,
    isTerminal,
    senderKey,
    transitionRun,
    updateRun,
  };
}));
