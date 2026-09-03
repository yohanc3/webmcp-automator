'use strict';

const elements = {
  actionList: document.querySelector('#action-list'),
  actionTotal: document.querySelector('#action-total'),
  backendDot: document.querySelector('#backend-dot'),
  backendLabel: document.querySelector('#backend-label'),
  clearButton: document.querySelector('#clear-button'),
  copyButton: document.querySelector('#copy-button'),
  demoButton: document.querySelector('#demo-button'),
  discoveryPanel: document.querySelector('#discovery-panel'),
  eventCount: document.querySelector('#event-count'),
  eventTape: document.querySelector('#event-tape'),
  idlePanel: document.querySelector('#idle-panel'),
  learnButton: document.querySelector('#learn-button'),
  mapOrigin: document.querySelector('#map-origin'),
  mapSummary: document.querySelector('#map-summary'),
  mapWarnings: document.querySelector('#map-warnings'),
  modeBadge: document.querySelector('#mode-badge'),
  modelDot: document.querySelector('#model-dot'),
  modelLabel: document.querySelector('#model-label'),
  newButton: document.querySelector('#new-button'),
  notice: document.querySelector('#notice'),
  observedCount: document.querySelector('#observed-count'),
  privacySummary: document.querySelector('#privacy-summary'),
  readyPanel: document.querySelector('#ready-panel'),
  recordingPanel: document.querySelector('#recording-panel'),
  recordingUrl: document.querySelector('#recording-url'),
  resolvableCount: document.querySelector('#resolvable-count'),
  startButton: document.querySelector('#start-button'),
  stateCount: document.querySelector('#state-count'),
  stateRail: document.querySelector('#state-rail'),
  stopButton: document.querySelector('#stop-button'),
  unresolvedCount: document.querySelector('#unresolved-count'),
};

let currentState = null;

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

const activeTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

const showNotice = (message = '', kind = '') => {
  elements.notice.textContent = message;
  elements.notice.className = `notice ${kind}`.trim();
};

const setBusy = (button, busy, label) => {
  button.disabled = busy;
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.textContent = busy ? label : button.dataset.label;
};

const createElement = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const showPanel = (name) => {
  elements.idlePanel.hidden = name !== 'idle';
  elements.recordingPanel.hidden = name !== 'recording';
  elements.readyPanel.hidden = name !== 'ready';
  elements.discoveryPanel.hidden = name !== 'discovery';
  elements.modeBadge.textContent = name;
};

const renderTape = (recording) => {
  elements.eventTape.replaceChildren();
  recording?.events.forEach((event) => {
    const row = document.createElement('li');
    const kind = createElement('span', 'event-kind', event.kind);
    const target = createElement('span', 'truncate', event.target);
    const delta = createElement(
      'span',
      'event-delta',
      event.urlChanged ? 'NAV' : `+${event.addedCount}/−${event.removedCount}`,
    );
    row.append(kind, target, delta);
    elements.eventTape.append(row);
  });
};

const locatorSummary = (locator = {}) => {
  const keys = ['css', 'role', 'name', 'placeholder', 'text', 'hrefContains'];
  const evidence = keys
    .filter((key) => typeof locator[key] === 'string' && locator[key].trim())
    .map((key) => `${key}=${locator[key]}`);
  return evidence.join(' · ') || 'page';
};

const stepSummary = (step) => {
  const parts = [step.op.toUpperCase(), locatorSummary(step.target)];
  if (step.valueFrom) parts.push(`← $${step.valueFrom}`);
  if (step.literalValue) parts.push(`← ${step.literalValue}`);
  if (step.key) parts.push(step.key);
  if (step.expect?.kind && step.expect.kind !== 'none') {
    parts.push(`expect ${step.expect.kind}`);
  }
  return parts.join('  ');
};

const appendEvidence = (card, label, items, className = '') => {
  if (!items?.length) return;
  const block = createElement('div', `evidence-block ${className}`.trim());
  block.append(createElement('span', 'evidence-label', label));
  block.append(createElement('p', '', items.join(' · ')));
  card.append(block);
};

const actionCard = (action) => {
  const card = createElement('article', `action-card action-${action.status}`);
  const heading = createElement('div', 'action-heading');
  const title = createElement('h3', '', action.name);
  const status = createElement('span', 'action-status mono', action.status);
  heading.append(title, status);

  const destination = action.toState || 'unknown';
  const route = createElement('p', 'action-route mono', `${action.fromState} → ${destination}`);
  const confidence = Math.round(action.confidence * 100);
  route.append(` · ${confidence}% · ${action.safety}`);

  card.append(heading, route, createElement('p', 'action-description', action.description));

  if (action.parameters?.length) {
    const parameters = action.parameters.map((parameter) => `$${parameter.name}`).join(' · ');
    card.append(createElement('p', 'action-parameters mono', `inputs  ${parameters}`));
  }

  if (action.steps?.length) {
    const steps = createElement('ol', 'step-tape');
    action.steps.forEach((step) => {
      steps.append(createElement('li', 'mono', stepSummary(step)));
    });
    card.append(steps);
  } else {
    card.append(createElement('p', 'unresolved-note', 'No deterministic path yet.'));
  }

  appendEvidence(card, 'Evidence', action.evidence);
  appendEvidence(card, 'Needs', action.missingEvidence, 'evidence-missing');
  return card;
};

const renderDiscovery = (discovery) => {
  const actionMap = discovery.actionMap;
  const counts = actionMap.actions.reduce((totals, action) => ({
    ...totals,
    [action.status]: (totals[action.status] || 0) + 1,
  }), {});

  elements.mapOrigin.textContent = actionMap.site.origin;
  elements.mapSummary.textContent = actionMap.summary;
  elements.actionTotal.textContent = `${actionMap.actions.length} actions`;
  elements.stateCount.textContent = actionMap.states.length;
  elements.observedCount.textContent = counts.observed || 0;
  elements.resolvableCount.textContent = counts.resolvable || 0;
  elements.unresolvedCount.textContent = counts.unresolved || 0;

  elements.stateRail.replaceChildren();
  actionMap.states.forEach((state) => {
    const item = createElement('li');
    item.append(
      createElement('span', 'state-id mono', state.id),
      createElement('span', 'state-label', state.label),
    );
    elements.stateRail.append(item);
  });

  elements.actionList.replaceChildren(...actionMap.actions.map(actionCard));
  elements.mapWarnings.hidden = actionMap.warnings.length === 0;
  elements.mapWarnings.textContent = actionMap.warnings.join(' · ');

  const privacy = actionMap.privacy;
  const categories = privacy.categories.length ? ` (${privacy.categories.join(', ')})` : '';
  elements.privacySummary.textContent = `${privacy.redactionsApplied} privacy redactions${categories}`;
};

const render = (state) => {
  currentState = state;
  const { recording, discovery } = state;
  if (discovery?.actionMap) {
    showPanel('discovery');
    renderDiscovery(discovery);
  } else if (recording?.status === 'recording') {
    showPanel('recording');
    elements.recordingUrl.textContent = recording.currentUrl;
    renderTape(recording);
  } else if (recording?.status === 'ready') {
    showPanel('ready');
    elements.eventCount.textContent = recording.eventCount;
  } else {
    showPanel('idle');
  }
};

const refreshState = async () => {
  const response = await sendMessage({ type: 'GET_POPUP_STATE' });
  render(response);
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
  coordinator: {
    getPolicyReviewState: async () => {
      const response = await sendMessage({ type: 'GET_POLICY_REVIEW_STATE' });
      return response.state;
    },
    setOwnedDemoOverride: (override) => sendMessage({
      type: 'SET_OWNED_DEMO_OVERRIDE',
      override,
    }),
    submitConfirmation: (decision) => sendMessage({
      type: 'SUBMIT_RUN_CONFIRMATION',
      decision,
    }),
  },
  registry: {
    openEvidence: (reference) => sendMessage({
      type: 'OPEN_CANDIDATE_EVIDENCE',
      reference,
    }),
    submitCandidateDecision: (decision) => sendMessage({
      type: 'SUBMIT_CANDIDATE_REVIEW',
      decision,
    }),
  },
});

elements.startButton.addEventListener('click', async () => {
  setBusy(elements.startButton, true, 'Starting…');
  showNotice();
  try {
    const tab = await activeTab();
    if (!/^https?:/.test(tab?.url || '')) {
      throw new Error('Open an HTTP or HTTPS page before recording');
    }
    await sendMessage({ type: 'START_RECORDING', tabId: tab.id });
    await refreshState();
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    setBusy(elements.startButton, false, 'Starting…');
  }
});

elements.stopButton.addEventListener('click', async () => {
  setBusy(elements.stopButton, true, 'Discovering…');
  showNotice('Stripping sensitive values and mapping actions with GPT-OSS 120B.');
  try {
    await sendMessage({ type: 'STOP_RECORDING', learn: true });
    showNotice('Action map discovered from the recorded evidence.', 'success');
    await refreshState();
  } catch (error) {
    showNotice(error.message, 'error');
    await refreshState().catch(() => {});
  } finally {
    setBusy(elements.stopButton, false, 'Discovering…');
  }
});

elements.learnButton.addEventListener('click', async () => {
  setBusy(elements.learnButton, true, 'Discovering…');
  showNotice('Retrying action discovery with the sanitized recording.');
  try {
    await sendMessage({ type: 'DISCOVER' });
    showNotice('Action map discovered from the recorded evidence.', 'success');
    await refreshState();
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    setBusy(elements.learnButton, false, 'Discovering…');
  }
});

const clearRecording = async () => {
  await sendMessage({ type: 'CLEAR_RECORDING' });
  showNotice();
  await refreshState();
};

elements.copyButton.addEventListener('click', async () => {
  const actionMap = currentState?.discovery?.actionMap;
  if (!actionMap) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(actionMap, null, 2));
    showNotice('Action map copied as JSON.', 'success');
  } catch (error) {
    showNotice('Chrome could not copy the action map.', 'error');
  }
});

elements.clearButton.addEventListener('click', () => {
  void clearRecording().catch((error) => showNotice(error.message, 'error'));
});
elements.newButton.addEventListener('click', () => {
  void clearRecording().catch((error) => showNotice(error.message, 'error'));
});
elements.demoButton.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'http://127.0.0.1:4317/demo/' });
});

void Promise.all([refreshState(), refreshHealth(), policyReview.refresh()]).catch((error) => {
  showNotice(error.message, 'error');
});
setInterval(() => {
  if (currentState?.recording?.status === 'recording') {
    void refreshState().catch(() => {});
  }
}, 750);
