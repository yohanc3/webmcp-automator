(() => {
  'use strict';

  const nodeMode = typeof module === 'object' && module.exports;
  const ambient = nodeMode
    ? require('../ambient-capture.js')
    : globalThis.WebMcpAmbientCapture;
  const retrySpool = nodeMode
    ? require('../retry-spool.js')
    : globalThis.WebMcpAmbientRetrySpool;
  const nodeAssert = nodeMode ? require('node:assert/strict') : null;
  const nodeTest = nodeMode ? require('node:test') : null;
  const browserTest = nodeMode ? null : globalThis.ExtensionTest;
  const test = nodeMode ? nodeTest.test : browserTest.test;
  const equal = nodeMode ? nodeAssert.equal : browserTest.assert.equal;
  const deepEqual = nodeMode ? nodeAssert.deepEqual : browserTest.assert.deepEqual;
  const match = nodeMode ? nodeAssert.match : browserTest.assert.match;

  const SITE_SCOPE = Object.freeze({
    scopeId: 'shop_scope',
    origin: 'https://shop.test',
    routePatterns: ['^/catalog', '^/orders'],
  });
  const ALLOWED = Object.freeze({
    decisionId: 'policy_shop_ambient',
    status: 'allowed',
    scope: 'ambient_learn',
    checkedAt: '2026-09-03T12:00:00.000Z',
  });
  const DENIED = Object.freeze({
    decisionId: 'policy_shop_revoked',
    status: 'denied',
    scope: 'ambient_learn',
    checkedAt: '2026-09-03T12:00:01.000Z',
  });
  const SECRET = 'canary-ambient-secret-7f31c9';

  const projection = ({
    marker = 'catalog',
    url = 'https://shop.test/catalog',
    evidenceIds = ['node_catalog', 'node_orders_link'],
  } = {}) => ({
    url,
    semanticXml: [
      `<semantic-ui schema="semantic-ui/2" url="${url}" title="Store">`,
      `  <node ref="${evidenceIds[0]}" role="main">${marker}</node>`,
      evidenceIds[1] ? `  <node ref="${evidenceIds[1]}" role="link">Orders</node>` : '',
      '</semantic-ui>',
    ].filter(Boolean).join('\n'),
    evidenceIds,
    redactions: {
      schemaVersion: 'redaction-ledger/1',
      total: marker === '[redacted]' ? 1 : 0,
      counts: marker === '[redacted]' ? { credential: 1 } : {},
    },
    rawPersisted: false,
  });

  const createObserver = (initialProjection = projection()) => {
    let callbacks = null;
    let attachCount = 0;
    const discarded = [];
    const disconnected = [];
    return {
      attach(options) {
        attachCount += 1;
        callbacks = options;
        return {
          discard(observationId, reason) {
            discarded.push({ observationId, reason });
          },
          disconnect(reason) {
            disconnected.push(reason);
          },
        };
      },
      async captureInitial() {
        return initialProjection;
      },
      get attachCount() { return attachCount; },
      get callbacks() { return callbacks; },
      discarded,
      disconnected,
    };
  };

  const createEligibility = (decisions = [ALLOWED]) => {
    let call = 0;
    const contexts = [];
    return {
      contexts,
      async current(context) {
        contexts.push(context);
        const decision = decisions[Math.min(call, decisions.length - 1)];
        call += 1;
        return decision;
      },
    };
  };

  const createDelivery = (outcome = 'no_change') => {
    const delivered = [];
    const conflicts = [];
    return {
      conflicts,
      delivered,
      async deliver(completedLayer) {
        delivered.push(completedLayer);
        return { outcome, receiptId: `receipt_${completedLayer.layer.layerId}` };
      },
      async onConflict(value) {
        conflicts.push(value);
      },
    };
  };

  const createFixture = ({
    decisions = [ALLOWED],
    initialProjection = projection(),
    outcome = 'no_change',
    setTimer,
    clearTimer,
  } = {}) => {
    const observer = createObserver(initialProjection);
    const eligibility = createEligibility(decisions);
    const delivery = createDelivery(outcome);
    const storage = retrySpool.createMemoryStorage();
    const spool = retrySpool.createRetrySpool({ storage });
    const layers = [];
    const capture = ambient.createAmbientCapture({
      eligibility,
      observer,
      delivery,
      spool,
      onCompletedLayer: (layer) => layers.push(layer),
      setTimer,
      clearTimer,
    });
    return { capture, delivery, eligibility, layers, observer, spool };
  };

  const start = (fixture) => fixture.capture.start({
    siteScope: SITE_SCOPE,
    route: '/catalog',
  });

  const click = (overrides = {}) => ({
    kind: 'click',
    targetEvidenceId: 'node_orders_link',
    trusted: true,
    ...overrides,
  });

  test('attaches only after a current ambient_learn eligibility decision', async () => {
    const denied = createFixture({ decisions: [DENIED] });
    const result = await start(denied);
    equal(result.attached, false);
    equal(denied.observer.attachCount, 0);
    equal(denied.layers.length, 0);

    const allowed = createFixture();
    const attached = await start(allowed);
    equal(attached.attached, true);
    equal(allowed.observer.attachCount, 1);
    deepEqual(allowed.eligibility.contexts[0], {
      origin: 'https://shop.test',
      route: '/catalog',
      scope: 'ambient_learn',
    });
    await allowed.capture.whenIdle();
  });

  test('emits the initial semantic-ui/2 layer with no observation', async () => {
    const initialProjection = projection();
    initialProjection.url = `https://shop.test/catalog?token=${SECRET}#private`;
    const fixture = createFixture({ initialProjection });
    const result = await start(fixture);
    const initial = result.initialLayer;
    equal(initial.observation, null);
    equal(initial.layer.sequence, 1);
    equal(initial.layer.completedAt.length > 0, true);
    equal(initial.layer.completionReason, 'initial_document');
    equal(initial.layer.semanticXmlVersion, 'semantic-ui/2');
    equal(initial.layer.url, 'https://shop.test/catalog');
    equal(JSON.stringify(initial).includes(SECRET), false);
    match(initial.layer.semanticXmlDigest, /^sha256:[a-f0-9]{64}$/);
    deepEqual(initial.layer.evidenceIds, ['node_catalog', 'node_orders_link']);
    equal(initial.privacy.rawPersisted, false);
    await fixture.capture.whenIdle();
  });

  test('buffers an attachment-time event until the initial layer has committed', async () => {
    const layers = [];
    let earlySettlement = Promise.resolve();
    const observer = {
      attach(callbacks) {
        const observationId = callbacks.onObservation(click());
        earlySettlement = callbacks.onSettled(observationId, {
          projection: projection({ marker: 'early-update' }),
          outcome: { kind: 'semantic_update', evidenceIds: ['update_early'] },
        });
        return { disconnect() {} };
      },
      async captureInitial() {
        return projection();
      },
    };
    const storage = retrySpool.createMemoryStorage();
    const spool = retrySpool.createRetrySpool({ storage });
    const capture = ambient.createAmbientCapture({
      eligibility: createEligibility(),
      observer,
      delivery: createDelivery(),
      spool,
      onCompletedLayer: (layer) => layers.push(layer),
    });

    await capture.start({ siteScope: SITE_SCOPE, route: '/catalog' });
    await earlySettlement;
    await capture.whenIdle();

    equal(layers.length, 2);
    equal(layers[1].observation.fromLayerId, 'layer_shop_scope_1');
    equal(layers[1].observation.fromLayerId === null, false);
  });

  test('uses an injected site-scope sequence across document lifecycles', async () => {
    const layerSequence = ambient.createMemoryLayerSequence();
    const layers = [];
    const buildCapture = () => {
      const storage = retrySpool.createMemoryStorage();
      return ambient.createAmbientCapture({
        eligibility: createEligibility(),
        observer: createObserver(),
        delivery: createDelivery(),
        spool: retrySpool.createRetrySpool({ storage }),
        layerSequence,
        onCompletedLayer: (layer) => layers.push(layer),
      });
    };
    const first = buildCapture();
    await first.start({ siteScope: SITE_SCOPE, route: '/catalog' });
    await first.whenIdle();
    first.stop('navigation');
    const second = buildCapture();
    await second.start({ siteScope: SITE_SCOPE, route: '/orders' });
    await second.whenIdle();

    deepEqual(layers.map(({ layer }) => layer.sequence), [1, 2]);
    deepEqual(layers.map(({ layer }) => layer.layerId), [
      'layer_shop_scope_1',
      'layer_shop_scope_2',
    ]);
  });

  test('keeps equal XML as distinct layers for distinct causal observations', async () => {
    const fixture = createFixture();
    await start(fixture);
    const sameProjection = projection();

    const firstId = fixture.observer.callbacks.onObservation(click());
    await fixture.observer.callbacks.onSettled(firstId, {
      projection: sameProjection,
      outcome: { kind: 'semantic_update', evidenceIds: ['update_first'] },
    });
    const secondId = fixture.observer.callbacks.onObservation(click());
    await fixture.observer.callbacks.onSettled(secondId, {
      projection: sameProjection,
      outcome: { kind: 'no_visible_change', evidenceIds: ['update_second'] },
    });
    await fixture.capture.whenIdle();

    equal(fixture.layers.length, 3);
    deepEqual(fixture.layers.map(({ layer }) => layer.sequence), [1, 2, 3]);
    equal(
      fixture.layers[1].layer.semanticXmlDigest,
      fixture.layers[2].layer.semanticXmlDigest,
    );
    equal(fixture.layers[2].observation.outcome.kind, 'no_visible_change');
    equal(fixture.layers[2].layer.completionReason, 'user_effect');
    deepEqual(
      fixture.layers.slice(1).map(({ observation }) => observation.observationId),
      ['obs_shop_scope_1', 'obs_shop_scope_2'],
    );
    deepEqual(
      fixture.layers.slice(1).map(({ observation }) => observation.fromLayerId),
      ['layer_shop_scope_1', 'layer_shop_scope_2'],
    );
  });

  test('buffers rapid observations until their causal event sequence can append', async () => {
    const fixture = createFixture();
    await start(fixture);
    const firstId = fixture.observer.callbacks.onObservation(click({
      targetEvidenceId: 'node_first',
    }));
    const secondId = fixture.observer.callbacks.onObservation(click({
      targetEvidenceId: 'node_second',
    }));

    await fixture.observer.callbacks.onSettled(secondId, {
      projection: projection({ marker: 'second-settled-first' }),
      outcome: { kind: 'semantic_update', evidenceIds: ['update_second'] },
    });
    equal(fixture.layers.length, 1);
    await fixture.observer.callbacks.onSettled(firstId, {
      projection: projection({ marker: 'first-settled-second' }),
      outcome: { kind: 'semantic_update', evidenceIds: ['update_first'] },
    });
    await fixture.capture.whenIdle();

    deepEqual(
      fixture.layers.slice(1).map(({ observation }) => observation.eventSequence),
      [1, 2],
    );
    deepEqual(
      fixture.layers.slice(1).map(({ observation }) => observation.targetEvidenceId),
      ['node_first', 'node_second'],
    );
    deepEqual(
      fixture.layers.slice(1).map(({ observation }) => observation.fromLayerId),
      ['layer_shop_scope_1', 'layer_shop_scope_2'],
    );
  });

  test('preserves click to SPA update and click to navigation causal order', async () => {
    const fixture = createFixture();
    await start(fixture);
    const spaObservation = fixture.observer.callbacks.onObservation(click());
    await fixture.observer.callbacks.onSettled(spaObservation, {
      projection: projection({ marker: 'orders-open' }),
      outcome: { kind: 'same_document_route', evidenceIds: ['route_orders'] },
    });
    const navigationObservation = fixture.observer.callbacks.onObservation(click({
      targetEvidenceId: 'node_order_detail',
    }));
    await fixture.observer.callbacks.onSettled(navigationObservation, {
      projection: projection({
        marker: 'order-detail',
        url: 'https://shop.test/orders/detail',
        evidenceIds: ['node_order_detail'],
      }),
      outcome: { kind: 'navigation', evidenceIds: ['navigation_order_detail'] },
    });
    await fixture.capture.whenIdle();

    deepEqual(fixture.layers.map(({ observation }) => observation?.outcome.kind || null), [
      null,
      'same_document_route',
      'navigation',
    ]);
    deepEqual(fixture.layers.map(({ layer }) => layer.completionReason), [
      'initial_document',
      'same_document_route',
      'navigation',
    ]);
    deepEqual(fixture.layers.map(({ layer }) => layer.url), [
      'https://shop.test/catalog',
      'https://shop.test/catalog',
      'https://shop.test/orders/detail',
    ]);
  });

  test('revocation disconnects capture and blocks a queued transfer', async () => {
    const fixture = createFixture({ decisions: [ALLOWED, DENIED] });
    await start(fixture);
    await fixture.capture.whenIdle();

    equal(fixture.capture.status().attached, false);
    deepEqual(fixture.observer.disconnected, ['policy_revoked']);
    equal(fixture.delivery.delivered.length, 0);
    equal((await fixture.spool.list()).length, 1);
  });

  test('drops actor, synthetic, untrusted, and background observations', async () => {
    const fixture = createFixture();
    await start(fixture);
    const { onObservation } = fixture.observer.callbacks;

    equal(onObservation(click({ actor: true })), null);
    equal(onObservation(click({ synthetic: true })), null);
    equal(onObservation(click({ trusted: false })), null);
    equal(onObservation(click({ background: true })), null);
    equal(fixture.capture.status().eventSequence, 0);
    await fixture.capture.whenIdle();
  });

  test('normalizes recorder event kinds into the frozen observation enum', async () => {
    const fixture = createFixture();
    await start(fixture);
    const selectId = fixture.observer.callbacks.onObservation({
      kind: 'select',
      targetEvidenceId: 'node_category',
      trusted: true,
    });
    await fixture.observer.callbacks.onSettled(selectId, {
      projection: projection({ marker: 'category-selected' }),
      outcome: { kind: 'semantic_update', evidenceIds: ['update_category'] },
    });
    const navigateId = fixture.observer.callbacks.onObservation({
      kind: 'navigate',
      trusted: true,
    });
    await fixture.observer.callbacks.onSettled(navigateId, {
      projection: projection({ marker: 'history-navigation' }),
      outcome: { kind: 'navigation', evidenceIds: ['navigation_history'] },
    });
    await fixture.capture.whenIdle();

    deepEqual(fixture.layers.slice(1).map(({ observation }) => observation.kind), [
      'other',
      'navigate',
    ]);
    equal(fixture.layers[2].observation.targetEvidenceId, null);
  });

  test('retains no raw event values and emits no secret canary', async () => {
    const fixture = createFixture({
      initialProjection: projection({ marker: '[redacted]' }),
    });
    await start(fixture);
    const observationId = fixture.observer.callbacks.onObservation(click({
      argumentTokens: ['{{arg.query}}'],
      target: {
        id: 'node_orders_link',
        name: SECRET,
        css: `#${SECRET}`,
      },
      value: {
        token: '{{arg.query}}',
        rawValue: SECRET,
        value: SECRET,
      },
      rawEvent: { text: SECRET },
    }));
    await fixture.observer.callbacks.onSettled(observationId, {
      projection: projection({ marker: '[redacted]' }),
      outcome: { kind: 'semantic_update', evidenceIds: ['update_redacted'] },
    });
    await fixture.capture.whenIdle();

    const serialized = JSON.stringify(fixture.layers);
    equal(serialized.includes(SECRET), false);
    equal(serialized.includes('rawEvent'), false);
    deepEqual(fixture.layers[1].observation.argumentTokens, ['{{arg.query}}']);
    deepEqual(Object.keys(fixture.layers[1]).sort(), [
      'layer',
      'observation',
      'policy',
      'privacy',
      'siteScope',
    ]);
  });

  test('expires incomplete observation material by 30 seconds', async () => {
    const timers = new Map();
    let nextTimer = 1;
    const fixture = createFixture({
      setTimer(callback, delay) {
        const id = nextTimer;
        nextTimer += 1;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimer(id) {
        timers.delete(id);
      },
    });
    await start(fixture);
    const observationId = fixture.observer.callbacks.onObservation(click());
    equal(fixture.capture.status().pendingLayers, 1);
    const timer = [...timers.values()][0];
    equal(timer.delay, 30000);
    timer.callback();
    equal(fixture.capture.status().pendingLayers, 0);
    deepEqual(fixture.observer.discarded, [{
      observationId,
      reason: 'incomplete_layer_ttl',
    }]);
    equal(await fixture.observer.callbacks.onSettled(observationId, {
      projection: projection(),
      outcome: { kind: 'semantic_update', evidenceIds: [] },
    }), null);
    await fixture.capture.whenIdle();
  });

  test('expires a settled layer that remains blocked behind prior causal work', async () => {
    const timers = new Map();
    let nextTimer = 1;
    const fixture = createFixture({
      setTimer(callback, delay) {
        const id = nextTimer;
        nextTimer += 1;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimer(id) {
        timers.delete(id);
      },
    });
    await start(fixture);
    const firstId = fixture.observer.callbacks.onObservation(click({
      targetEvidenceId: 'node_first',
    }));
    const secondId = fixture.observer.callbacks.onObservation(click({
      targetEvidenceId: 'node_second',
    }));
    await fixture.observer.callbacks.onSettled(secondId, {
      projection: projection({ marker: 'blocked-second' }),
      outcome: { kind: 'semantic_update', evidenceIds: ['update_second'] },
    });
    equal(timers.has(2), true);
    timers.get(2).callback();
    await fixture.observer.callbacks.onSettled(firstId, {
      projection: projection({ marker: 'completed-first' }),
      outcome: { kind: 'semantic_update', evidenceIds: ['update_first'] },
    });
    await fixture.capture.whenIdle();

    deepEqual(fixture.layers.map(({ layer }) => layer.sequence), [1, 2]);
    equal(fixture.layers.some(({ observation }) => (
      observation?.observationId === secondId
    )), false);
    equal(fixture.observer.discarded.some(({ observationId }) => (
      observationId === secondId
    )), true);
  });

  test('enforces encrypted local spool receipts, conflict reparse, and hard TTL', async () => {
    let timestamp = 1000;
    const storage = retrySpool.createMemoryStorage();
    const spool = retrySpool.createRetrySpool({
      storage,
      now: () => timestamp,
      ttlMs: 100,
    });
    const fixture = createFixture();
    const { initialLayer } = await start(fixture);
    await fixture.capture.whenIdle();

    for (const outcome of ['applied', 'duplicate', 'no_change']) {
      const layer = JSON.parse(JSON.stringify(initialLayer));
      layer.layer.layerId = `layer_${outcome}`;
      await spool.enqueue(layer);
      const result = await spool.handleReceipt(layer.layer.layerId, { outcome });
      equal(result.disposition, 'deleted');
    }

    const conflictLayer = JSON.parse(JSON.stringify(initialLayer));
    conflictLayer.layer.layerId = 'layer_conflict';
    await spool.enqueue(conflictLayer);
    const conflict = await spool.handleReceipt('layer_conflict', {
      outcome: 'conflict',
      receiptId: 'receipt_conflict',
    });
    equal(conflict.disposition, 'retained_for_reparse');
    equal((await spool.list())[0].state, 'reparse');
    equal(await spool.next(), null);
    await spool.requeueAfterConflict('layer_conflict');
    equal((await spool.next()).id, 'layer_conflict');
    await spool.remove('layer_conflict');

    const expiringLayer = JSON.parse(JSON.stringify(initialLayer));
    expiringLayer.layer.layerId = 'layer_expiring';
    await spool.enqueue(expiringLayer);
    timestamp += 101;
    equal((await spool.list()).length, 0);
    equal(Object.hasOwn(spool, 'sync'), false);

    if (nodeMode) {
      nodeAssert.throws(
        () => retrySpool.createRetrySpool({
          storage,
          ttlMs: retrySpool.HARD_TTL_MS + 1,
        }),
        /24 hours/,
      );
    } else {
      let error = null;
      try {
        retrySpool.createRetrySpool({ storage, ttlMs: retrySpool.HARD_TTL_MS + 1 });
      } catch (caught) {
        error = caught;
      }
      match(error.message, /24 hours/);
    }
  });

  test('exposes lifecycle mechanics without a goal or recording-message surface', async () => {
    const fixture = createFixture();
    await start(fixture);
    await fixture.capture.whenIdle();
    const serialized = JSON.stringify(fixture.layers);

    equal(serialized.includes('goal'), false);
    equal(Object.hasOwn(ambient, 'MESSAGE_TYPES'), false);
    equal(Object.hasOwn(ambient, 'handleMessage'), false);
    equal(Object.hasOwn(ambient, 'renderIndicator'), false);
    deepEqual(Object.keys(ambient).sort(), [
      'AMBIENT_SCOPE',
      'INCOMPLETE_LAYER_TTL_MS',
      'createAmbientCapture',
      'createMemoryLayerSequence',
      'sha256',
    ]);
  });

  if (!nodeMode) void browserTest.run();
})();
