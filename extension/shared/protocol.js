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
    runAck: 'run.ack',
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
    clearRecording: 'CLEAR_RECORDING',
    discover: 'DISCOVER',
    executeStep: 'EXECUTE_STEP',
    getAdapters: 'GET_ADAPTERS',
    getBackendHealth: 'GET_BACKEND_HEALTH',
    getJob: 'GET_JOB',
    getPageState: 'GET_PAGE_STATE',
    getPopupState: 'GET_POPUP_STATE',
    pageReady: 'PAGE_READY',
    publishCandidate: 'PUBLISH_CANDIDATE',
    recordingStart: 'RECORDING_START',
    recordingStop: 'RECORDING_STOP',
    refreshAdapters: 'REFRESH_ADAPTERS',
    startJob: 'START_JOB',
    startRecording: 'START_RECORDING',
    stopRecording: 'STOP_RECORDING',
    synthesize: 'SYNTHESIZE',
    traceEventCompleted: 'TRACE_EVENT_COMPLETED',
    traceEventStarted: 'TRACE_EVENT_STARTED',
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
