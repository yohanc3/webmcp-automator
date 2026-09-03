(async () => {
  'use strict';

  const tests = [];
  const entryURL = location.href;
  const outcomes = [];
  const sandbox = document.querySelector('#sandbox');
  const origin = window.location.origin;
  const evidence = [{
    traceId: 'trace_test', transitionId: 'transition_1', fromPageId: 'page_1',
    actionFrameSequence: 2, updateFrameSequence: 3, toPageId: 'page_2',
  }];
  const locator = (strategies, options = {}) => ({
    cardinality: 'one', visible: true, enabled: true, strategies, ...options,
  });
  const css = (selector, options) => locator([{ kind: 'css', selector }], options);
  const present = (selector) => ({
    kind: 'element', target: css(selector, { enabled: false }), assertion: 'present',
  });
  const expectation = (...checks) => ({ mode: 'all', checks });
  const inputSchema = {
    type: 'object',
    properties: { query: { type: 'string', description: 'Query', minLength: 1, maxLength: 200 } },
    required: ['query'],
    additionalProperties: false,
  };
  const actionFor = (step, overrides = {}) => ({
    id: 'test_action',
    version: 1,
    tool: { inputSchema: overrides.inputSchema || inputSchema },
    steps: [step],
    output: overrides.output || { mode: 'none' },
    runtime: overrides.runtime || {
      allowedOrigins: [origin], maxDurationMs: 2000, maxNavigations: 2,
    },
  });
  const commandFor = (step, args = { query: 'headphones' }) => ({
    commandId: 'command_1', stepIndex: 0, step, arguments: args,
  });
  const execute = (step, options = {}) => WebMcpActor.executeStep({
    action: options.action || actionFor(step, options),
    command: options.command || commandFor(step, options.arguments),
    arguments: options.arguments,
    document,
    signal: options.signal,
    actionStartedAt: options.actionStartedAt,
    states: options.states || [],
    getStateId: options.getStateId,
  });
  const baseStep = (op, fields = {}) => ({
    id: `${op}_step`, op, expect: expectation(present('#success')), timeoutMs: 160,
    evidence, ...fields,
  });
  const waitStep = (check, timeoutMs = 160) => baseStep('wait', {
    expect: expectation(check), timeoutMs,
  });
  const reset = (html = '<div id="success">ready</div>') => {
    history.replaceState({}, '', '/actor-test');
    sandbox.innerHTML = html;
  };
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const equal = (actual, expected, message = '') => {
    if (actual !== expected) throw new Error(`${message} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const completed = (outcome) => {
    outcomes.push(outcome);
    equal(outcome.type, 'step.completed');
    equal(outcome.payload.effect.postconditionSatisfied, true);
    return outcome.payload;
  };
  const failed = (outcome, code) => {
    outcomes.push(outcome);
    equal(outcome.type, 'step.failed');
    equal(outcome.payload.error.code, code);
    equal(outcome.payload.error.stepId, outcome.payload.stepId);
    assert(typeof outcome.payload.error.observed === 'object', 'observed must be bounded metadata');
    return outcome.payload;
  };
  const test = (name, body) => tests.push({ name, body });

  test('role/name locator wins before CSS fallback', async () => {
    reset('<button aria-label="Preferred">one</button><button id="fallback">two</button><div id="success">ok</div>');
    let preferred = 0;
    let fallback = 0;
    sandbox.querySelector('button').onclick = () => { preferred += 1; };
    sandbox.querySelector('#fallback').onclick = () => { fallback += 1; };
    const step = baseStep('click', { target: locator([
      { kind: 'role', role: 'button', name: 'Preferred', exact: true },
      { kind: 'css', selector: '#fallback' },
    ]) });
    completed(await execute(step));
    equal(preferred, 1);
    equal(fallback, 0);
  });

  test('label locator resolves its associated control', async () => {
    reset('<label for="q">Catalog query</label><input id="q"><div id="success">ok</div>');
    const step = baseStep('fill', {
      target: locator([{ kind: 'label', text: 'Catalog query', exact: true }]),
      value: { fromArgument: 'query' },
      expect: expectation({ kind: 'target_value', value: { fromArgument: 'query' } }),
    });
    completed(await execute(step));
    equal(sandbox.querySelector('#q').value, 'headphones');
  });

  test('stable attribute locator resolves data-testid', async () => {
    reset('<button data-testid="save">Save</button><div id="success">ok</div>');
    let clicked = 0;
    sandbox.querySelector('button').onclick = () => { clicked += 1; };
    const step = baseStep('click', { target: locator([
      { kind: 'attribute', attribute: 'data-testid', value: 'save' },
    ]) });
    completed(await execute(step));
    equal(clicked, 1);
  });

  test('placeholder and href strategies resolve deterministically', async () => {
    reset('<input placeholder="Find items"><a href="/product/42">Details</a><div id="success">ok</div>');
    equal(WebMcpActor.resolveLocator(locator([
      { kind: 'placeholder', text: 'Find items', exact: true },
    ]), { document }).elements[0].localName, 'input');
    equal(WebMcpActor.resolveLocator(locator([
      { kind: 'href', contains: '/product/42' },
    ]), { document }).elements[0].localName, 'a');
  });

  test('missing target fails TARGET_NOT_FOUND', async () => {
    reset();
    const step = baseStep('click', { target: css('#missing') });
    failed(await execute(step), 'TARGET_NOT_FOUND');
  });

  test('ambiguous one target never chooses the first', async () => {
    reset('<button class="duplicate">A</button><button class="duplicate">B</button><div id="success">ok</div>');
    let clicks = 0;
    sandbox.querySelectorAll('button').forEach((button) => { button.onclick = () => { clicks += 1; }; });
    const step = baseStep('click', { target: css('.duplicate') });
    const payload = failed(await execute(step), 'TARGET_AMBIGUOUS');
    equal(payload.error.observed.matchCount, 2);
    equal(clicks, 0);
  });

  test('disabled and hidden targets fail TARGET_NOT_INTERACTABLE', async () => {
    reset('<button id="disabled" disabled>Disabled</button><button id="hidden" hidden>Hidden</button><div id="success">ok</div>');
    failed(await execute(baseStep('click', { target: css('#disabled') })), 'TARGET_NOT_INTERACTABLE');
    failed(await execute(baseStep('click', { target: css('#hidden') })), 'TARGET_NOT_INTERACTABLE');
  });

  test('fill dispatches input/change and verifies target value', async () => {
    reset('<input id="query"><div id="success">ok</div>');
    const events = [];
    sandbox.querySelector('input').addEventListener('input', () => events.push('input'));
    sandbox.querySelector('input').addEventListener('change', () => events.push('change'));
    const step = baseStep('fill', {
      target: css('#query'), value: { fromArgument: 'query' },
      expect: expectation({ kind: 'target_value', value: { fromArgument: 'query' } }),
    });
    completed(await execute(step));
    equal(events.join(','), 'input,change');
  });

  test('fill rejects a non-editable target', async () => {
    reset('<div id="not-editable">no</div><div id="success">ok</div>');
    const step = baseStep('fill', {
      target: css('#not-editable'), value: { literal: 'x' },
    });
    failed(await execute(step), 'TARGET_NOT_INTERACTABLE');
  });

  test('click executes exactly once when postcondition passes', async () => {
    reset('<button id="go">Go</button>');
    let clicks = 0;
    sandbox.querySelector('#go').onclick = () => {
      clicks += 1;
      sandbox.insertAdjacentHTML('beforeend', '<div id="success">done</div>');
    };
    completed(await execute(baseStep('click', { target: css('#go') })));
    equal(clicks, 1);
  });

  test('click with failed postcondition is POSTCONDITION_FAILED and is not retried', async () => {
    reset('<button id="go">Go</button>');
    let clicks = 0;
    sandbox.querySelector('#go').onclick = () => { clicks += 1; };
    const step = baseStep('click', { target: css('#go'), timeoutMs: 100 });
    failed(await execute(step), 'POSTCONDITION_FAILED');
    equal(clicks, 1);
  });

  test('press focuses target and dispatches one key sequence', async () => {
    reset('<input id="query"><div id="success">ok</div>');
    const keys = [];
    sandbox.querySelector('input').addEventListener('keydown', (event) => keys.push(event.key));
    const step = baseStep('press', { target: css('#query'), key: 'Enter' });
    completed(await execute(step));
    equal(keys.join(','), 'Enter');
    equal(document.activeElement.id, 'query');
  });

  test('press missing target fails without dispatching', async () => {
    reset();
    const step = baseStep('press', { target: css('#missing'), key: 'Enter' });
    failed(await execute(step), 'TARGET_NOT_FOUND');
  });

  test('wait succeeds when an element appears', async () => {
    reset('');
    setTimeout(() => sandbox.insertAdjacentHTML('beforeend', '<div id="later">ready</div>'), 30);
    completed(await execute(waitStep(present('#later'), 180)));
  });

  test('readiness condition evaluation waits for delayed DOM evidence', async () => {
    reset('');
    const step = waitStep(present('#ready-later'), 180);
    const action = actionFor(step);
    setTimeout(() => sandbox.insertAdjacentHTML(
      'beforeend',
      '<div id="ready-later">ready</div>',
    ), 30);
    equal(await WebMcpActor.evaluateConditionSet({
      action,
      document,
      set: step.expect,
      states: [],
      step,
      timeoutMs: 180,
    }), true);
  });

  test('wait condition timeout is TIMEOUT', async () => {
    reset();
    failed(await execute(waitStep(present('#never'), 100)), 'TIMEOUT');
  });

  test('URL condition has positive and negative behavior', async () => {
    reset();
    history.replaceState({}, '', '/expected');
    completed(await execute(waitStep({ kind: 'url', pattern: `${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/expected$` })));
    failed(await execute(waitStep({ kind: 'url', pattern: '/wrong$' }, 100)), 'TIMEOUT');
  });

  test('element present/absent assertions have positive and negative behavior', async () => {
    reset('<div id="present">yes</div>');
    completed(await execute(waitStep(present('#present'))));
    completed(await execute(waitStep({ kind: 'element', target: css('#absent'), assertion: 'absent' })));
    failed(await execute(waitStep(present('#absent'), 100)), 'TIMEOUT');
  });

  test('element enabled/disabled and visible/hidden assertions work', async () => {
    reset('<button id="enabled">yes</button><button id="disabled" disabled>no</button><div id="hidden" hidden>hide</div>');
    completed(await execute(waitStep({ kind: 'element', target: css('#enabled'), assertion: 'enabled' })));
    completed(await execute(waitStep({
      kind: 'element', target: css('#disabled', { enabled: false }), assertion: 'disabled',
    })));
    completed(await execute(waitStep({
      kind: 'element', target: css('#hidden', { visible: false, enabled: false }), assertion: 'hidden',
    })));
    failed(await execute(waitStep({
      kind: 'element', target: css('#hidden', { visible: false, enabled: false }), assertion: 'visible',
    }, 100)), 'TIMEOUT');
  });

  test('collection condition enforces minimum item count', async () => {
    reset('<div class="item">1</div><div class="item">2</div>');
    const target = css('.item', { cardinality: 'many', enabled: false });
    completed(await execute(waitStep({ kind: 'collection', target, minimumItems: 2 })));
    failed(await execute(waitStep({ kind: 'collection', target, minimumItems: 3 }, 100)), 'TIMEOUT');
  });

  test('state condition uses frozen list state definitions', async () => {
    reset('<main id="catalog">Catalog</main>');
    const states = [{
      id: 'catalog', label: 'Catalog', description: 'Catalog state',
      match: expectation(present('#catalog')),
    }];
    completed(await execute(waitStep({ kind: 'state', stateId: 'catalog' }), { states }));
    failed(await execute(waitStep({ kind: 'state', stateId: 'other' }, 100), { states }), 'TIMEOUT');
  });

  test('target_value condition has positive and negative behavior', async () => {
    reset('<input id="query"><div id="success">ok</div>');
    const good = baseStep('fill', {
      target: css('#query'), value: { literal: 'correct' },
      expect: expectation({ kind: 'target_value', value: { literal: 'correct' } }),
    });
    completed(await execute(good));
    const bad = baseStep('fill', {
      target: css('#query'), value: { literal: 'actual' }, timeoutMs: 100,
      expect: expectation({ kind: 'target_value', value: { literal: 'different' } }),
    });
    failed(await execute(bad), 'POSTCONDITION_FAILED');
  });

  test('DOM change condition observes an SPA mutation', async () => {
    reset('<button id="mutate">Mutate</button>');
    sandbox.querySelector('button').onclick = () => sandbox.insertAdjacentHTML('beforeend', '<div>new</div>');
    const step = baseStep('click', {
      target: css('#mutate'),
      expect: expectation({ kind: 'dom_change', minimumAdded: 1, minimumRemoved: 0, minimumChanged: 0 }),
    });
    const payload = completed(await execute(step));
    equal(payload.effect.urlChanged, false);
    equal(payload.effect.navigationObserved, false);
    failed(await execute(waitStep({
      kind: 'dom_change', minimumAdded: 2, minimumRemoved: 0, minimumChanged: 0,
    }, 100)), 'TIMEOUT');
  });

  test('DOM stability waits for the declared quiet period', async () => {
    reset();
    const started = Date.now();
    setTimeout(() => sandbox.setAttribute('data-changing', 'yes'), 30);
    completed(await execute(waitStep({ kind: 'dom_stable', quietMs: 60 }, 180)));
    assert(Date.now() - started >= 80, 'dom_stable returned before the post-mutation quiet period');
    failed(await execute(waitStep({ kind: 'dom_stable', quietMs: 200 }, 100)), 'TIMEOUT');
  });

  test('extract returns page fields and rejects a missing required field', async () => {
    reset('<main><h1>Detail</h1></main><div id="success">ok</div>');
    const output = { mode: 'page', fields: [{
      name: 'title', type: 'string', locator: css('main h1', { enabled: false }),
      read: 'text', required: true, untrusted: true,
    }] };
    const step = baseStep('extract');
    equal(completed(await execute(step, { output })).result.title, 'Detail');
    output.fields[0].locator = css('#missing', { enabled: false });
    failed(await execute(step, { output }), 'TARGET_NOT_FOUND');
  });

  test('collection extraction scopes fields to their own product card', async () => {
    reset(`<main>
      <article class="product"><h2>Alpha</h2><span class="price">$10</span><a href="/p/alpha">View</a></article>
      <article class="product"><h2>Beta</h2><span class="price">$20</span><a href="/p/beta">View</a></article>
    </main><div id="success">ok</div>`);
    const output = {
      mode: 'collection',
      collectionRoot: css('main', { enabled: false }),
      item: css('article.product', { cardinality: 'many', enabled: false }),
      limit: 10,
      fields: [
        { name: 'name', type: 'string', locator: css('h2', { enabled: false }), read: 'text', required: true, untrusted: true },
        { name: 'price', type: 'string', locator: css('.price', { enabled: false }), read: 'text', required: true, untrusted: true },
        { name: 'url', type: 'url', locator: css('a', { enabled: false }), read: 'href', required: true, untrusted: true },
      ],
    };
    const result = completed(await execute(baseStep('extract'), { output })).result;
    equal(result.count, 2);
    equal(result.items[0].name, 'Alpha');
    equal(result.items[0].price, '$10');
    equal(result.items[1].name, 'Beta');
    equal(result.items[1].price, '$20');
  });

  test('SPA URL mutation and full-navigation signal are distinguished', async () => {
    reset('<button id="spa">SPA</button>');
    sandbox.querySelector('button').onclick = () => history.pushState({}, '', '/spa-result');
    const spa = baseStep('click', {
      target: css('#spa'), expect: expectation({ kind: 'url', pattern: '/spa-result$' }),
    });
    const spaEffect = completed(await execute(spa)).effect;
    equal(spaEffect.urlChanged, true);
    equal(spaEffect.navigationExpected, true);
    equal(spaEffect.navigationObserved, false);

    reset('<button id="full">Full</button>');
    sandbox.querySelector('button').onclick = () => {
      window.dispatchEvent(new Event('pagehide'));
      history.pushState({}, '', '/full-result');
    };
    const full = baseStep('click', {
      target: css('#full'), expect: expectation({ kind: 'url', pattern: '/full-result$' }),
    });
    const fullFailure = failed(await execute(full), 'TRANSPORT_DISCONNECTED');
    equal(fullFailure.error.observed.navigationObserved, true);
  });

  test('navigation outside runtime allowlist fails closed', async () => {
    reset();
    const step = waitStep(present('#success'));
    const action = actionFor(step, { runtime: {
      allowedOrigins: ['https://not-this-origin.example'], maxDurationMs: 2000, maxNavigations: 0,
    } });
    failed(await execute(step, { action }), 'NAVIGATION_OUT_OF_SCOPE');
  });

  test('cancellation during wait prevents a subsequent command', async () => {
    reset('<button id="later">Later</button>');
    let clicks = 0;
    sandbox.querySelector('button').onclick = () => { clicks += 1; };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    failed(await execute(waitStep(present('#never'), 500), { signal: controller.signal }), 'CANCELLED');
    const click = baseStep('click', { target: css('#later'), expect: expectation(present('#later')) });
    failed(await execute(click, { signal: controller.signal }), 'CANCELLED');
    equal(clicks, 0);
  });

  test('step timeout and expired action timeout both fail', async () => {
    reset();
    failed(await execute(waitStep(present('#never'), 100)), 'TIMEOUT');
    const step = waitStep(present('#success'), 500);
    failed(await execute(step, { actionStartedAt: Date.now() - 3000 }), 'TIMEOUT');
  });

  test('arguments are validated and values are resolved without interpolation', async () => {
    reset('<input id="query"><div id="success">ok</div>');
    const step = baseStep('fill', {
      target: css('#query'), value: { fromArgument: 'query' },
      expect: expectation({ kind: 'target_value', value: { fromArgument: 'query' } }),
    });
    failed(await execute(step, { arguments: {} }), 'INVALID_ARGUMENTS');
    failed(await execute(step, { arguments: { query: 42 } }), 'INVALID_ARGUMENTS');
    failed(await execute(step, { arguments: { query: 'ok', extra: true } }), 'INVALID_ARGUMENTS');
    const literal = '${globalThis.__actorInjected = true}';
    globalThis.__actorInjected = false;
    completed(await execute(step, { arguments: { query: literal } }));
    equal(sandbox.querySelector('input').value, literal);
    equal(globalThis.__actorInjected, false);
  });

  test('mismatched command is rejected as PLAN_VERSION_MISMATCH', async () => {
    reset();
    const step = waitStep(present('#success'));
    const command = commandFor({ ...step, id: 'different_step' });
    failed(await execute(step, { command }), 'PLAN_VERSION_MISMATCH');
  });

  test('owned-storefront fixture executes directly and returns structured products', async () => {
    const response = await fetch('/documentation/contracts/examples/owned-storefront.action-list.json');
    const list = await response.json();
    const action = list.actions.find(({ id }) => id === 'search_products');
    const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    action.runtime.allowedOrigins = [origin];
    action.precondition.urlPatterns = [`^${escapedOrigin}/demo/?$`];
    action.steps[1].expect.checks.find(({ kind }) => kind === 'url').pattern = (
      `^${escapedOrigin}/demo/search(?:\\?.*)?$`
    );
    list.states.find(({ id }) => id === 'catalog')
      .match.checks.find(({ kind }) => kind === 'url').pattern = `^${escapedOrigin}/demo/?$`;
    list.states.find(({ id }) => id === 'search_results')
      .match.checks.find(({ kind }) => kind === 'url').pattern = (
        `^${escapedOrigin}/demo/search(?:\\?.*)?$`
      );
    history.replaceState({}, '', '/demo/');
    sandbox.innerHTML = `<form role="search">
      <label for="catalog-search">Search the catalog</label>
      <input id="catalog-search" type="search">
      <button type="submit">Search</button>
    </form><main></main>`;
    sandbox.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      history.pushState({}, '', `/demo/search?q=${encodeURIComponent(sandbox.querySelector('input').value)}`);
      sandbox.querySelector('main').innerHTML = `<article data-product-id="field-h1">
        <h2>Field H1</h2><span data-price>$129</span>
        <a href="/demo/product/field-h1">Product details — Field H1</a>
      </article>`;
    });
    const args = { query: 'headphones' };
    let finalResult = null;
    const originalFetch = window.fetch;
    const originalXHR = window.XMLHttpRequest;
    const originalWebSocket = window.WebSocket;
    const forbidNetwork = () => { throw new Error('Actor fixture used the network'); };
    window.fetch = forbidNetwork;
    window.XMLHttpRequest = forbidNetwork;
    window.WebSocket = forbidNetwork;
    const actionStartedAt = Date.now();
    try {
      for (let index = 0; index < action.steps.length; index += 1) {
        const step = action.steps[index];
        const outcome = await WebMcpActor.executeStep({
          action,
          command: { commandId: `fixture_command_${index}`, stepIndex: index, step, arguments: args },
          document,
          signal: new AbortController().signal,
          states: list.states,
          actionStartedAt,
        });
        const payload = completed(outcome);
        if (step.op === 'extract') finalResult = payload.result;
      }
    } finally {
      window.fetch = originalFetch;
      window.XMLHttpRequest = originalXHR;
      window.WebSocket = originalWebSocket;
    }
    document.querySelector('#fixture-result').textContent = JSON.stringify(finalResult, null, 2);
    equal(finalResult.count, 1);
    equal(finalResult.items[0].name, 'Field H1');
    equal(finalResult.items[0].price, '$129');
    equal(finalResult.items[0].url, `${origin}/demo/product/field-h1`);
  });

  test('runtime makes no fetch, XHR, WebSocket, or model call', async () => {
    reset('<input id="query"><div id="success">ok</div>');
    let networkCalls = 0;
    const originalFetch = window.fetch;
    const originalXHR = window.XMLHttpRequest;
    const originalWebSocket = window.WebSocket;
    window.fetch = () => { networkCalls += 1; throw new Error('network forbidden'); };
    window.XMLHttpRequest = class { constructor() { networkCalls += 1; } };
    window.WebSocket = class { constructor() { networkCalls += 1; } };
    try {
      const step = baseStep('fill', {
        target: css('#query'), value: { literal: 'offline' },
        expect: expectation({ kind: 'target_value', value: { literal: 'offline' } }),
      });
      completed(await execute(step));
      equal(networkCalls, 0);
    } finally {
      window.fetch = originalFetch;
      window.XMLHttpRequest = originalXHR;
      window.WebSocket = originalWebSocket;
    }
  });


  test('item label lookup cannot escape its product card', async () => {
    reset('<input id="outside" value="secret"><article><label for="outside">Price</label></article>');
    const output = { mode: 'collection', collectionRoot: css('#sandbox'),
      item: css('article', { cardinality: 'many' }), limit: 10,
      fields: [{ name: 'price', type: 'string', read: 'value', required: true, untrusted: true,
        locator: locator([{ kind: 'label', text: 'Price', exact: true }]) }] };
    failed(await execute(baseStep('extract'), { output }), 'TARGET_NOT_FOUND');
  });

  test('altered command with matching id and op is rejected before clicking', async () => {
    reset('<button id="safe">Safe</button><button id="other">Other</button><div id="success">ok</div>');
    let clicks = 0;
    sandbox.querySelector('#other').onclick = () => { clicks += 1; };
    const step = baseStep('click', { target: css('#safe') });
    failed(await execute(step, { command: commandFor({ ...step, target: css('#other') }) }), 'PLAN_VERSION_MISMATCH');
    equal(clicks, 0);
  });

  test('disallowed starting origin fails before any side effect', async () => {
    reset('<button id="go">Go</button><div id="success">ok</div>');
    let clicks = 0;
    sandbox.querySelector('button').onclick = () => { clicks += 1; };
    const step = baseStep('click', { target: css('#go') });
    failed(await execute(step, { runtime: { allowedOrigins: ['https://elsewhere.example'], maxDurationMs: 2000 } }), 'NAVIGATION_OUT_OF_SCOPE');
    equal(clicks, 0);
  });

  test('abort during state detection prevents the pending click', async () => {
    reset('<button id="go">Go</button><div id="success">ok</div>');
    let clicks = 0;
    sandbox.querySelector('button').onclick = () => { clicks += 1; };
    const controller = new AbortController();
    const getStateId = async () => { controller.abort(); return 'ready'; };
    failed(await execute(baseStep('click', { target: css('#go') }), { signal: controller.signal, getStateId }), 'CANCELLED');
    equal(clicks, 0);
  });

  test('stalled state detection is bounded by the step deadline', async () => {
    reset();
    failed(await execute(waitStep(present('#success'), 100), {
      getStateId: () => new Promise(() => {}),
    }), 'TIMEOUT');
  });

  test('action deadline expiring during a click postcondition is TIMEOUT', async () => {
    reset('<button id="go">Go</button>');
    failed(await execute(baseStep('click', { target: css('#go'), timeoutMs: 500 }), {
      actionStartedAt: Date.now() - 1950,
    }), 'TIMEOUT');
  });

  test('interaction rejects readonly, inherited disabled, and covered targets', async () => {
    reset('<input id="readonly" readonly><fieldset disabled><button id="disabled-child">No</button></fieldset><button id="covered">Covered</button><div id="success">ok</div>');
    failed(await execute(baseStep('fill', { target: css('#readonly'), value: { literal: 'x' } })), 'TARGET_NOT_INTERACTABLE');
    equal(sandbox.querySelector('#readonly').value, '');
    failed(await execute(baseStep('click', { target: css('#disabled-child') })), 'TARGET_NOT_INTERACTABLE');
    const cover = document.createElement('div');
    cover.style.cssText = 'position:fixed;inset:0;z-index:99999;background:white';
    document.body.append(cover);
    try { failed(await execute(baseStep('click', { target: css('#covered') })), 'TARGET_NOT_INTERACTABLE'); }
    finally { cover.remove(); }
  });

  test('mutating primitives reject a many locator without choosing one', async () => {
    reset('<button>A</button><button>B</button><div id="success">ok</div>');
    let clicks = 0;
    sandbox.querySelectorAll('button').forEach(el => { el.onclick = () => { clicks += 1; }; });
    failed(await execute(baseStep('click', { target: css('#sandbox button', { cardinality: 'many' }) })), 'TARGET_AMBIGUOUS');
    equal(clicks, 0);
  });

  test('optional extraction is null, item limit enforced, malformed numbers rejected', async () => {
    reset('<main><article><span>1</span></article><article><span>2</span></article></main><div id="success">ok</div>');
    const output = { mode: 'collection', collectionRoot: css('main'), item: css('article', { cardinality: 'many' }), limit: 1,
      fields: [{ name: 'n', type: 'integer', locator: css('span'), read: 'text', required: true, untrusted: true },
      { name: 'missing', type: 'string', locator: css('.missing', { cardinality: 'zero_or_one' }), read: 'text', required: false, untrusted: true }] };
    const result = completed(await execute(baseStep('extract'), { output })).result;
    equal(result.count, 1); equal(result.items[0].n, 1); equal(result.items[0].missing, null);
    sandbox.querySelector('span').textContent = '12oops';
    failed(await execute(baseStep('extract'), { output }), 'POSTCONDITION_FAILED');
  });

  test('argument string limits count Unicode characters and numeric constraints hold', async () => {
    const schema = { type: 'object', properties: { query: { type: 'string', maxLength: 1 } }, required: ['query'], additionalProperties: false };
    equal(WebMcpActor.validateArguments(schema, { query: '😀' }), null);
    assert(WebMcpActor.validateArguments(schema, { query: 'ab' }), 'maxLength ignored');
    const numeric = { ...schema, properties: { query: { type: 'integer', minimum: 1, maximum: 3, enum: [1, 3] } } };
    equal(WebMcpActor.validateArguments(numeric, { query: 3 }), null);
    for (const query of [0, 2, 4, 1.5, Infinity, NaN]) assert(WebMcpActor.validateArguments(numeric, { query }), 'invalid integer accepted');
  });

  test('any condition set and zero-or-one locator work', async () => {
    reset();
    completed(await execute(baseStep('wait', { expect: { mode: 'any', checks: [present('#missing'), present('#success')] } })));
    equal(WebMcpActor.resolveLocator(css('#missing', { cardinality: 'zero_or_one' }), { document }).elements.length, 0);
  });

  test('Space uses the DOM key value and cancelled keydown suppresses keypress', async () => {
    reset('<input id="key"><div id="success">ok</div>');
    const seen = [];
    const target = sandbox.querySelector('input');
    target.onkeydown = e => { seen.push(e.key); e.preventDefault(); };
    target.onkeypress = () => seen.push('keypress');
    target.onkeyup = () => seen.push('keyup');
    completed(await execute(baseStep('press', { target: css('#key'), key: 'Space' })));
    equal(seen.join(','), ' ,keyup');
  });

  test('real navigation replaces the document and never falsely completes the old command', async () => {
    reset();
    const frame = document.createElement('iframe');
    frame.title = 'Navigation fixture';
    frame.style.cssText = 'width:500px;height:150px';
    const nextLoad = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Navigation fixture did not load')), 3000);
      frame.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    const loaded = nextLoad();
    frame.src = '/extension/actor/tests/navigation-start.html';
    sandbox.append(frame);
    try {
      await loaded;
      const oldDocument = frame.contentDocument;
      const navigated = nextLoad();
      const step = baseStep('click', { target: css('#navigate'), timeoutMs: 2000,
        expect: expectation({ kind: 'url', pattern: '/navigation-end\\.html$' }) });
      const outcome = await WebMcpActor.executeStep({ action: actionFor(step), command: commandFor(step), document: oldDocument });
      const payload = failed(outcome, 'TRANSPORT_DISCONNECTED');
      equal(payload.error.observed.navigationObserved, true);
      await navigated;
      assert(frame.contentDocument !== oldDocument, 'document was not replaced');
      assert(frame.contentDocument.querySelector('#destination'), 'destination missing');
      const verify = waitStep({ kind: 'element', target: css('#destination'), assertion: 'present' });
      completed(await WebMcpActor.executeStep({ action: actionFor(verify), command: commandFor(verify), document: frame.contentDocument }));
    } finally { frame.remove(); }
  });

  test('command envelope version is enforced and equivalent JSON ordering is accepted', async () => {
    reset();
    const step = waitStep(present('#success'));
    const payload = commandFor(step);
    completed(await execute(step, { command: { protocol: 'webmcp-run/1', type: 'step.command', payload } }));
    failed(await execute(step, { command: { protocol: 'webmcp-run/2', type: 'step.command', payload } }), 'PLAN_VERSION_MISMATCH');
    completed(await execute(step, { command: commandFor(Object.fromEntries(Object.entries(step).reverse())) }));
  });

  test('input value disappearing during a fill fails its postcondition', async () => {
    reset('<input id="vanish">');
    sandbox.querySelector('input').oninput = e => e.target.remove();
    failed(await execute(baseStep('fill', { target: css('#vanish'), value: { literal: 'x' },
      expect: expectation({ kind: 'target_value', value: { literal: 'x' } }) })), 'POSTCONDITION_FAILED');
  });

  test('active-element, text, and fallback strategies remain deterministic', async () => {
    reset('<input id="active"><button>Continue</button><div id="success">ok</div>');
    sandbox.querySelector('input').focus();
    equal(WebMcpActor.resolveLocator(locator([{ kind: 'active_element' }]), { document }).elements[0].id, 'active');
    equal(WebMcpActor.resolveLocator(locator([{ kind: 'text', text: 'Continue', exact: true }]), { document }).elements[0].localName, 'button');
    const step = baseStep('click', { target: locator([
      { kind: 'role', role: 'button', name: 'Missing', exact: true },
      { kind: 'label', text: 'Missing', exact: true },
      { kind: 'attribute', attribute: 'data-testid', value: 'missing' },
      { kind: 'css', selector: '#sandbox button' },
    ]) });
    completed(await execute(step));
  });

  const results = [];
  for (const entry of tests) {
    try {
      await entry.body();
      results.push({ name: entry.name, passed: true });
    } catch (error) {
      results.push({ name: entry.name, passed: false, error: error.stack || error.message });
    }
  }
  history.replaceState({}, '', entryURL);
  const failures = results.filter(({ passed }) => !passed);
  document.body.dataset.status = failures.length ? 'failed' : 'passed';
  document.querySelector('#summary').textContent = `${results.length - failures.length}/${results.length} tests passed`;
  document.querySelector('#outcomes').textContent = JSON.stringify(outcomes);
  document.querySelector('#results').innerHTML = results.map((result) => (
    `<li class="${result.passed ? 'pass' : 'fail'}">${result.passed ? 'PASS' : 'FAIL'} — ${result.name}${result.error ? `: ${result.error}` : ''}</li>`
  )).join('');
})();
