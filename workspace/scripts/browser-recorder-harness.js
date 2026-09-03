(() => {
  'use strict';

  const STORAGE_KEY = 'webmcp-demo-browser-recording';
  const { capturePageState, describeElement, diffStates, eventValue } = WebMcpSemantic;
  const Recorder = ActionMapperRecorder;
  const pendingCompletions = new Set();
  let recording = null;
  let pendingInput = null;

  const save = () => {
    if (recording) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(recording));
    }
  };

  const load = () => {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEY));
    } catch (error) {
      return null;
    }
  };

  const quietState = () => new Promise((resolve) => {
    let quietTimer;
    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(deadlineTimer);
      observer.disconnect();
      resolve(capturePageState());
    };
    const schedule = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, 350);
    };
    const observer = new MutationObserver(schedule);
    const deadlineTimer = setTimeout(finish, 2500);
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    schedule();
  });

  const interactiveTarget = (target) => target?.closest?.([
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'option',
    'select',
    'summary',
    'textarea',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
  ].join(','));

  const traceEvent = (kind, target, value) => ({
    id: crypto.randomUUID(),
    kind,
    occurredAt: new Date().toISOString(),
    target: describeElement(target),
    value,
  });

  const beginEvent = (kind, target, value, beforeState) => {
    if (!recording || recording.status !== 'recording') return null;
    const event = traceEvent(kind, target, value);
    recording = Recorder.beginEvent(recording, event, beforeState);
    save();
    return event;
  };

  const completeEvent = async (event, beforeState) => {
    if (!event) return;
    const afterState = await quietState();
    recording = Recorder.completeEvent(
      recording,
      event.id,
      afterState,
      diffStates(beforeState, afterState),
    );
    save();
  };

  const trackCompletion = (event, beforeState) => {
    const completion = completeEvent(event, beforeState).catch(() => {});
    pendingCompletions.add(completion);
    completion.finally(() => pendingCompletions.delete(completion));
  };

  const flushInput = () => {
    if (!pendingInput || !recording || recording.status !== 'recording') return;
    const input = pendingInput;
    pendingInput = null;
    clearTimeout(input.timer);
    const beforeState = input.beforeState;
    const afterState = capturePageState();
    const event = beginEvent('fill', input.target, eventValue(input.target), beforeState);
    if (!event) return;
    recording = Recorder.completeEvent(
      recording,
      event.id,
      afterState,
      diffStates(beforeState, afterState),
    );
    save();
  };

  const onInput = (event) => {
    if (!recording || recording.status !== 'recording') return;
    const target = interactiveTarget(event.target);
    if (!(target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || target?.isContentEditable)) {
      return;
    }
    if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type)) {
      return;
    }
    if (pendingInput?.target !== target) {
      flushInput();
      pendingInput = {
        target,
        beforeState: capturePageState(),
        timer: null,
      };
    }
    clearTimeout(pendingInput.timer);
    pendingInput.timer = setTimeout(flushInput, 500);
  };

  const onClick = (event) => {
    if (!recording || recording.status !== 'recording' || event.detail === 0) return;
    flushInput();
    const target = interactiveTarget(event.target);
    if (!target) return;
    const beforeState = capturePageState();
    const observed = beginEvent(
      'click',
      target,
      { redacted: false, value: null },
      beforeState,
    );
    trackCompletion(observed, beforeState);
  };

  const onKeyDown = (event) => {
    if (!recording || recording.status !== 'recording' || event.key !== 'Enter') return;
    flushInput();
    const target = interactiveTarget(event.target) || event.target;
    if (!(target instanceof Element)) return;
    const beforeState = capturePageState();
    const observed = beginEvent(
      'press',
      target,
      { redacted: false, value: 'Enter' },
      beforeState,
    );
    trackCompletion(observed, beforeState);
  };

  const initialize = () => {
    recording = load();
    if (recording?.status === 'recording') {
      recording = Recorder.completeNavigation(
        recording,
        capturePageState(),
        diffStates,
      );
      save();
    }
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', flushInput, true);
    document.addEventListener('keydown', onKeyDown, true);
  };

  const ready = document.readyState === 'loading'
    ? new Promise((resolve) => {
      document.addEventListener('DOMContentLoaded', () => {
        initialize();
        resolve();
      }, { once: true });
    })
    : Promise.resolve().then(initialize);

  globalThis.DemoTraceHarness = Object.freeze({
    async start() {
      await ready;
      recording = Recorder.createRecording({
        id: crypto.randomUUID(),
        tabId: 0,
        state: capturePageState(),
        startedAt: new Date().toISOString(),
      });
      save();
      return { recordingId: recording.id, startUrl: capturePageState().url };
    },
    async stop() {
      await ready;
      flushInput();
      await Promise.allSettled([...pendingCompletions]);
      const finalState = capturePageState();
      recording = Recorder.finishRecording(recording, finalState, new Date().toISOString());
      save();
      return Recorder.toTrace(recording);
    },
    async trace() {
      await ready;
      return recording ? Recorder.toTrace(recording) : null;
    },
    async status() {
      await ready;
      return recording ? {
        id: recording.id,
        status: recording.status,
        states: recording.stateOrder.length,
        steps: recording.steps.length,
        pending: Object.keys(recording.pendingEvents).length,
      } : null;
    },
    async reset() {
      await ready;
      recording = null;
      pendingInput = null;
      sessionStorage.removeItem(STORAGE_KEY);
    },
  });
})();
