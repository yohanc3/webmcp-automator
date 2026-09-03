'use strict';

const elements = {
  backendDot: document.querySelector('#backend-dot'),
  backendLabel: document.querySelector('#backend-label'),
  demoButton: document.querySelector('#demo-button'),
  modelDot: document.querySelector('#model-dot'),
  modelLabel: document.querySelector('#model-label'),
  notice: document.querySelector('#notice'),
};

const sendMessage = (message) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage(message, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      reject(new Error(error.message));
      return;
    }
    if (!response?.ok) {
      reject(new Error(response?.error || 'Extension request failed'));
      return;
    }
    resolve(response);
  });
});

const showNotice = (message = '', kind = '') => {
  elements.notice.textContent = message;
  elements.notice.className = `notice ${kind}`.trim();
};

const refreshHealth = async () => {
  try {
    const response = await sendMessage({ type: 'GET_BACKEND_HEALTH' });
    elements.backendDot.className = 'status-dot good';
    elements.backendLabel.textContent = 'Ready';
    const configured = response.health.apiKeyConfigured === true;
    elements.modelDot.className = `status-dot ${configured ? 'good' : 'bad'}`;
    elements.modelLabel.textContent = configured ? 'Ready' : 'Needs key';
  } catch (error) {
    elements.backendDot.className = 'status-dot bad';
    elements.backendLabel.textContent = 'Offline';
    elements.modelDot.className = 'status-dot bad';
    elements.modelLabel.textContent = 'Unavailable';
  }
};

const policyReview = WebMcpPolicyReview.createController({
  rootElement: document.querySelector('#policy-review'),
  onError: (error) => showNotice(error.message, 'error'),
  coordinator: {
    getPolicyReviewState: async () => {
      const response = await sendMessage({ type: 'GET_POLICY_REVIEW_STATE' });
      return response.state;
    },
    setOwnedDemoOverride: (override) => sendMessage({
      type: 'SET_OWNED_DEMO_OVERRIDE',
      override,
    }),
    submitPolicyDecision: (decision) => sendMessage({
      type: 'SUBMIT_POLICY_DECISION',
      decision,
    }),
    submitCandidateReview: (decision) => sendMessage({
      type: 'SUBMIT_CANDIDATE_REVIEW',
      decision,
    }),
    submitRunConfirmation: (decision) => sendMessage({
      type: 'SUBMIT_RUN_CONFIRMATION',
      decision,
    }),
  },
  registry: {
    openEvidence: (reference) => sendMessage({
      type: 'OPEN_CANDIDATE_EVIDENCE',
      reference,
    }),
  },
  retrySpool: {
    requestDeletion: (request) => sendMessage({
      type: 'REQUEST_RETRY_SPOOL_DELETION',
      request,
    }),
  },
});

elements.demoButton.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'http://127.0.0.1:4317/demo/' });
});

void Promise.all([refreshHealth(), policyReview.refresh()]).catch((error) => {
  showNotice(error.message, 'error');
});
