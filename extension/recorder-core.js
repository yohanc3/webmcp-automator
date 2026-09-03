(function initializeRecorderCore(root, factory) {
  const recorder = factory();
  root.ActionMapperRecorder = recorder;
  if (typeof module === 'object' && module.exports) {
    module.exports = recorder;
  }
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const INPUT_ROLES = new Set([
    'combobox',
    'listbox',
    'searchbox',
    'spinbutton',
    'textbox',
  ]);

  const stateKey = (state) => {
    if (!state?.fingerprint) {
      throw new Error('A captured page state must have a fingerprint');
    }
    return state.fingerprint;
  };

  const appendState = (recording, state) => {
    const fingerprint = stateKey(state);
    if (recording.states[fingerprint]) return recording;
    return {
      ...recording,
      stateOrder: [...recording.stateOrder, fingerprint],
      states: {
        ...recording.states,
        [fingerprint]: state,
      },
    };
  };

  const createRecording = ({ id, tabId, state, startedAt }) => ({
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
  });

  const beginEvent = (recording, event, beforeState) => {
    if (!recording || recording.status !== 'recording' || !event?.id) return recording;
    const withState = appendState(recording, beforeState);
    return {
      ...withState,
      pendingEvents: {
        ...withState.pendingEvents,
        [event.id]: {
          event,
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
    const step = {
      sequence: pending.sequence,
      event: pending.event,
      fromStateFingerprint: pending.fromStateFingerprint,
      toStateFingerprint: stateKey(afterState),
      delta,
    };
    return {
      ...withState,
      pendingEvents,
      steps: [...withState.steps, step].sort((left, right) => left.sequence - right.sequence),
      finalStateFingerprint: stateKey(afterState),
    };
  };

  const completeNavigation = (recording, afterState, diffStates) => {
    if (!recording || recording.status !== 'recording') return recording;
    return Object.keys(recording.pendingEvents)
      .sort((left, right) => (
        recording.pendingEvents[left].sequence - recording.pendingEvents[right].sequence
      ))
      .reduce((current, eventId) => {
        const pending = current.pendingEvents[eventId];
        if (!pending) return current;
        const beforeState = current.states[pending.fromStateFingerprint];
        return completeEvent(current, eventId, afterState, diffStates(beforeState, afterState));
      }, recording);
  };

  const finishRecording = (recording, finalState, stoppedAt) => {
    const withState = appendState(recording, finalState);
    return {
      ...withState,
      status: 'ready',
      stoppedAt,
      finalStateFingerprint: stateKey(finalState),
      pendingEvents: {},
    };
  };

  const targetKey = (event) => {
    const target = event?.target || {};
    return target.id
      || target.css
      || [target.role, target.name, target.attributes?.placeholder].filter(Boolean).join('|');
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
    added: [...(first?.added || []), ...(second?.added || [])].slice(0, 160),
    removed: [...(first?.removed || []), ...(second?.removed || [])].slice(0, 100),
    changed: [...(first?.changed || []), ...(second?.changed || [])].slice(0, 100),
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
      const isRepeatedFill = previous?.event.kind === 'fill'
        && step.event.kind === 'fill'
        && targetKey(previous.event) === targetKey(step.event)
        && previous.toStateFingerprint === step.fromStateFingerprint
        && previous.delta?.urlChanged !== true
        && step.delta?.urlChanged !== true;
      if (!isRepeatedFill) {
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

  const compactAttributes = (attributes = {}) => Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== null && value !== ''),
  );

  const compactNode = (node) => {
    const output = {
      id: node.id,
      tag: node.tag,
      role: node.role || null,
      name: node.name || null,
      css: node.css || null,
      shadowHost: node.shadowHost || null,
      attributes: compactAttributes(node.attributes),
      interaction: node.interaction || null,
      context: node.parentContext || null,
      rect: node.rect || null,
    };
    if (node.text && node.text !== node.name) output.text = node.text;
    return output;
  };

  const compactCollection = (collection) => ({
    parentCss: collection.parentCss || null,
    itemCss: collection.itemCss || null,
    count: collection.count,
    sample: (collection.sample || []).map((item) => ({
      name: item.name || null,
      text: item.text && item.text !== item.name ? item.text : null,
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
    truncated: state.truncated === true,
  });

  const compactTarget = (target = {}) => ({
    id: target.id || null,
    tag: target.tag || null,
    role: target.role || null,
    name: target.name || null,
    css: target.css || null,
    shadowHost: target.shadowHost || null,
    attributes: compactAttributes(target.attributes),
    interaction: target.interaction || null,
    rect: target.rect || null,
  });

  const compactChangedNode = (change) => ({
    before: compactNode(change.before || {}),
    after: compactNode(change.after || {}),
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

    const appendPageFrame = (fingerprint) => {
      const id = ids.get(fingerprint);
      const state = recording.states[fingerprint];
      const reused = seenPages.has(id);
      const page = reused
        ? { id, fingerprint, reused: true }
        : compactPage(state, id);
      frames.push({ sequence: nextFrameSequence, type: 'page', page });
      if (!reused) {
        seenPages.add(id);
        pages.push({ id, fingerprint, firstFrameSequence: nextFrameSequence });
      }
      nextFrameSequence += 1;
      return id;
    };

    let currentPageId = appendPageFrame(recording.initialStateFingerprint);
    steps.forEach((step, index) => {
      const fromPageId = ids.get(step.fromStateFingerprint);
      const toPageId = ids.get(step.toStateFingerprint);
      if (currentPageId !== fromPageId) currentPageId = appendPageFrame(step.fromStateFingerprint);

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

      currentPageId = appendPageFrame(step.toStateFingerprint);
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

  const stateFor = (recording, fingerprint) => recording?.states?.[fingerprint] || null;

  return {
    beginEvent,
    completeEvent,
    completeNavigation,
    createRecording,
    finishRecording,
    normalizeSteps,
    stateFor,
    toTrace,
  };
}));
