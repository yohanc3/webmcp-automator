(function initializeLearningRecorder(root, factory) {
  const recorder = factory(root.WebMcpLearningPrivacy);
  root.WebMcpLearningRecorder = recorder;
  if (typeof module === 'object' && module.exports) {
    module.exports = recorder;
  }
}(typeof globalThis === 'undefined' ? this : globalThis, (privacy) => {
  'use strict';

  if (!privacy) throw new Error('WebMcpLearningPrivacy must load before the learning recorder');

  const INPUT_ROLES = new Set(['combobox', 'listbox', 'searchbox', 'spinbutton', 'textbox']);

  const stateKey = (state) => {
    if (!state?.fingerprint) throw new Error('A captured page state must have a fingerprint');
    return state.fingerprint;
  };

  const appendState = (recording, state) => {
    const fingerprint = stateKey(state);
    if (recording.states[fingerprint]) return recording;
    return {
      ...recording,
      stateOrder: [...recording.stateOrder, fingerprint],
      states: { ...recording.states, [fingerprint]: state },
    };
  };

  const createRecording = ({ id, tabId, state, startedAt, ledger }) => ({
    id,
    tabId,
    status: 'recording',
    startedAt,
    stoppedAt: null,
    initialStateFingerprint: stateKey(state),
    finalStateFingerprint: stateKey(state),
    stateOrder: [stateKey(state)],
    states: { [stateKey(state)]: state },
    steps: [],
    pendingEvents: {},
    nextSequence: 1,
    redactions: privacy.sanitizeLedgerSummary(ledger),
  });

  const beginEvent = (recording, event, beforeState) => {
    if (!recording || recording.status !== 'recording' || !event?.id || event.synthetic === true) {
      return recording;
    }
    const withState = appendState(recording, beforeState);
    return {
      ...withState,
      pendingEvents: {
        ...withState.pendingEvents,
        [event.id]: {
          event: {
            id: event.id,
            kind: event.kind,
            occurredAt: event.occurredAt,
            target: event.target,
            value: event.value,
          },
          fromStateFingerprint: stateKey(beforeState),
          sequence: withState.nextSequence,
        },
      },
      finalStateFingerprint: stateKey(beforeState),
      nextSequence: withState.nextSequence + 1,
    };
  };

  const completeEvent = (recording, eventId, afterState, delta) => {
    const pending = recording?.pendingEvents?.[eventId];
    if (!pending) return recording;
    const withState = appendState(recording, afterState);
    const pendingEvents = { ...withState.pendingEvents };
    delete pendingEvents[eventId];
    return {
      ...withState,
      pendingEvents,
      steps: [...withState.steps, {
        sequence: pending.sequence,
        event: pending.event,
        fromStateFingerprint: pending.fromStateFingerprint,
        toStateFingerprint: stateKey(afterState),
        delta,
      }].sort((left, right) => left.sequence - right.sequence),
      finalStateFingerprint: stateKey(afterState),
    };
  };

  const completePending = (recording, afterState, diffStates) => Object.keys(
    recording?.pendingEvents || {},
  ).sort((left, right) => (
    recording.pendingEvents[left].sequence - recording.pendingEvents[right].sequence
  )).reduce((current, eventId) => {
    const pending = current.pendingEvents[eventId];
    if (!pending) return current;
    const beforeState = current.states[pending.fromStateFingerprint];
    return completeEvent(current, eventId, afterState, diffStates(beforeState, afterState));
  }, recording);

  const completeNavigation = (recording, afterState, diffStates) => {
    if (!recording || recording.status !== 'recording') return recording;
    return completePending(recording, afterState, diffStates);
  };

  const finishRecording = (recording, finalState, stoppedAt, diffStates) => {
    if (!recording || recording.status !== 'recording') return recording;
    const completed = diffStates
      ? completePending(recording, finalState, diffStates)
      : appendState(recording, finalState);
    return {
      ...completed,
      status: 'ready',
      stoppedAt,
      finalStateFingerprint: stateKey(finalState),
      pendingEvents: {},
    };
  };

  const targetKey = (event) => {
    const target = event?.target || {};
    return target.id || target.css || [target.role, target.name].filter(Boolean).join('|');
  };

  const hasMaterialUpdate = (step) => (
    step.delta?.urlChanged === true
    || step.delta?.collectionsChanged === true
    || (step.delta?.added?.length || 0) > 0
    || (step.delta?.removed?.length || 0) > 0
    || (step.delta?.changed?.length || 0) > 0
  );

  const mergeDeltas = (first, second) => ({
    ...second,
    beforeUrl: first?.beforeUrl || null,
    beforeTitle: first?.beforeTitle || null,
    beforeFingerprint: first?.beforeFingerprint || null,
    urlChanged: first?.beforeUrl !== second?.afterUrl,
    titleChanged: first?.beforeTitle !== second?.afterTitle,
    added: [...(first?.added || []), ...(second?.added || [])].slice(0, 100),
    removed: [...(first?.removed || []), ...(second?.removed || [])].slice(0, 60),
    changed: [...(first?.changed || []), ...(second?.changed || [])].slice(0, 60),
    collectionsChanged: first?.collectionsChanged === true || second?.collectionsChanged === true,
  });

  const normalizeSteps = (recording) => {
    const ordered = [...recording.steps].sort((left, right) => left.sequence - right.sequence);
    const withoutFocusClicks = ordered.filter((step, index) => {
      const next = ordered[index + 1];
      return !(
        step.event.kind === 'click'
        && INPUT_ROLES.has(step.event.target?.role)
        && !hasMaterialUpdate(step)
        && next?.event.kind === 'fill'
        && targetKey(step.event) === targetKey(next.event)
      );
    });
    return withoutFocusClicks.reduce((normalized, step) => {
      const previous = normalized[normalized.length - 1];
      const repeatedFill = previous?.event.kind === 'fill'
        && step.event.kind === 'fill'
        && targetKey(previous.event) === targetKey(step.event)
        && previous.toStateFingerprint === step.fromStateFingerprint
        && previous.delta?.urlChanged !== true
        && step.delta?.urlChanged !== true;
      if (!repeatedFill) {
        normalized.push(step);
        return normalized;
      }
      normalized[normalized.length - 1] = {
        ...previous,
        event: step.event,
        fromStateFingerprint: previous.fromStateFingerprint,
        toStateFingerprint: step.toStateFingerprint,
        delta: mergeDeltas(previous.delta, step.delta),
      };
      return normalized;
    }, []);
  };

  const compactAttributes = (attributes = {}) => privacy.sanitizeAttributes(attributes);

  const compactNode = (node = {}) => ({
    id: node.id || null,
    tag: node.tag || null,
    role: node.role || null,
    name: node.name || null,
    text: node.text || null,
    css: node.css || null,
    attributes: compactAttributes(node.attributes),
    interaction: node.interaction || null,
    context: node.context || null,
    rect: node.rect || null,
  });

  const compactCollection = (collection = {}) => ({
    parentCss: collection.parentCss || null,
    itemCss: collection.itemCss || null,
    count: collection.count || 0,
    sample: (collection.sample || []).map((item) => ({
      name: item.name || null,
      text: item.text || null,
      attributes: compactAttributes(item.attributes),
    })),
  });

  const compactPage = (state, id) => ({
    id,
    fingerprint: state.fingerprint,
    url: state.url,
    title: state.title,
    viewport: state.viewport,
    nodes: (state.nodes || []).map(compactNode),
    collections: (state.collections || []).map(compactCollection),
    semanticXml: state.semanticXml || null,
    truncated: state.truncated === true,
  });

  const compactTarget = (target = {}) => ({
    id: target.id || null,
    tag: target.tag || null,
    role: target.role || null,
    name: target.name || null,
    css: target.css || null,
    attributes: compactAttributes(target.attributes),
    interaction: target.interaction || null,
    rect: target.rect || null,
  });

  const compactChangedNode = (change) => ({
    before: compactNode(change.before),
    after: compactNode(change.after),
  });

  const compactDelta = (delta = {}) => ({
    urlChanged: delta.urlChanged === true,
    beforeUrl: delta.beforeUrl || null,
    afterUrl: delta.afterUrl || null,
    titleChanged: delta.titleChanged === true,
    added: (delta.added || []).map(compactNode),
    removed: (delta.removed || []).map(compactNode),
    changed: (delta.changed || []).map(compactChangedNode),
    collectionsChanged: delta.collectionsChanged === true,
    collections: (delta.collections || []).map(compactCollection),
  });

  const pageIds = (recording) => new Map(recording.stateOrder.map((fingerprint, index) => (
    [fingerprint, `page_${index + 1}`]
  )));

  const toTrace = (recording) => {
    const steps = normalizeSteps(recording);
    const ids = pageIds(recording);
    const frames = [];
    const seenPages = new Set();
    const pages = [];
    const transitions = [];
    let nextFrameSequence = 1;
    const appendPage = (fingerprint) => {
      const id = ids.get(fingerprint);
      const reused = seenPages.has(id);
      frames.push({
        sequence: nextFrameSequence,
        type: 'page',
        page: reused
          ? { id, fingerprint, reused: true }
          : compactPage(recording.states[fingerprint], id),
      });
      if (!reused) {
        seenPages.add(id);
        pages.push({ id, fingerprint, firstFrameSequence: nextFrameSequence });
      }
      nextFrameSequence += 1;
      return id;
    };
    let currentPageId = appendPage(recording.initialStateFingerprint);
    steps.forEach((step, index) => {
      const fromPageId = ids.get(step.fromStateFingerprint);
      const toPageId = ids.get(step.toStateFingerprint);
      if (currentPageId !== fromPageId) currentPageId = appendPage(step.fromStateFingerprint);
      const actionId = `action_${index + 1}`;
      const actionFrameSequence = nextFrameSequence;
      frames.push({
        sequence: nextFrameSequence,
        type: 'action',
        fromPageId,
        action: {
          id: actionId,
          kind: step.event.kind,
          occurredAt: step.event.occurredAt,
          target: compactTarget(step.event.target),
          value: step.event.value,
        },
      });
      nextFrameSequence += 1;
      const updateFrameSequence = nextFrameSequence;
      frames.push({
        sequence: nextFrameSequence,
        type: 'update',
        actionId,
        fromPageId,
        toPageId,
        update: compactDelta(step.delta),
      });
      nextFrameSequence += 1;
      currentPageId = appendPage(step.toStateFingerprint);
      transitions.push({
        id: `transition_${index + 1}`,
        fromPageId,
        actionId,
        actionFrameSequence,
        updateFrameSequence,
        toPageId,
      });
    });
    return {
      schemaVersion: 'learning-trace/3',
      recordingId: recording.id,
      startedAt: recording.startedAt,
      stoppedAt: recording.stoppedAt,
      frames,
      actionTree: {
        kind: 'directed_action_graph',
        rootPageId: ids.get(recording.initialStateFingerprint),
        finalPageId: ids.get(recording.finalStateFingerprint),
        pages,
        transitions,
      },
    };
  };

  const debugArtifact = (recording) => privacy.createDebugArtifact(
    toTrace(recording),
    recording.redactions,
  );

  const stateFor = (recording, fingerprint) => recording?.states?.[fingerprint] || null;

  return Object.freeze({
    beginEvent,
    completeEvent,
    completeNavigation,
    createRecording,
    debugArtifact,
    finishRecording,
    normalizeSteps,
    stateFor,
    toTrace,
  });
}));
