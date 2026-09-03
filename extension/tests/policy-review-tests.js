(() => {
  'use strict';

  const {
    assert: { deepEqual, equal, match },
    test,
  } = ExtensionTest;
  const policyReview = WebMcpPolicyReview;
  const NOW = new Date('2026-09-03T12:00:00Z');
  const DIGEST = `sha256:${'a'.repeat(64)}`;

  const policy = (overrides = {}) => ({
    decision: 'allowed',
    scopes: ['learn', 'read', 'write'],
    source: 'reviewed_terms',
    reasonCode: 'TERMS_REVIEWED',
    origin: 'https://shop.example',
    revision: 'policy_7',
    checkedAt: '2026-09-03T10:00:00Z',
    expiresAt: '2026-09-04T10:00:00Z',
    ...overrides,
  });

  const context = (overrides = {}) => ({
    origin: 'https://shop.example',
    requestedScope: 'learn',
    listDigest: DIGEST,
    stepId: 'submit_order',
    documentId: 'document_1',
    policyRevision: 'policy_7',
    ...overrides,
  });

  const confirmation = (overrides = {}) => ({
    runId: 'run_1',
    actionTitle: 'Place order',
    summary: 'Submit the reviewed order to the owned demo.',
    arguments: {
      email: 'person@example.test',
      note: 'Leave at the front desk',
    },
    sensitiveArguments: ['email'],
    listDigest: DIGEST,
    stepId: 'submit_order',
    origin: 'https://shop.example',
    documentId: 'document_1',
    policyRevision: 'policy_7',
    stepIndex: 2,
    step: {
      id: 'submit_order',
      op: 'click',
      target: {
        strategies: [{ kind: 'role', role: 'button', name: 'Place order' }],
      },
      expect: { checks: [{ kind: 'state', stateId: 'confirmation' }] },
    },
    ...overrides,
  });

  const candidate = (overrides = {}) => ({
    listId: 'owned_storefront',
    title: 'Owned storefront actions',
    revision: 3,
    contentDigest: DIGEST,
    replayStatus: 'passed',
    replayReportId: 'replay_3',
    actions: [{
      id: 'search_products',
      tool: {
        title: 'Search products',
        description: 'Search the owned catalog.',
      },
      safety: { class: 'read' },
      provenance: { traceIds: ['trace_1'] },
      steps: [{
        id: 'fill_query',
        op: 'fill',
        target: {
          strategies: [{ kind: 'role', role: 'searchbox', name: 'Search the catalog' }],
        },
        value: { fromArgument: 'query' },
        expect: { checks: [{ kind: 'target_value' }] },
        evidence: [{
          traceId: 'trace_1',
          transitionId: 'transition_1',
          fromPageId: 'page_1',
          toPageId: 'page_2',
        }],
      }],
    }],
    ...overrides,
  });

  const root = () => document.body.appendChild(document.createElement('div'));

  const buttonNamed = (rootElement, name) => Array.from(
    rootElement.querySelectorAll('button'),
  ).find((button) => button.textContent === name);

  test('fails closed across allowed, blocked, unknown, and expired policy states', () => {
    const evaluate = (policyValue, contextValue = context()) => policyReview.evaluatePolicy({
      policy: policyValue,
      context: contextValue,
      now: NOW,
    });

    equal(evaluate(policy()).state, 'allowed');
    equal(evaluate(policy()).eligible, true);
    equal(evaluate(policy({ decision: 'denied' })).state, 'blocked');
    equal(evaluate(null).state, 'unknown');
    equal(evaluate(policy({ expiresAt: '2026-09-03T11:59:59Z' })).state, 'expired');
    equal(evaluate(policy({ expiresAt: 'not-a-time' })).state, 'unknown');
    equal(evaluate(policy({ scopes: ['read'] })).state, 'blocked');
    equal(evaluate(policy({ origin: 'https://other.example' })).state, 'blocked');
    equal(evaluate(policy({ origin: null })).state, 'blocked');
    equal(evaluate(policy({ origin: 'not-an-origin' })).state, 'blocked');
    equal(evaluate(policy({ origin: 'https://shop.example/account' })).state, 'blocked');
    equal(evaluate(policy({ revision: 'policy_6' })).state, 'blocked');
    equal(evaluate(policy({ revision: null })).state, 'allowed');
  });

  test('requires an allowed policy to carry its own valid matching origin', () => {
    const missing = policyReview.evaluatePolicy({
      policy: policy({ origin: null }),
      context: context(),
      now: NOW,
    });
    const invalid = policyReview.evaluatePolicy({
      policy: policy({ origin: 'not-an-origin' }),
      context: context(),
      now: NOW,
    });
    const mismatched = policyReview.evaluatePolicy({
      policy: policy({ origin: 'https://other.example' }),
      context: context(),
      now: NOW,
    });
    const pageUrl = policyReview.evaluatePolicy({
      policy: policy({ origin: 'https://shop.example/account' }),
      context: context(),
      now: NOW,
    });

    equal(missing.eligible, false);
    equal(missing.state, 'blocked');
    match(missing.reason, /valid explicit origin/);
    equal(invalid.eligible, false);
    match(invalid.reason, /valid explicit origin/);
    equal(pageUrl.eligible, false);
    match(pageUrl.reason, /valid explicit origin/);
    equal(mismatched.eligible, false);
    match(mismatched.reason, /does not match the active origin/);
  });

  test('fails closed when explicit policy revisions disagree', () => {
    const mismatched = policyReview.evaluatePolicy({
      policy: policy({ revision: 'policy_6' }),
      context: context({ policyRevision: 'policy_7' }),
      now: NOW,
    });
    const matched = policyReview.evaluatePolicy({
      policy: policy({ revision: 'policy_7' }),
      context: context({ policyRevision: 'policy_7' }),
      now: NOW,
    });

    equal(mismatched.eligible, false);
    equal(mismatched.state, 'blocked');
    match(mismatched.reason, /revision does not match/);
    equal(matched.eligible, true);
  });

  test('renders every policy state with source, scope, times, and reason', () => {
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      now: () => NOW,
      coordinator: { getPolicyReviewState: async () => ({}) },
      registry: {},
    });
    const cases = [
      [policy(), 'allowed'],
      [policy({ decision: 'denied', reasonCode: 'SITE_BLOCKED' }), 'blocked'],
      [null, 'unknown'],
      [policy({ expiresAt: '2026-09-03T11:00:00Z' }), 'expired'],
    ];
    cases.forEach(([policyValue, expectedState]) => {
      controller.render({ context: context(), policy: policyValue });
      match(rootElement.querySelector('.trust-badge').textContent, new RegExp(expectedState));
      match(rootElement.textContent, /Source/);
      match(rootElement.textContent, /Requested/);
      match(rootElement.textContent, /Checked/);
      match(rootElement.textContent, /Expires/);
      match(rootElement.textContent, /Reason/);
    });
    rootElement.remove();
  });

  test('exposes deny-by-default automatic observation eligibility', () => {
    deepEqual(policyReview.observationEligibility({
      origin: 'https://shop.example',
      policyRevision: 'policy_7',
      policy: policy(),
      now: NOW,
    }), {
      eligible: true,
      origin: 'https://shop.example',
      policyRevision: 'policy_7',
      reason: 'TERMS_REVIEWED',
      state: 'allowed',
    });
    equal(policyReview.observationEligibility({
      origin: 'https://shop.example',
      policy: policy({ scopes: ['read'] }),
      now: NOW,
    }).eligible, false);
    equal(policyReview.observationEligibility({
      origin: 'https://shop.example',
      policy: null,
      now: NOW,
    }).eligible, false);
  });

  test('marks confirmation stale when any exact binding changes or is absent', () => {
    const fields = [
      'listDigest',
      'stepId',
      'origin',
      'documentId',
      'policyRevision',
    ];
    deepEqual(policyReview.staleConfirmationReasons(confirmation(), context()), []);
    fields.forEach((field) => {
      equal(policyReview.staleConfirmationReasons(
        confirmation(),
        context({ [field]: `${field}_changed` }),
      ).length, 1);
      const missingContext = context();
      delete missingContext[field];
      equal(policyReview.staleConfirmationReasons(confirmation(), missingContext).length, 1);
    });
  });

  test('masks sensitive confirmation arguments without hiding reviewed values', () => {
    deepEqual(policyReview.maskArguments({
      email: 'person@example.test',
      count: 2,
      card: { lastFour: '4242' },
    }, ['email', 'card']), {
      email: '••••••••',
      count: 2,
      card: '{masked}',
    });
  });

  test('offers an explicit audited override only for the owned demo', () => {
    const calls = [];
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      now: () => NOW,
      coordinator: {
        getPolicyReviewState: async () => ({}),
        setOwnedDemoOverride: (request) => {
          calls.push(request);
          return Promise.resolve();
        },
      },
      registry: {},
    });
    controller.render({
      context: context({
        origin: `${policyReview.OWNED_DEMO_ORIGIN}/demo/`,
        requestedScope: 'learn',
      }),
      policy: null,
    });

    const checkbox = rootElement.querySelector('input[type="checkbox"]');
    const enable = buttonNamed(rootElement, 'Enable audited demo override');
    equal(enable.disabled, true);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    equal(enable.disabled, false);
    enable.click();
    equal(calls.length, 1);
    deepEqual(calls[0], {
      acknowledgedAt: '2026-09-03T12:00:00.000Z',
      enabled: true,
      origin: policyReview.OWNED_DEMO_ORIGIN,
      reasonCode: 'OWNED_DEMO_EXPLICIT_OVERRIDE',
      requestedScope: 'learn',
    });

    controller.render({
      context: context({ origin: 'https://shop.example' }),
      policy: null,
    });
    equal(buttonNamed(rootElement, 'Enable audited demo override'), undefined);
    rootElement.remove();
  });

  test('renders auditable override history', () => {
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: { getPolicyReviewState: async () => ({}) },
      registry: {},
    });
    controller.render({
      context: context({ origin: policyReview.OWNED_DEMO_ORIGIN }),
      policy: policy({ source: 'local_override' }),
      overrideAudit: {
        enabled: true,
        actor: 'local user',
        changedAt: '2026-09-03T11:00:00Z',
        reason: 'Owned deterministic fixture',
      },
    });
    match(rootElement.textContent, /Local override active/);
    match(rootElement.textContent, /Owned deterministic fixture/);
    rootElement.remove();
  });

  test('renders candidate titles, executable steps, evidence, safety, and replay status', () => {
    const opened = [];
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: { getPolicyReviewState: async () => ({}) },
      registry: {
        openEvidence: (reference) => { opened.push(reference); },
      },
    });
    controller.render({
      context: context(),
      policy: policy(),
      candidate: candidate(),
    });

    match(rootElement.textContent, /Search products/);
    match(rootElement.textContent, /Step 1: Fill “Search the catalog” with the query argument/);
    match(rootElement.textContent, /transition_1: page_1 → page_2/);
    match(rootElement.textContent, /passed/);
    match(rootElement.textContent, /read/);
    rootElement.querySelector('[data-evidence-id="transition_1"]').click();
    equal(opened[0].id, 'transition_1');
    rootElement.remove();
  });

  test('routes candidate approve and deny through the registry without direct publication', () => {
    const decisions = [];
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: { getPolicyReviewState: async () => ({}) },
      registry: {
        submitCandidateDecision: (decision) => {
          decisions.push(decision);
          return Promise.resolve();
        },
      },
    });
    controller.render({ context: context(), policy: policy(), candidate: candidate() });
    buttonNamed(rootElement, 'Approve candidate').click();
    buttonNamed(rootElement, 'Reject candidate').click();
    equal(decisions.length, 2);
    equal(decisions[0].approved, true);
    equal(decisions[1].approved, false);
    equal(decisions[0].contentDigest, DIGEST);
    rootElement.remove();
  });

  test('does not allow candidate approval without current policy, replay, and digest', () => {
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: { getPolicyReviewState: async () => ({}) },
      registry: { submitCandidateDecision: () => Promise.resolve() },
    });
    controller.render({
      context: context(),
      policy: null,
      candidate: candidate({ contentDigest: null, replayStatus: 'failed' }),
    });
    equal(buttonNamed(rootElement, 'Approve candidate').disabled, true);
    equal(buttonNamed(rootElement, 'Reject candidate').disabled, false);
    rootElement.remove();
  });

  test('shows exact masked confirmation and requires explicit approve or deny', () => {
    const decisions = [];
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: {
        getPolicyReviewState: async () => ({}),
        submitConfirmation: (decision) => {
          decisions.push(decision);
          return Promise.resolve();
        },
      },
      registry: {},
    });
    controller.render({
      context: context(),
      policy: policy(),
      confirmation: confirmation(),
    });

    equal(decisions.length, 0);
    match(rootElement.textContent, /••••••••/);
    equal(rootElement.textContent.includes('person@example.test'), false);
    match(rootElement.textContent, /Leave at the front desk/);
    match(rootElement.textContent, new RegExp(DIGEST));
    buttonNamed(rootElement, 'Approve exact step').click();
    buttonNamed(rootElement, 'Deny run').click();
    equal(decisions.length, 2);
    equal(decisions[0].approved, true);
    equal(decisions[1].approved, false);
    equal(decisions[0].runId, 'run_1');
    equal(decisions[0].stepId, 'submit_order');
    deepEqual(decisions[0].binding, policyReview.confirmationBinding(confirmation()));
    rootElement.remove();
  });

  test('blocks stale approval while preserving explicit denial', () => {
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: {
        getPolicyReviewState: async () => ({}),
        submitConfirmation: () => Promise.resolve(),
      },
      registry: {},
    });
    controller.render({
      context: context({ policyRevision: 'policy_8' }),
      policy: policy(),
      confirmation: confirmation(),
    });
    equal(buttonNamed(rootElement, 'Approve exact step').disabled, true);
    equal(buttonNamed(rootElement, 'Deny run').disabled, false);
    match(rootElement.textContent, /Policy revision changed/);
    rootElement.remove();
  });

  test('blocks fresh confirmation approval when current policy is not eligible', () => {
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      now: () => NOW,
      coordinator: {
        getPolicyReviewState: async () => ({}),
        submitConfirmation: () => Promise.resolve(),
      },
      registry: {},
    });
    controller.render({
      context: context({ requestedScope: 'danger' }),
      policy: policy({ scopes: ['learn', 'read'] }),
      confirmation: confirmation(),
    });
    equal(buttonNamed(rootElement, 'Approve exact step').disabled, true);
    equal(buttonNamed(rootElement, 'Deny run').disabled, false);
    match(rootElement.textContent, /Approval is blocked by blocked policy/);
    rootElement.remove();
  });
})();
