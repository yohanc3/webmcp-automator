(function initializeRecorderCore(root, factory) {
  const recorder = factory();
  root.ActionMapperRecorder = recorder;
  if (typeof module === 'object' && module.exports) {
    module.exports = recorder;
  }
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

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

  const observedPath = (recording) => recording.steps.map((step) => {
    const before = recording.states[step.fromStateFingerprint];
    const after = recording.states[step.toStateFingerprint];
    return {
      sequence: step.sequence,
      event: step.event,
      fromStateFingerprint: step.fromStateFingerprint,
      toStateFingerprint: step.toStateFingerprint,
      transition: {
        urlChanged: step.delta?.urlChanged === true,
        beforeUrl: before?.url || step.delta?.beforeUrl || null,
        afterUrl: after?.url || step.delta?.afterUrl || null,
        addedNodes: step.delta?.added?.length || 0,
        removedNodes: step.delta?.removed?.length || 0,
        changedNodes: step.delta?.changed?.length || 0,
        collectionsChanged: step.delta?.collectionsChanged === true,
      },
    };
  });

  const toTrace = (recording) => ({
    schemaVersion: 'learning-trace/2',
    recordingId: recording.id,
    startedAt: recording.startedAt,
    stoppedAt: recording.stoppedAt,
    initialStateFingerprint: recording.initialStateFingerprint,
    finalStateFingerprint: recording.finalStateFingerprint,
    states: recording.stateOrder.map((fingerprint) => recording.states[fingerprint]),
    steps: recording.steps,
    observedPath: observedPath(recording),
  });

  const stateFor = (recording, fingerprint) => recording?.states?.[fingerprint] || null;

  return {
    beginEvent,
    completeEvent,
    completeNavigation,
    createRecording,
    finishRecording,
    observedPath,
    stateFor,
    toTrace,
  };
}));
