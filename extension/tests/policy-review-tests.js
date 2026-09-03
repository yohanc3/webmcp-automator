(() => {
  'use strict';

  const {
    assert: { deepEqual, equal, match },
    test,
  } = ExtensionTest;
  const policyReview = WebMcpPolicyReview;
  const NOW = new Date('2026-09-03T12:00:00Z');
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const MAP_DIGEST = `sha256:${'b'.repeat(64)}`;

  const policy = (overrides = {}) => ({
    decision: 'allowed',
    scopes: ['ambient_learn', 'read', 'write'],
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
    requestedScope: 'ambient_learn',
    actionMapDigest: MAP_DIGEST,
    actionMapRevision: 2,
    listDigest: DIGEST,
    listRevision: 3,
    runId: 'run_1',
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
    status: 'candidate',
    contentDigest: DIGEST,
    actionMapDigest: MAP_DIGEST,
    actionMapRevision: 2,
    replayStatus: 'passed',
    replayReportId: 'replay_3',
    policyDecision: { status: 'allowed', scopes: ['inject', 'read'] },
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

  const actionMap = (overrides = {}) => ({
    scopeId: 'owned_storefront',
    title: 'Owned storefront map',
    revision: 2,
    digest: MAP_DIGEST,
    actions: [
      {
        actionId: 'open_orders',
        title: 'Open orders',
        precondition: 'Account navigation is visible',
        effect: 'Orders page is visible',
        evidenceHandles: ['layer_orders_001:node_orders_link'],
        provenance: 'inferred',
      },
      {
        actionId: 'get_recent_orders',
        title: 'Get recent orders',
        precondition: 'Orders page is visible',
        effect: 'Order summaries are returned',
        evidenceHandles: ['observation_orders_001', 'node_order_list'],
        provenance: 'observed',
      },
      {
        actionId: 'search_products',
        title: 'Search products',
        precondition: 'Catalog search is visible',
        effect: 'Matching product summaries are returned',
        evidenceHandles: ['verification_search_001'],
        provenance: 'verified',
      },
    ],
    ...overrides,
  });

  const root = () => document.body.appendChild(document.createElement('div'));

  const loadText = (path) => {
    const request = new XMLHttpRequest();
    request.open('GET', new URL(path, window.location.href), false);
    request.send();
    equal(request.status === 0 || request.status === 200, true);
    return request.responseText;
  };

  const buttonNamed = (rootElement, name) => Array.from(
    rootElement.querySelectorAll('button'),
  ).find((button) => button.textContent === name);

  test('fails closed across allowed, blocked, unknown, expired, and revoked policy states', () => {
    const evaluate = (policyValue, contextValue = context()) => policyReview.evaluatePolicy({
      policy: policyValue,
      context: contextValue,
      now: NOW,
    });

    equal(evaluate(policy()).state, 'allowed');
    equal(evaluate(policy()).eligible, true);
    equal(evaluate(policy({ decision: 'denied' })).state, 'blocked');
    equal(evaluate(policy({ decision: 'revoked' })).state, 'revoked');
    equal(evaluate(policy({ decision: 'revoked' })).eligible, false);
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
    equal(evaluate(policy({ scopes: undefined, scope: 'ambient_learn' })).state, 'allowed');
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
      [policy({ decision: 'revoked', reasonCode: 'OWNER_REVOKED' }), 'revoked'],
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

  test('routes an explicit site-scope revocation through the coordinator', () => {
    const decisions = [];
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      now: () => NOW,
      coordinator: {
        getPolicyReviewState: async () => ({}),
        submitPolicyDecision: (decision) => {
          decisions.push(decision);
          return Promise.resolve();
        },
      },
      registry: {},
    });
    controller.render({ context: context(), policy: policy() });
    equal(decisions.length, 0);
    buttonNamed(rootElement, 'Revoke ambient learning').click();
    deepEqual(decisions, [{
      decision: 'revoked',
      origin: 'https://shop.example',
      policyRevision: 'policy_7',
      scope: 'ambient_learn',
    }]);
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
      policy: policy({ decision: 'revoked' }),
      now: NOW,
    }).state, 'revoked');
    equal(policyReview.observationEligibility({
      origin: 'https://shop.example',
      policy: null,
      now: NOW,
    }).eligible, false);
  });

  test('marks confirmation stale when any exact binding changes or is absent', () => {
    const fields = [
      'runId',
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
        requestedScope: 'ambient_learn',
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
      requestedScope: 'ambient_learn',
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

  test('renders compact action-map provenance and safe evidence handles only', () => {
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
      actionMap: actionMap({
        privateHistory: 'typed card 4242 and visited /account/orders/123',
      }),
    });

    match(rootElement.textContent, /Owned storefront map/);
    match(rootElement.textContent, /revision 2/);
    match(rootElement.textContent, new RegExp(MAP_DIGEST));
    match(rootElement.textContent, /inferred/);
    match(rootElement.textContent, /observed/);
    match(rootElement.textContent, /verified/);
    match(rootElement.textContent, /layer_orders_001:node_orders_link/);
    equal(rootElement.textContent.includes('typed card 4242'), false);
    equal(rootElement.textContent.includes('/account/orders/123'), false);

    rootElement.querySelector('[data-evidence-id="node_order_list"]').click();
    deepEqual(opened[0], {
      actionMapDigest: MAP_DIGEST,
      id: 'node_order_list',
      kind: 'compact_handle',
      label: 'node_order_list',
    });
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

  test('starts actor replay only for the exact current review binding', async () => {
    let starts = 0;
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: {
        getPolicyReviewState: async () => ({ context: context(), policy: policy(), candidate: candidate() }),
        startCandidateReplay: async () => { starts += 1; },
      },
      registry: {},
    });
    controller.render({
      context: context(), policy: policy(),
      candidate: candidate({ replayReportId: null, replayStatus: 'failed' }),
    });
    const replay = buttonNamed(rootElement, 'Run actor replay');
    equal(replay.disabled, false);
    replay.click();
    replay.click();
    await Promise.resolve();
    await Promise.resolve();
    equal(starts, 1);
    controller.render({
      context: context({ actionMapDigest: `sha256:${'9'.repeat(64)}` }), policy: policy(),
      candidate: candidate({ replayReportId: null, replayStatus: 'failed' }),
    });
    equal(buttonNamed(rootElement, 'Run actor replay').disabled, true);
    rootElement.remove();
  });

  test('renders evidence handles and references as inert text without an authoritative port', () => {
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: { getPolicyReviewState: async () => ({}) },
      registry: {},
    });
    controller.render({
      actionMap: actionMap(),
      candidate: candidate(),
      context: context(),
      policy: policy(),
    });
    match(rootElement.textContent, /node_order_list/);
    match(rootElement.textContent, /transition_1: page_1 → page_2/);
    equal(rootElement.querySelectorAll('.evidence-link').length > 0, true);
    equal(rootElement.querySelectorAll('button.evidence-link').length, 0);
    rootElement.remove();
  });

  test('keeps candidate decisions unavailable without an authoritative coordinator port', () => {
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: { getPolicyReviewState: async () => ({}) },
      registry: {},
    });
    controller.render({ context: context(), policy: policy(), candidate: candidate() });
    equal(buttonNamed(rootElement, 'Approve candidate'), undefined);
    equal(buttonNamed(rootElement, 'Reject candidate'), undefined);
    rootElement.remove();
  });

  test('submits one exact candidate decision and gates approval on every authority binding', () => {
    const decisions = [];
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      now: () => NOW,
      coordinator: {
        getPolicyReviewState: async () => ({}),
        submitCandidateReview: (decision) => {
          decisions.push(decision);
          return Promise.resolve();
        },
      },
      registry: {},
    });
    const reviewedCandidate = candidate({ policyDecisionId: 'policy_3' });
    controller.render({ context: context(), policy: policy(), candidate: reviewedCandidate });
    equal(buttonNamed(rootElement, 'Approve candidate').disabled, false);
    buttonNamed(rootElement, 'Approve candidate').click();
    equal(buttonNamed(rootElement, 'Reject candidate').disabled, true);
    buttonNamed(rootElement, 'Reject candidate').click();
    deepEqual(decisions, [policyReview.candidateDecision({
      candidate: reviewedCandidate,
      decision: 'approve',
      policyDecisionId: 'policy_3',
    })]);

    controller.render({
      context: context({ actionMapRevision: 4 }),
      policy: policy(),
      candidate: reviewedCandidate,
    });
    equal(buttonNamed(rootElement, 'Approve candidate').disabled, true);
    equal(buttonNamed(rootElement, 'Reject candidate').disabled, false);
    buttonNamed(rootElement, 'Reject candidate').click();
    equal(decisions[1].decision, 'reject');
    rootElement.remove();
  });

  test('does not allow candidate decisions without current exact map and list digests', () => {
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: {
        getPolicyReviewState: async () => ({}),
        submitCandidateReview: () => Promise.resolve(),
      },
      registry: {},
    });
    controller.render({
      context: context(),
      policy: null,
      candidate: candidate({
        actionMapDigest: null,
        contentDigest: null,
        replayStatus: 'failed',
      }),
    });
    match(rootElement.textContent, /Action-map digest binding is missing/);
    match(rootElement.textContent, /Action-list digest binding is missing/);
    equal(buttonNamed(rootElement, 'Approve candidate').disabled, true);
    rootElement.remove();
  });

  test('requires current review digests rather than candidate-owned fallbacks', () => {
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: {
        getPolicyReviewState: async () => ({}),
        submitCandidateReview: () => Promise.resolve(),
      },
      registry: {},
    });
    const reviewedCandidate = candidate({ policyDecisionId: 'policy_3' });
    controller.render({
      context: context({ actionMapDigest: null }),
      policy: policy(),
      candidate: reviewedCandidate,
    });
    equal(buttonNamed(rootElement, 'Approve candidate').disabled, true);
    controller.render({
      context: context({ listDigest: null }),
      policy: policy(),
      candidate: reviewedCandidate,
    });
    equal(buttonNamed(rootElement, 'Approve candidate').disabled, true);
    rootElement.remove();
  });

  test('marks candidate review stale when either current digest changes', () => {
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: { getPolicyReviewState: async () => ({}) },
      registry: {},
    });
    controller.render({
      context: context({ actionMapDigest: `sha256:${'c'.repeat(64)}` }),
      policy: policy(),
      candidate: candidate(),
    });
    match(rootElement.textContent, /Action-map digest changed/);

    controller.render({
      context: context({ listDigest: `sha256:${'d'.repeat(64)}` }),
      policy: policy(),
      candidate: candidate(),
    });
    match(rootElement.textContent, /Action-list digest changed/);
    rootElement.remove();
  });

  test('rejects malformed candidate and current review digests', () => {
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: { getPolicyReviewState: async () => ({}) },
      registry: {},
    });
    controller.render({
      context: context({ listDigest: 'sha256:not-a-digest' }),
      policy: policy(),
      candidate: candidate({ actionMapDigest: 'sha256:also-invalid' }),
    });
    match(rootElement.textContent, /Action-map digest binding is invalid/);
    match(rootElement.textContent, /Current action-list digest is invalid/);
    rootElement.remove();
  });

  test('blocks candidate approval for replay failure or absent authority IDs while preserving rejection', () => {
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: {
        getPolicyReviewState: async () => ({}),
        submitCandidateReview: () => Promise.resolve(),
      },
      registry: {},
    });
    controller.render({
      context: context(),
      policy: policy(),
      candidate: candidate({ policyDecisionId: 'policy_3', replayStatus: 'failed' }),
    });
    equal(buttonNamed(rootElement, 'Approve candidate').disabled, true);
    equal(buttonNamed(rootElement, 'Reject candidate').disabled, false);

    controller.render({
      context: context(),
      policy: policy(),
      candidate: candidate({
        policyDecisionId: 'policy_3',
        policyDecision: { status: 'allowed', scopes: ['inject'] },
      }),
    });
    equal(buttonNamed(rootElement, 'Approve candidate').disabled, true);
    match(rootElement.textContent, /every action safety class/);

    controller.render({ context: context(), policy: policy(), candidate: candidate() });
    equal(buttonNamed(rootElement, 'Approve candidate').disabled, true);
    match(rootElement.textContent, /authoritative policy and replay report IDs/);
    rootElement.remove();
  });

  test('renders terminal candidate decisions without active review controls', () => {
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: {
        getPolicyReviewState: async () => ({}),
        submitCandidateReview: () => Promise.resolve(),
      },
      registry: {},
    });
    controller.render({
      context: context(),
      policy: policy(),
      candidate: candidate({ policyDecisionId: 'policy_3', status: 'rejected' }),
    });
    equal(buttonNamed(rootElement, 'Approve candidate').disabled, true);
    equal(buttonNamed(rootElement, 'Reject candidate').disabled, true);
    match(rootElement.textContent, /terminal rejected decision/);
    controller.render({
      context: context(),
      policy: policy(),
      candidate: candidate({ policyDecisionId: 'policy_3', status: null }),
    });
    equal(buttonNamed(rootElement, 'Approve candidate').disabled, true);
    equal(buttonNamed(rootElement, 'Reject candidate').disabled, true);
    match(rootElement.textContent, /no authoritative reviewable status/);
    rootElement.remove();
  });

  test('shows retry-spool count and routes deletion through its authoritative port', () => {
    const requests = [];
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      now: () => NOW,
      coordinator: { getPolicyReviewState: async () => ({}) },
      registry: {},
      retrySpool: {
        requestDeletion: (request) => {
          requests.push(request);
          return Promise.resolve();
        },
      },
    });
    controller.render({
      context: context({ siteScopeId: 'owned_storefront' }),
      policy: policy(),
      retrySpool: {
        count: 3,
        oldestAt: '2026-09-03T10:00:00Z',
        expiresAt: '2026-09-04T10:00:00Z',
        scopeId: 'owned_storefront',
      },
    });
    match(rootElement.textContent, /3 queued/);
    match(rootElement.textContent, /This browser only/);
    equal(requests.length, 0);
    buttonNamed(rootElement, 'Delete local retry data').click();
    deepEqual(requests, [{
      count: 3,
      origin: 'https://shop.example',
      requestedAt: '2026-09-03T12:00:00.000Z',
      scopeId: 'owned_storefront',
    }]);
    rootElement.remove();
  });

  test('shows exact masked confirmation and requires explicit approve or deny', () => {
    const decisions = [];
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: {
        getPolicyReviewState: async () => ({}),
        submitRunConfirmation: (decision) => {
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
    equal(rootElement.querySelectorAll('[aria-label="Run confirmation"]').length, 1);
    equal(rootElement.querySelector('[aria-label="Local retry spool"]'), null);
    buttonNamed(rootElement, 'Approve exact step').click();
    equal(buttonNamed(rootElement, 'Deny run').disabled, true);
    buttonNamed(rootElement, 'Deny run').click();
    equal(decisions.length, 1);
    equal(decisions[0].approved, true);
    deepEqual(decisions[0], {
      approved: true,
      ...policyReview.confirmationBinding(confirmation()),
    });
    rootElement.remove();
  });

  test('blocks stale approval while preserving explicit denial', () => {
    const rootElement = root();
    const controller = policyReview.createController({
      rootElement,
      coordinator: {
        getPolicyReviewState: async () => ({}),
        submitRunConfirmation: () => Promise.resolve(),
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
        submitRunConfirmation: () => Promise.resolve(),
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

  test('popup exposes no goal or ambient recording lifecycle controls', () => {
    const popup = new DOMParser().parseFromString(loadText('../popup.html'), 'text/html');
    const forbidden = Array.from(popup.querySelectorAll('button')).filter((button) => (
      /\b(goal|record|start|stop)\b/i.test(button.textContent)
    ));
    deepEqual(forbidden.map((button) => button.textContent.trim()), []);
    equal(popup.querySelector('#event-tape'), null);
    equal(popup.querySelector('#recording-panel'), null);
  });

  test('popup policy surface has no direct storage or recording lifecycle messages', () => {
    const source = [
      loadText('../popup.js'),
      loadText('../ui/policy-review.js'),
    ].join('\n');
    equal(/chrome\.storage|localStorage|sessionStorage/.test(source), false);
    equal(/START_RECORDING|STOP_RECORDING|CLEAR_RECORDING/.test(source), false);
  });

  test('popup routes review and confirmation through fail-closed ports', () => {
    const source = loadText('../popup.js');
    match(source, /type: 'SUBMIT_CANDIDATE_REVIEW'/);
    match(source, /type: 'OPEN_CANDIDATE_EVIDENCE'/);
    match(source, /type: 'START_CANDIDATE_REPLAY'/);
    match(source, /type: 'SUBMIT_RUN_CONFIRMATION'/);
    match(source, /onError: \(error\) => showNotice\(error\.message, 'error'\)/);
  });
})();
