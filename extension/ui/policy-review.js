(function initializePolicyReview(root, factory) {
  const policyReview = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = policyReview;
  }

  root.WebMcpPolicyReview = policyReview;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const OWNED_DEMO_ORIGIN = 'http://127.0.0.1:4317';
  const BINDING_FIELDS = Object.freeze([
    ['listDigest', 'Action-list digest'],
    ['stepId', 'Step'],
    ['origin', 'Origin'],
    ['documentId', 'Document'],
    ['policyRevision', 'Policy revision'],
  ]);

  const asArray = (value) => (Array.isArray(value) ? value : []);

  const createElement = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  const normalizedOrigin = (value) => {
    try {
      return new URL(value).origin;
    } catch (error) {
      return null;
    }
  };

  const explicitOrigin = (value) => {
    const origin = normalizedOrigin(value);
    return origin && origin === value ? origin : null;
  };

  const isOwnedDemoOrigin = (value) => normalizedOrigin(value) === OWNED_DEMO_ORIGIN;

  const timestamp = (value) => {
    if (!value) return 'Not set';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Invalid time';
    return date.toISOString().replace('.000Z', 'Z');
  };

  const policyScopes = (policy = {}) => {
    const currentPolicy = policy || {};
    return asArray(currentPolicy.scopes || currentPolicy.scope);
  };

  const evaluatePolicy = ({ policy, context = {}, now = new Date() } = {}) => {
    const requestedScope = context.requestedScope || 'learn';
    const origin = normalizedOrigin(context.origin);
    const status = policy?.decision || policy?.status || 'unknown';
    const scopes = policyScopes(policy);
    const expiresAt = policy?.expiresAt || null;
    const expiresTime = expiresAt ? new Date(expiresAt).getTime() : null;
    const nowTime = new Date(now).getTime();
    const policyOrigin = explicitOrigin(policy?.origin);
    const policyRevision = policy?.revision || policy?.policyRevision || null;
    const contextPolicyRevision = context.policyRevision || null;

    const base = {
      checkedAt: policy?.checkedAt || null,
      expiresAt,
      origin: origin || context.origin || 'Unknown origin',
      reason: policy?.reason || policy?.reasonCode || policy?.note || 'No policy decision exists.',
      requestedScope,
      scopes,
      source: policy?.source || policy?.basis || 'unreviewed',
    };

    if (!policy || status === 'unknown') {
      return { ...base, state: 'unknown', eligible: false };
    }
    if (status === 'denied' || status === 'blocked') {
      return { ...base, state: 'blocked', eligible: false };
    }
    if (status !== 'allowed') {
      return {
        ...base,
        state: 'unknown',
        eligible: false,
        reason: `Unsupported policy state: ${status}`,
      };
    }
    if (expiresAt && Number.isNaN(expiresTime)) {
      return {
        ...base,
        state: 'unknown',
        eligible: false,
        reason: 'The policy expiry time is invalid and must be reviewed again.',
      };
    }
    if (!origin) {
      return {
        ...base,
        state: 'blocked',
        eligible: false,
        reason: 'The active origin is missing or invalid.',
      };
    }
    if (!policyOrigin) {
      return {
        ...base,
        state: 'blocked',
        eligible: false,
        reason: 'The policy decision does not name a valid explicit origin.',
      };
    }
    if (policyOrigin !== origin) {
      return {
        ...base,
        state: 'blocked',
        eligible: false,
        reason: 'The policy decision does not match the active origin.',
      };
    }
    if (
      policyRevision
      && contextPolicyRevision
      && policyRevision !== contextPolicyRevision
    ) {
      return {
        ...base,
        state: 'blocked',
        eligible: false,
        reason: 'The policy revision does not match the active policy revision.',
      };
    }
    if (!Number.isNaN(expiresTime) && expiresTime !== null && expiresTime <= nowTime) {
      return {
        ...base,
        state: 'expired',
        eligible: false,
        reason: 'The policy decision has expired and must be reviewed again.',
      };
    }
    if (!scopes.includes(requestedScope)) {
      return {
        ...base,
        state: 'blocked',
        eligible: false,
        reason: `The policy does not grant the requested ${requestedScope} scope.`,
      };
    }
    return { ...base, state: 'allowed', eligible: true };
  };

  const observationEligibility = ({ policy, origin, policyRevision, now } = {}) => {
    const decision = evaluatePolicy({
      policy,
      context: { origin, policyRevision, requestedScope: 'learn' },
      now,
    });
    return Object.freeze({
      eligible: decision.eligible,
      origin: decision.origin,
      policyRevision: policyRevision || policy?.revision || null,
      reason: decision.reason,
      state: decision.state,
    });
  };

  const confirmationBinding = (confirmation = {}) => ({
    listDigest: confirmation.listDigest || confirmation.binding?.listDigest || null,
    stepId: confirmation.stepId || confirmation.binding?.stepId || null,
    origin: normalizedOrigin(confirmation.origin || confirmation.binding?.origin),
    documentId: confirmation.documentId || confirmation.binding?.documentId || null,
    policyRevision: confirmation.policyRevision || confirmation.binding?.policyRevision || null,
  });

  const staleConfirmationReasons = (confirmation, context = {}) => {
    if (!confirmation) return ['No confirmation request is pending.'];
    const expected = confirmationBinding(confirmation);
    const current = confirmationBinding(context);
    return BINDING_FIELDS.reduce((reasons, [field, label]) => {
      if (!expected[field] || !current[field]) {
        return [...reasons, `${label} binding is missing.`];
      }
      if (expected[field] !== current[field]) {
        return [...reasons, `${label} changed.`];
      }
      return reasons;
    }, []);
  };

  const maskedValue = (value) => {
    if (Array.isArray(value)) return '[masked]';
    if (value && typeof value === 'object') return '{masked}';
    return '••••••••';
  };

  const maskArguments = (argumentsValue = {}, sensitiveArguments = []) => Object.entries(
    argumentsValue,
  ).reduce((masked, [name, value]) => ({
    ...masked,
    [name]: sensitiveArguments.includes(name) ? maskedValue(value) : value,
  }), {});

  const locatorLabel = (target = {}) => {
    const strategies = asArray(target.strategies);
    const strategy = strategies.find(({ kind }) => kind === 'role') || strategies[0];
    if (!strategy) return 'the current page';
    if (strategy.kind === 'role') {
      return strategy.name ? `“${strategy.name}”` : `the ${strategy.role}`;
    }
    if (strategy.kind === 'css') return `element ${strategy.selector}`;
    if (strategy.kind === 'text') return `text “${strategy.text}”`;
    return strategy.kind || 'the target';
  };

  const conditionLabel = (expect = {}) => {
    const checks = asArray(expect.checks);
    const labels = checks.map((check) => {
      if (check.kind === 'state') return `state ${check.stateId}`;
      if (check.kind === 'url') return 'the expected URL';
      if (check.kind === 'dom_stable') return 'the page to settle';
      if (check.kind === 'target_value') return 'the entered value';
      return check.kind;
    }).filter(Boolean);
    return labels.join(' and ') || 'the declared postcondition';
  };

  const readableStep = (step = {}, index = 0) => {
    const ordinal = `Step ${index + 1}`;
    if (step.op === 'fill') {
      const value = step.value?.fromArgument
        ? `the ${step.value.fromArgument} argument`
        : 'the reviewed literal value';
      return `${ordinal}: Fill ${locatorLabel(step.target)} with ${value}`;
    }
    if (step.op === 'click') return `${ordinal}: Click ${locatorLabel(step.target)}`;
    if (step.op === 'press') return `${ordinal}: Press ${step.key} on ${locatorLabel(step.target)}`;
    if (step.op === 'wait') return `${ordinal}: Wait for ${conditionLabel(step.expect)}`;
    if (step.op === 'extract') return `${ordinal}: Extract the declared result fields`;
    return `${ordinal}: ${step.op || 'Unknown operation'}`;
  };

  const evidenceReferences = (action = {}) => {
    const references = [];
    asArray(action.provenance?.traceIds).forEach((traceId) => {
      references.push({ id: traceId, label: `Trace ${traceId}` });
    });
    asArray(action.steps).forEach((step) => {
      asArray(step.evidence).forEach((evidence) => {
        const id = evidence.transitionId || evidence.traceId;
        if (!id) return;
        references.push({
          id,
          label: evidence.transitionId
            ? `${evidence.transitionId}: ${evidence.fromPageId} → ${evidence.toPageId}`
            : `Trace ${evidence.traceId}`,
        });
      });
    });
    return references.filter((reference, index) => (
      references.findIndex(({ id }) => id === reference.id) === index
    ));
  };

  const appendDefinition = (list, term, value, className = '') => {
    const wrapper = createElement('div', `trust-detail ${className}`.trim());
    wrapper.append(
      createElement('dt', '', term),
      createElement('dd', '', value === null || value === undefined ? 'Not available' : value),
    );
    list.append(wrapper);
  };

  const badge = (text, state) => createElement('span', `trust-badge trust-${state}`, text);

  const sectionHeading = (eyebrow, title, status) => {
    const heading = createElement('div', 'trust-heading');
    const copy = createElement('div');
    copy.append(createElement('p', 'eyebrow', eyebrow), createElement('h2', '', title));
    heading.append(copy, status);
    return heading;
  };

  const renderPolicy = ({ state, coordinator, refresh, now }) => {
    const context = state.context || {};
    const decision = evaluatePolicy({ policy: state.policy, context, now: now() });
    const section = createElement('section', `trust-section policy-${decision.state}`);
    section.setAttribute('aria-label', 'Origin policy');
    section.append(sectionHeading('Origin eligibility', decision.origin, badge(
      decision.state,
      decision.state,
    )));

    const details = createElement('dl', 'trust-details');
    appendDefinition(details, 'Source', decision.source);
    appendDefinition(details, 'Requested', decision.requestedScope);
    appendDefinition(details, 'Granted', decision.scopes.join(', ') || 'None');
    appendDefinition(details, 'Checked', timestamp(decision.checkedAt));
    appendDefinition(details, 'Expires', timestamp(decision.expiresAt));
    appendDefinition(details, 'Reason', decision.reason, 'trust-detail-wide');
    section.append(details);

    const audit = state.overrideAudit;
    if (audit) {
      const auditRow = createElement('div', 'override-audit');
      auditRow.append(
        createElement('strong', '', audit.enabled ? 'Local override active' : 'Local override disabled'),
        createElement('span', 'mono', `${timestamp(audit.changedAt)} · ${audit.actor || 'local user'}`),
        createElement('p', '', audit.reason || audit.reasonCode || 'Owned-demo override decision'),
      );
      section.append(auditRow);
    }

    if (isOwnedDemoOrigin(context.origin) && coordinator?.setOwnedDemoOverride) {
      if (audit?.enabled) {
        const disable = createElement('button', 'button button-quiet trust-action', 'Disable local override');
        disable.type = 'button';
        disable.addEventListener('click', () => {
          disable.disabled = true;
          void coordinator.setOwnedDemoOverride({
            enabled: false,
            origin: OWNED_DEMO_ORIGIN,
            reasonCode: 'OWNED_DEMO_OVERRIDE_DISABLED',
            requestedScope: context.requestedScope || 'learn',
          }).then(refresh).catch(() => refresh());
        });
        section.append(disable);
      } else {
        const acknowledgement = createElement('label', 'override-acknowledgement');
        const checkbox = createElement('input');
        checkbox.type = 'checkbox';
        const label = createElement('span', '', 'I own this local demo and want to allow this scope.');
        acknowledgement.append(checkbox, label);

        const enable = createElement('button', 'button trust-action', 'Enable audited demo override');
        enable.type = 'button';
        enable.disabled = true;
        checkbox.addEventListener('change', () => { enable.disabled = !checkbox.checked; });
        enable.addEventListener('click', () => {
          if (!checkbox.checked) return;
          enable.disabled = true;
          void coordinator.setOwnedDemoOverride({
            acknowledgedAt: now().toISOString(),
            enabled: true,
            origin: OWNED_DEMO_ORIGIN,
            reasonCode: 'OWNED_DEMO_EXPLICIT_OVERRIDE',
            requestedScope: context.requestedScope || 'learn',
          }).then(refresh).catch(() => refresh());
        });
        section.append(acknowledgement, enable);
      }
    }
    return section;
  };

  const replayState = (candidate) => (
    candidate.replayStatus
    || candidate.replay?.status
    || candidate.replayReport?.status
    || 'not_run'
  );

  const renderCandidate = ({ state, registry, refresh, now }) => {
    if (!state.candidate) return null;
    const { candidate } = state;
    const decision = evaluatePolicy({ policy: state.policy, context: state.context, now: now() });
    const replay = replayState(candidate);
    const section = createElement('section', 'trust-section candidate-review');
    section.setAttribute('aria-label', 'Candidate review');
    section.append(sectionHeading(
      'Publication review',
      candidate.title || candidate.listId || 'Candidate action list',
      badge(replay.replaceAll('_', ' '), replay === 'passed' ? 'allowed' : 'unknown'),
    ));

    const binding = createElement('dl', 'trust-details');
    appendDefinition(binding, 'Revision', candidate.revision);
    appendDefinition(binding, 'Digest', candidate.contentDigest, 'trust-detail-wide mono');
    appendDefinition(binding, 'Replay', replay);
    appendDefinition(binding, 'Report', candidate.replayReportId || candidate.replay?.reportId);
    section.append(binding);

    const actions = createElement('div', 'review-actions');
    asArray(candidate.actions).forEach((action) => {
      const article = createElement('article', 'review-action');
      const heading = createElement('div', 'action-heading');
      heading.append(
        createElement('h3', '', action.tool?.title || action.title || action.id || 'Untitled action'),
        badge(action.safety?.class || action.safety || 'unknown', action.safety?.class || 'unknown'),
      );
      article.append(heading);
      article.append(createElement('p', 'action-description', action.tool?.description || action.description || ''));

      const steps = createElement('ol', 'review-steps');
      asArray(action.steps).forEach((step, index) => {
        const item = createElement('li');
        item.append(
          createElement('strong', '', readableStep(step, index)),
          createElement('span', 'mono', `${step.id || `step_${index + 1}`} · verify ${conditionLabel(step.expect)}`),
        );
        steps.append(item);
      });
      article.append(steps);

      const evidence = createElement('div', 'evidence-links');
      evidence.append(createElement('span', 'evidence-label', 'Evidence'));
      evidenceReferences(action).forEach((reference) => {
        const link = createElement('button', 'evidence-link mono', reference.label);
        link.type = 'button';
        link.dataset.evidenceId = reference.id;
        link.addEventListener('click', () => {
          if (registry?.openEvidence) void registry.openEvidence(reference);
        });
        evidence.append(link);
      });
      if (evidence.childElementCount === 1) {
        evidence.append(createElement('span', 'evidence-empty', 'No linked evidence'));
      }
      article.append(evidence);
      actions.append(article);
    });
    section.append(actions);

    if (registry?.submitCandidateDecision) {
      const controls = createElement('div', 'decision-controls');
      const deny = createElement('button', 'button button-stop', 'Reject candidate');
      const approve = createElement('button', 'button button-verified', 'Approve candidate');
      deny.type = 'button';
      approve.type = 'button';
      approve.disabled = !decision.eligible || replay !== 'passed' || !candidate.contentDigest;
      const submit = (approved, button) => {
        button.disabled = true;
        void registry.submitCandidateDecision({
          approved,
          contentDigest: candidate.contentDigest || null,
          listId: candidate.listId,
          revision: candidate.revision,
        }).then(refresh).catch(() => refresh());
      };
      deny.addEventListener('click', () => submit(false, deny));
      approve.addEventListener('click', () => submit(true, approve));
      controls.append(deny, approve);
      section.append(controls);
    }
    return section;
  };

  const renderArguments = (confirmation) => {
    const section = createElement('div', 'argument-preview');
    const sensitive = asArray(confirmation.sensitiveArguments);
    const preview = maskArguments(confirmation.arguments || confirmation.argumentPreview, sensitive);
    Object.entries(preview).forEach(([name, value]) => {
      const row = createElement('div', 'argument-row');
      row.append(
        createElement('span', 'mono', name),
        createElement('code', sensitive.includes(name) ? 'masked' : '', JSON.stringify(value)),
      );
      section.append(row);
    });
    if (section.childElementCount === 0) {
      section.append(createElement('p', '', 'No arguments supplied.'));
    }
    return section;
  };

  const renderConfirmation = ({ state, coordinator, refresh, now }) => {
    if (!state.confirmation) return null;
    const { confirmation } = state;
    const staleReasons = staleConfirmationReasons(confirmation, state.context);
    const stale = staleReasons.length > 0;
    const policyDecision = evaluatePolicy({
      policy: state.policy,
      context: state.context,
      now: now(),
    });
    const binding = confirmationBinding(confirmation);
    const section = createElement('section', `trust-section confirmation ${stale ? 'is-stale' : ''}`);
    section.setAttribute('aria-label', 'Run confirmation');
    section.append(sectionHeading(
      stale ? 'Stale confirmation' : 'Exact confirmation',
      confirmation.actionTitle || confirmation.summary || 'Consequential action',
      badge(stale ? 'stale' : 'waiting', stale ? 'blocked' : 'unknown'),
    ));
    section.append(createElement('p', 'confirmation-summary', confirmation.summary || ''));

    const details = createElement('dl', 'trust-details confirmation-binding');
    appendDefinition(details, 'Run', confirmation.runId, 'mono');
    appendDefinition(details, 'Step', binding.stepId, 'mono');
    appendDefinition(details, 'Origin', binding.origin, 'trust-detail-wide mono');
    appendDefinition(details, 'Digest', binding.listDigest, 'trust-detail-wide mono');
    appendDefinition(details, 'Document', binding.documentId, 'mono');
    appendDefinition(details, 'Policy rev', binding.policyRevision, 'mono');
    section.append(details, renderArguments(confirmation));

    if (confirmation.step) {
      section.append(createElement('p', 'confirmation-step', readableStep(
        confirmation.step,
        confirmation.stepIndex || 0,
      )));
    }
    if (stale) {
      const warning = createElement('ul', 'stale-reasons');
      staleReasons.forEach((reason) => warning.append(createElement('li', '', reason)));
      section.append(warning);
    }
    if (!policyDecision.eligible) {
      section.append(createElement(
        'p',
        'policy-blocked-note',
        `Approval is blocked by ${policyDecision.state} policy: ${policyDecision.reason}`,
      ));
    }

    if (coordinator?.submitConfirmation) {
      const controls = createElement('div', 'decision-controls');
      const deny = createElement('button', 'button button-stop', 'Deny run');
      const approve = createElement('button', 'button button-verified', 'Approve exact step');
      deny.type = 'button';
      approve.type = 'button';
      approve.disabled = stale || !policyDecision.eligible;
      const submit = (approved, button) => {
        button.disabled = true;
        void coordinator.submitConfirmation({
          approved,
          binding,
          runId: confirmation.runId,
          stepId: binding.stepId,
        }).then(refresh).catch(() => refresh());
      };
      deny.addEventListener('click', () => submit(false, deny));
      approve.addEventListener('click', () => submit(true, approve));
      controls.append(deny, approve);
      section.append(controls);
    }
    return section;
  };

  const renderUnavailable = (rootElement, error) => {
    const section = createElement('section', 'trust-section policy-unknown');
    section.append(sectionHeading(
      'Origin eligibility',
      'Policy unavailable',
      badge('unknown', 'unknown'),
    ));
    section.append(createElement(
      'p',
      'trust-unavailable',
      error?.message || 'The coordinator has not supplied a current policy decision.',
    ));
    rootElement.replaceChildren(section);
  };

  const createController = ({
    rootElement,
    coordinator,
    registry,
    now = () => new Date(),
  }) => {
    if (!rootElement) throw new Error('A policy review root element is required');
    let currentState = null;

    const render = (nextState = currentState) => {
      currentState = nextState || {};
      const parts = [renderPolicy({ state: currentState, coordinator, refresh, now })];
      const candidate = renderCandidate({ state: currentState, registry, refresh, now });
      const confirmation = renderConfirmation({ state: currentState, coordinator, refresh, now });
      if (candidate) parts.push(candidate);
      if (confirmation) parts.push(confirmation);
      rootElement.replaceChildren(...parts);
    };

    async function refresh() {
      try {
        const nextState = await coordinator.getPolicyReviewState();
        render(nextState);
      } catch (error) {
        currentState = null;
        renderUnavailable(rootElement, error);
      }
    }

    return {
      currentState: () => currentState,
      refresh,
      render,
    };
  };

  return Object.freeze({
    OWNED_DEMO_ORIGIN,
    confirmationBinding,
    createController,
    evaluatePolicy,
    evidenceReferences,
    isOwnedDemoOrigin,
    maskArguments,
    observationEligibility,
    readableStep,
    staleConfirmationReasons,
  });
}));
