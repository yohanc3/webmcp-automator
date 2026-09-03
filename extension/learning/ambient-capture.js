(function initializeAmbientCapture(root, factory) {
  const ambientCapture = factory();
  root.WebMcpAmbientCapture = ambientCapture;
  if (typeof module === 'object' && module.exports) {
    module.exports = ambientCapture;
  }
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const AMBIENT_SCOPE = 'ambient_learn';
  const INCOMPLETE_LAYER_TTL_MS = 30 * 1000;
  const EVIDENCE_ID = /^[a-z][a-z0-9_.:-]{0,127}$/i;
  const ARGUMENT_TOKEN = /^\{\{arg\.[a-z][a-z0-9_]{0,29}\}\}$/i;
  const OBSERVATION_KIND = Object.freeze({
    change: 'other',
    click: 'click',
    fill: 'fill',
    navigate: 'navigate',
    other: 'other',
    press: 'press',
    select: 'other',
    submit: 'submit',
  });
  const OUTCOME_KINDS = new Set([
    'navigation',
    'no_visible_change',
    'same_document_route',
    'semantic_update',
  ]);

  const clone = (value) => JSON.parse(JSON.stringify(value));

  const createMemoryLayerSequence = (initial = {}) => {
    const sequences = new Map(Object.entries(initial));
    return Object.freeze({
      async next(scopeId) {
        const nextSequence = (sequences.get(scopeId) || 0) + 1;
        sequences.set(scopeId, nextSequence);
        return nextSequence;
      },
    });
  };

  const bytesToHex = (bytes) => Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  const sha256 = async (value) => {
    if (!globalThis.crypto?.subtle || typeof TextEncoder !== 'function') {
      throw new Error('Web Crypto SHA-256 support is required for ambient capture');
    }
    const bytes = new TextEncoder().encode(String(value));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return `sha256:${bytesToHex(new Uint8Array(digest))}`;
  };

  const safeEvidenceIds = (values) => [...new Set(values || [])]
    .filter((value) => typeof value === 'string' && EVIDENCE_ID.test(value))
    .sort();

  const normalizePolicy = (decision) => ({
    decisionId: decision.decisionId,
    status: decision.status,
    scope: AMBIENT_SCOPE,
    checkedAt: decision.checkedAt,
  });

  const allowedDecision = (decision) => (
    decision?.status === 'allowed'
    && decision?.scope === AMBIENT_SCOPE
    && EVIDENCE_ID.test(decision?.decisionId || '')
    && typeof decision.checkedAt === 'string'
    && !Number.isNaN(Date.parse(decision.checkedAt))
  );

  const normalizeSiteScope = (siteScope) => {
    if (!siteScope || !EVIDENCE_ID.test(siteScope.scopeId || '')) {
      throw new TypeError('Ambient capture requires a normalized site scope');
    }
    const originUrl = new URL(siteScope.origin);
    if (!['http:', 'https:'].includes(originUrl.protocol)
      || !['', '/'].includes(originUrl.pathname)
      || originUrl.search
      || originUrl.hash
      || originUrl.username
      || originUrl.password) {
      throw new TypeError('Ambient site scope origin must be a normalized HTTP or HTTPS origin');
    }
    const origin = originUrl.origin;
    if (!Array.isArray(siteScope.routePatterns)
      || siteScope.routePatterns.length === 0
      || siteScope.routePatterns.length > 16
      || siteScope.routePatterns.some((pattern) => typeof pattern !== 'string' || !pattern)) {
      throw new TypeError('Ambient capture requires at least one route pattern');
    }
    return {
      scopeId: siteScope.scopeId,
      origin,
      routePatterns: [...(siteScope.routePatterns || [])],
    };
  };

  const normalizeLayerUrl = (value, expectedOrigin) => {
    const url = new URL(value);
    if (url.origin !== expectedOrigin) {
      throw new Error('Ambient layer URL must remain inside its normalized site origin');
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  };

  const validateProjection = (projection) => {
    if (!projection || typeof projection.semanticXml !== 'string') {
      throw new TypeError('A sanitized semantic projection is required');
    }
    if (projection.semanticXml.length > 500000) {
      throw new Error('Ambient semantic XML exceeds the contract limit');
    }
    if (!/^<semantic-ui\b[^>]*\bschema="semantic-ui\/2"/.test(projection.semanticXml)) {
      throw new Error('Ambient layers require semantic-ui/2 XML');
    }
    if (projection.rawPersisted === true) {
      throw new Error('Raw material cannot enter a completed ambient layer');
    }
    const evidenceIds = safeEvidenceIds(
      projection.evidenceIds || projection.nodes?.map(({ id }) => id),
    );
    if (evidenceIds.length === 0) {
      throw new Error('A completed semantic layer requires stable evidence IDs');
    }
    const xmlEvidenceIds = [...projection.semanticXml.matchAll(/\sref="([^"]+)"/g)]
      .map((match) => match[1]);
    if (xmlEvidenceIds.some((evidenceId) => !EVIDENCE_ID.test(evidenceId))) {
      throw new Error('Semantic XML contains an invalid evidence ID');
    }
    const xmlEvidence = new Set(xmlEvidenceIds);
    if (evidenceIds.some((evidenceId) => !xmlEvidence.has(evidenceId))) {
      throw new Error('Semantic evidence IDs must resolve to XML references');
    }
    return evidenceIds;
  };

  const privacyFor = async (projection, digest) => {
    const supplied = projection.privacy || {};
    const ledger = projection.redactions || {};
    const counts = ledger.counts || supplied.counts || {};
    const categories = supplied.categories || Object.keys(counts)
      .filter((category) => counts[category] > 0);
    const redactionCount = supplied.redactionCount ?? ledger.total ?? Object.values(counts)
      .reduce((sum, count) => sum + (Number.isInteger(count) ? count : 0), 0);
    const redactionDigest = supplied.redactionDigest || await digest(JSON.stringify(
      Object.fromEntries(Object.entries(counts).sort(([left], [right]) => (
        left.localeCompare(right)
      ))),
    ));
    return {
      sanitizerVersion: supplied.sanitizerVersion || 'semantic-sanitizer/1',
      redactionCount,
      redactionDigest,
      categories: [...new Set(categories)].sort(),
      rawPersisted: false,
    };
  };

  const observationFrom = (candidate, { eventSequence, fromLayerId, observationId }) => {
    const kind = OBSERVATION_KIND[candidate?.kind];
    if (!kind) return null;
    const targetEvidenceId = candidate.targetEvidenceId || candidate.target?.id;
    const normalizedTarget = typeof targetEvidenceId === 'string' && EVIDENCE_ID.test(targetEvidenceId)
      ? targetEvidenceId
      : null;
    if (!normalizedTarget && !['navigate', 'other'].includes(kind)) return null;
    const argumentTokens = [...new Set([
      ...(candidate.argumentTokens || []),
      candidate.value?.token,
      ARGUMENT_TOKEN.test(candidate.value?.value || '') ? candidate.value.value : null,
    ].filter((token) => typeof token === 'string' && ARGUMENT_TOKEN.test(token)))];
    return {
      observationId,
      eventSequence,
      fromLayerId,
      kind,
      targetEvidenceId: normalizedTarget,
      argumentTokens,
    };
  };

  const outcomeFrom = (outcome) => {
    if (!outcome || !OUTCOME_KINDS.has(outcome.kind)) {
      throw new Error('A stabilized ambient observation requires a supported outcome');
    }
    const evidenceIds = safeEvidenceIds(outcome.evidenceIds);
    if (evidenceIds.length === 0) {
      throw new Error('A stabilized outcome requires at least one evidence ID');
    }
    return {
      kind: outcome.kind,
      evidenceIds,
    };
  };

  const completionReasonFor = (observation) => {
    if (!observation) return 'initial_document';
    if (observation.outcome.kind === 'navigation') return 'navigation';
    if (observation.outcome.kind === 'same_document_route') return 'same_document_route';
    return 'user_effect';
  };

  const excludedObservation = (candidate, { backgroundAllowed }) => (
    !candidate
    || candidate.actor === true
    || candidate.synthetic === true
    || candidate.trusted === false
    || (candidate.background === true && !backgroundAllowed)
  );

  const createAmbientCapture = ({
    eligibility,
    observer,
    delivery,
    spool,
    layerSequence = createMemoryLayerSequence(),
    digest = sha256,
    now = () => new Date().toISOString(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
    incompleteLayerTtlMs = INCOMPLETE_LAYER_TTL_MS,
    backgroundAllowed = false,
    onCompletedLayer = () => {},
  } = {}) => {
    if (typeof eligibility?.current !== 'function') {
      throw new TypeError('Ambient capture requires an eligibility.current port');
    }
    if (typeof observer?.attach !== 'function' || typeof observer?.captureInitial !== 'function') {
      throw new TypeError('Ambient capture requires attach and captureInitial observer ports');
    }
    if (typeof delivery?.deliver !== 'function') {
      throw new TypeError('Ambient capture requires a delivery.deliver port');
    }
    if (!spool || typeof spool.enqueue !== 'function' || typeof spool.next !== 'function') {
      throw new TypeError('Ambient capture requires a retry spool');
    }
    if (typeof layerSequence?.next !== 'function') {
      throw new TypeError('Ambient capture requires a layerSequence.next port');
    }
    if (!Number.isFinite(incompleteLayerTtlMs)
      || incompleteLayerTtlMs <= 0
      || incompleteLayerTtlMs > INCOMPLETE_LAYER_TTL_MS) {
      throw new RangeError('Incomplete layers must expire within 30 seconds');
    }

    let active = null;
    let captureWork = Promise.resolve();
    let deliveryWork = null;

    const policyContext = (current) => ({
      origin: current.siteScope.origin,
      route: current.route,
      scope: AMBIENT_SCOPE,
    });

    const currentDecision = (current) => eligibility.current(policyContext(current));

    const stop = (reason = 'document_teardown') => {
      const current = active;
      if (!current) return false;
      active = null;
      current.connection?.disconnect?.(reason);
      current.pending.forEach(({ timer, observationId }) => {
        clearTimer(timer);
        current.connection?.discard?.(observationId, reason);
      });
      current.pending.clear();
      return true;
    };

    const revoke = (decision = null) => {
      if (active && decision) active.policy = normalizePolicy(decision);
      return stop('policy_revoked');
    };

    const requestDelivery = () => {
      if (deliveryWork) return deliveryWork;
      deliveryWork = Promise.resolve().then(async () => {
        while (true) {
          const record = await spool.next();
          if (!record) return;
          const context = {
            siteScope: record.completedLayer.siteScope,
            route: new URL(record.completedLayer.layer.url).pathname,
          };
          const decision = await currentDecision(context);
          if (!allowedDecision(decision)) {
            revoke(decision);
            return;
          }
          await spool.markAttempt(record.id);
          let receipt;
          try {
            receipt = await delivery.deliver(clone(record.completedLayer));
          } catch (error) {
            return;
          }
          const disposition = await spool.handleReceipt(record.id, receipt);
          if (disposition.disposition === 'retained_for_reparse') {
            await delivery.onConflict?.({
              completedLayer: clone(record.completedLayer),
              receipt: clone(receipt),
              spoolId: record.id,
            });
          }
          if (disposition.disposition === 'retained_for_retry') return;
        }
      }).finally(() => {
        deliveryWork = null;
      });
      return deliveryWork;
    };

    const appendLayer = async (current, projection, observation) => {
      if (active !== current) return null;
      const evidenceIds = validateProjection(projection);
      const sequence = await layerSequence.next(current.siteScope.scopeId);
      if (!Number.isInteger(sequence) || sequence <= current.sequence) {
        throw new Error('Layer sequence port must increase monotonically for the site scope');
      }
      current.sequence = sequence;
      const layerId = `layer_${current.siteScope.scopeId}_${sequence}`;
      const semanticXmlDigest = await digest(projection.semanticXml);
      const layer = {
        layerId,
        sequence,
        completedAt: now(),
        completionReason: completionReasonFor(observation),
        url: normalizeLayerUrl(projection.url, current.siteScope.origin),
        semanticXmlVersion: 'semantic-ui/2',
        semanticXmlDigest,
        semanticXml: projection.semanticXml,
        evidenceIds,
      };
      const completedLayer = {
        siteScope: clone(current.siteScope),
        layer,
        observation: observation ? {
          ...observation,
          outcome: observation.outcome,
        } : null,
        policy: clone(current.policy),
        privacy: await privacyFor(projection, digest),
      };
      if (active !== current) return null;
      current.lastLayerId = layerId;
      await spool.enqueue(completedLayer);
      onCompletedLayer(clone(completedLayer));
      void requestDelivery();
      return completedLayer;
    };

    const flushCompletedObservations = (current) => {
      captureWork = captureWork.then(async () => {
        if (active !== current || current.initialReady !== true) return null;
        let latestLayer = null;
        while (active === current) {
          while (current.discardedSequences.delete(current.nextCompletionSequence)) {
            current.nextCompletionSequence += 1;
          }
          const entry = [...current.pending.entries()].find(([, pending]) => (
            pending.observation.eventSequence === current.nextCompletionSequence
          ));
          if (!entry || !entry[1].boundary) return latestLayer;
          const [observationId, pending] = entry;
          current.pending.delete(observationId);
          clearTimer(pending.timer);
          const observation = {
            ...pending.observation,
            fromLayerId: current.lastLayerId,
            outcome: outcomeFrom(pending.boundary.outcome),
          };
          latestLayer = await appendLayer(
            current,
            pending.boundary.projection,
            observation,
          );
          current.nextCompletionSequence += 1;
        }
        return latestLayer;
      });
      return captureWork;
    };

    const beginObservation = (candidate) => {
      const current = active;
      if (!current || excludedObservation(candidate, { backgroundAllowed })) return null;
      current.eventSequence += 1;
      const observationId = `obs_${current.siteScope.scopeId}_${current.eventSequence}`;
      const observation = observationFrom(candidate, {
        eventSequence: current.eventSequence,
        fromLayerId: null,
        observationId,
      });
      if (!observation) {
        current.eventSequence -= 1;
        return null;
      }
      const timer = setTimer(() => {
        if (active !== current) return;
        current.pending.delete(observationId);
        current.discardedSequences.add(observation.eventSequence);
        current.connection?.discard?.(observationId, 'incomplete_layer_ttl');
        void flushCompletedObservations(current);
      }, incompleteLayerTtlMs);
      current.pending.set(observationId, {
        observation,
        observationId,
        timer,
        boundary: null,
      });
      return observationId;
    };

    const completeObservation = (observationId, boundary) => {
      const current = active;
      if (!current) return Promise.resolve(null);
      const pending = current.pending.get(observationId);
      if (!pending) return Promise.resolve(null);
      if (pending.boundary) return captureWork;
      pending.boundary = {
        outcome: outcomeFrom(boundary?.outcome),
        projection: boundary?.projection,
      };
      return flushCompletedObservations(current);
    };

    const start = async ({ siteScope, route = '/', documentContext = null, initialObservation = null } = {}) => {
      if (active) stop('document_replaced');
      const normalizedSiteScope = normalizeSiteScope(siteScope);
      const context = { siteScope: normalizedSiteScope, route };
      const decision = await currentDecision(context);
      if (!allowedDecision(decision)) {
        return { attached: false, reason: 'policy_denied' };
      }
      const current = {
        siteScope: normalizedSiteScope,
        route,
        documentContext,
        policy: normalizePolicy(decision),
        sequence: 0,
        eventSequence: 0,
        nextCompletionSequence: 1,
        lastLayerId: null,
        pending: new Map(),
        discardedSequences: new Set(),
        initialReady: false,
        connection: null,
      };
      active = current;
      current.connection = observer.attach({
        documentContext,
        onObservation: beginObservation,
        onSettled: completeObservation,
        onRevoked: revoke,
      });
      const initialProjection = await observer.captureInitial({ documentContext });
      const carriedObservation = initialObservation ? {
        ...initialObservation,
        outcome: { kind: 'navigation', evidenceIds: safeEvidenceIds(initialProjection.evidenceIds) },
      } : null;
      const completedLayer = await appendLayer(current, initialProjection, carriedObservation);
      if (!completedLayer) return { attached: false, reason: 'stopped_during_start' };
      current.initialReady = true;
      void flushCompletedObservations(current);
      return { attached: true, initialLayer: clone(completedLayer) };
    };

    const status = () => active ? {
      attached: true,
      scopeId: active.siteScope.scopeId,
      layerSequence: active.sequence,
      eventSequence: active.eventSequence,
      lastLayerId: active.lastLayerId,
      pendingLayers: active.pending.size,
    } : { attached: false };

    const whenIdle = async () => {
      await captureWork;
      while (deliveryWork) await deliveryWork;
    };

    return Object.freeze({
      beginObservation,
      completeObservation,
      requestDelivery,
      revoke,
      start,
      status,
      stop,
      whenIdle,
    });
  };

  return Object.freeze({
    AMBIENT_SCOPE,
    INCOMPLETE_LAYER_TTL_MS,
    createAmbientCapture,
    createMemoryLayerSequence,
    sha256,
  });
}));
