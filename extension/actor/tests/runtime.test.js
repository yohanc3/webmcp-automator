(async () => {
  'use strict';

  const tests = [];
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
    equal(outcome.type, 'step.completed');
    equal(outcome.payload.effect.postconditionSatisfied, true);
    return outcome.payload;
  };
  const failed = (outcome, code) => {
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
    const fullEffect = completed(await execute(full)).effect;
    equal(fullEffect.navigationObserved, true);
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
    for (let index = 0; index < action.steps.length; index += 1) {
      const step = action.steps[index];
      const outcome = await WebMcpActor.executeStep({
        action,
        command: { commandId: `fixture_command_${index}`, stepIndex: index, step, arguments: args },
        document,
        signal: new AbortController().signal,
        states: list.states,
      });
      const payload = completed(outcome);
      if (step.op === 'extract') finalResult = payload.result;
    }
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

  const results = [];
  for (const entry of tests) {
    try {
      await entry.body();
      results.push({ name: entry.name, passed: true });
    } catch (error) {
      results.push({ name: entry.name, passed: false, error: error.stack || error.message });
    }
  }
  const failures = results.filter(({ passed }) => !passed);
  document.body.dataset.status = failures.length ? 'failed' : 'passed';
  document.querySelector('#summary').textContent = `${results.length - failures.length}/${results.length} tests passed`;
  document.querySelector('#results').innerHTML = results.map((result) => (
    `<li class="${result.passed ? 'pass' : 'fail'}">${result.passed ? 'PASS' : 'FAIL'} — ${result.name}${result.error ? `: ${result.error}` : ''}</li>`
  )).join('');
})();
