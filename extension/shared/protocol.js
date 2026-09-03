(function initializeProtocol(root, factory) {
  const protocol = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = protocol;
  }

  root.WebMcpProtocol = protocol;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const RUN_PROTOCOL = 'webmcp-run/1';
  const RUN_MESSAGE_TYPES = Object.freeze({
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

  const MESSAGE_TYPES = Object.freeze({
    ambientConsumePending: 'AMBIENT_CONSUME_PENDING',
    ambientClearPending: 'AMBIENT_CLEAR_PENDING',
    ambientDeliverLayer: 'AMBIENT_DELIVER_LAYER',
    ambientNextLayerSequence: 'AMBIENT_NEXT_LAYER_SEQUENCE',
    ambientPolicyCurrent: 'AMBIENT_POLICY_CURRENT',
    ambientPutPending: 'AMBIENT_PUT_PENDING',
    ambientSpoolOperation: 'AMBIENT_SPOOL_OPERATION',
    executeStep: 'EXECUTE_STEP',
    getAdapters: 'GET_ADAPTERS',
    getBackendHealth: 'GET_BACKEND_HEALTH',
    getJob: 'GET_JOB',
    getPageState: 'GET_PAGE_STATE',
    getPopupState: 'GET_POPUP_STATE',
    pageReady: 'PAGE_READY',
    publishCandidate: 'PUBLISH_CANDIDATE',
    refreshAdapters: 'REFRESH_ADAPTERS',
    startJob: 'START_JOB',
    webMcpStatus: 'WEBMCP_STATUS',
  });

  const createMessage = (type, fields = {}) => ({ type, ...fields });

  const createEnvelope = ({
    type,
    requestId,
    runId,
    sequence,
    sender,
    payload,
    sentAt = new Date().toISOString(),
  }) => ({
    protocol: RUN_PROTOCOL,
    type,
    requestId,
    runId,
    sequence,
    sentAt,
    sender,
    payload,
  });

  const isMessage = (message, type) => message?.type === type;

  const sendRuntimeMessage = (runtime, message) => new Promise((resolve, reject) => {
    runtime.sendMessage(message, (response) => {
      const error = runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });

  return {
    MESSAGE_TYPES,
    RUN_MESSAGE_TYPES,
    RUN_PROTOCOL,
    createEnvelope,
    createMessage,
    isMessage,
    sendRuntimeMessage,
  };
}));
