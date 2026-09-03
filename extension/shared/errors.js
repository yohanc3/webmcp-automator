(function initializePublicErrors(root, factory) {
  const publicErrors = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = publicErrors;
  }

  root.WebMcpErrors = publicErrors;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const PUBLIC_ERROR_CODES = Object.freeze({
    cancelled: 'CANCELLED',
    confirmationDenied: 'CONFIRMATION_DENIED',
    confirmationRequired: 'CONFIRMATION_REQUIRED',
    executionTabClosed: 'EXECUTION_TAB_CLOSED',
    internalError: 'INTERNAL_ERROR',
    invalidArguments: 'INVALID_ARGUMENTS',
    navigationOutOfScope: 'NAVIGATION_OUT_OF_SCOPE',
    planNotFound: 'PLAN_NOT_FOUND',
    planVersionMismatch: 'PLAN_VERSION_MISMATCH',
    policyBlocked: 'POLICY_BLOCKED',
    postconditionFailed: 'POSTCONDITION_FAILED',
    preconditionFailed: 'PRECONDITION_FAILED',
    targetAmbiguous: 'TARGET_AMBIGUOUS',
    targetNotFound: 'TARGET_NOT_FOUND',
    targetNotInteractable: 'TARGET_NOT_INTERACTABLE',
    timeout: 'TIMEOUT',
    transportDisconnected: 'TRANSPORT_DISCONNECTED',
  });

  const messageFor = (error, fallback = 'The extension request failed') => {
    if (typeof error?.message === 'string' && error.message) {
      return error.message;
    }
    if (typeof error === 'string' && error) {
      return error;
    }
    return fallback;
  };

  const responseFor = (error, fallback) => ({
    ok: false,
    error: messageFor(error, fallback),
  });

  const legacyResponseFor = (error) => ({
    ok: false,
    error: error.message,
  });

  const createPublicError = (
    code,
    message,
    { stepId = null, retryable = false, observed = {} } = {},
  ) => ({
    code,
    message,
    stepId,
    retryable,
    observed,
  });

  const cancellationError = () => new DOMException(
    'The WebMCP execution was cancelled',
    'AbortError',
  );

  return {
    PUBLIC_ERROR_CODES,
    cancellationError,
    createPublicError,
    legacyResponseFor,
    messageFor,
    responseFor,
  };
}));
