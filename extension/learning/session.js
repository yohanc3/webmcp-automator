(function initializeLearningSession(root, factory) {
  const session = factory(
    root.WebMcpLearningPrivacy,
    root.WebMcpLearningSemantic,
    root.WebMcpLearningRecorder,
  );
  root.WebMcpLearningSession = session;
  if (typeof module === 'object' && module.exports) {
    module.exports = session;
  }
}(typeof globalThis === 'undefined' ? this : globalThis, (privacy, semantic, recorder) => {
  'use strict';

  if (!privacy || !semantic || !recorder) {
    throw new Error('Learning privacy, semantic, and recorder modules must load before sessions');
  }

  const DEFAULT_STORAGE_KEY = 'webmcp-learning-session-v3';
  const INTERACTIVE_SELECTOR = [
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
  ].join(',');

  const createSession = ({
    document = globalThis.document,
    storage = globalThis.sessionStorage,
    storageKey = DEFAULT_STORAGE_KEY,
    id = () => crypto.randomUUID(),
    now = () => new Date().toISOString(),
    acceptUntrustedEvents = false,
    quietMs = 250,
    quietDeadlineMs = 2000,
  } = {}) => {
    let ledger = privacy.createLedger();
    const pendingCompletions = new Set();
    let recording = null;
    let pendingInput = null;
    let listenersInstalled = false;
    let stopPromise = null;

    const capture = () => semantic.capturePageState({ document, ledger });

    const updateRedactions = () => {
      if (recording) recording.redactions = privacy.sanitizeLedgerSummary(ledger);
    };

    const save = () => {
      if (!recording) return;
      updateRedactions();
      storage.setItem(storageKey, JSON.stringify(recording));
    };

    const load = () => {
      try {
        const parsed = JSON.parse(storage.getItem(storageKey));
        return parsed?.status === 'recording' ? parsed : null;
      } catch (error) {
        return null;
      }
    };

    const renderIndicator = () => {
      const active = recording?.status === 'recording';
      document.documentElement.dataset.webMcpLearning = active ? 'recording' : 'idle';
      let indicator = document.querySelector('[data-webmcp-learning-ui="indicator"]');
      if (!active) {
        indicator?.remove();
        return;
      }
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.dataset.webmcpLearningUi = 'indicator';
        indicator.setAttribute('role', 'status');
        indicator.setAttribute('aria-live', 'polite');
        Object.assign(indicator.style, {
          alignItems: 'center',
          background: '#171717',
          border: '1px solid rgba(255,255,255,.18)',
          borderRadius: '999px',
          bottom: '16px',
          boxShadow: '0 8px 24px rgba(0,0,0,.3)',
          color: '#fff',
          display: 'flex',
          font: '600 12px/1 system-ui, sans-serif',
          gap: '8px',
          left: '16px',
          padding: '10px 13px',
          pointerEvents: 'none',
          position: 'fixed',
          zIndex: '2147483647',
        });
        const dot = document.createElement('span');
        dot.setAttribute('aria-hidden', 'true');
        Object.assign(dot.style, {
          background: '#ff4d4f',
          borderRadius: '50%',
          height: '8px',
          width: '8px',
        });
        const label = document.createElement('span');
        label.textContent = 'Learning recording on';
        indicator.append(dot, label);
        document.documentElement.append(indicator);
      }
    };

    const interactiveTarget = (target) => target?.closest?.(INTERACTIVE_SELECTOR);

    const synthetic = (event) => (
      globalThis.__webMcpActorActive === true
      || globalThis.__webMcpRunnerActive === true
      || event?.webMcpSynthetic === true
      || (!acceptUntrustedEvents && event?.isTrusted === false)
    );

    const traceEvent = (kind, target, value) => ({
      id: id(),
      kind,
      occurredAt: now(),
      synthetic: false,
      target: semantic.describeElement(target, {
        argumentsByValue: privacy.collectArguments(document),
        ledger,
      }),
      value,
    });

    const begin = (kind, target, value, beforeState) => {
      if (recording?.status !== 'recording') return null;
      const observed = traceEvent(kind, target, value);
      recording = recorder.beginEvent(recording, observed, beforeState);
      save();
      return observed;
    };

    const quietState = () => new Promise((resolve) => {
      let quietTimer;
      const finish = () => {
        clearTimeout(quietTimer);
        clearTimeout(deadlineTimer);
        observer.disconnect();
        resolve(capture());
      };
      const schedule = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      };
      const observer = new document.defaultView.MutationObserver(schedule);
      const deadlineTimer = setTimeout(finish, quietDeadlineMs);
      observer.observe(document.documentElement, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      schedule();
    });

    const complete = async (observed, beforeState, deferMs = 0) => {
      if (!observed) return;
      if (deferMs > 0) {
        await new Promise((resolve) => { setTimeout(resolve, deferMs); });
      }
      const afterState = await quietState();
      if (recording?.status !== 'recording') return;
      recording = recorder.completeEvent(
        recording,
        observed.id,
        afterState,
        semantic.diffStates(beforeState, afterState),
      );
      save();
    };

    const trackCompletion = (observed, beforeState, deferMs = 0) => {
      const completion = complete(observed, beforeState, deferMs).catch(() => {});
      pendingCompletions.add(completion);
      completion.finally(() => pendingCompletions.delete(completion));
    };

    const expectsNavigation = (target) => {
      if (target.localName === 'a' && target.hasAttribute('href')) return true;
      if (target.localName === 'button' && (target.type || 'submit') === 'submit') {
        return Boolean(target.form);
      }
      return Boolean(target.form && target.localName === 'input');
    };

    const flushInput = () => {
      if (!pendingInput || recording?.status !== 'recording') return;
      const input = pendingInput;
      pendingInput = null;
      clearTimeout(input.timer);
      const rawValue = 'value' in input.target
        ? input.target.value
        : input.target.textContent;
      const value = semantic.eventValue(input.target, ledger);
      recording = privacy.redactArgument(recording, rawValue, value.token, ledger);
      const beforeState = privacy.redactArgument(
        input.beforeState,
        rawValue,
        value.token,
        ledger,
      );
      const afterState = capture();
      const observed = begin(
        'fill',
        input.target,
        value,
        beforeState,
      );
      if (!observed) return;
      recording = recorder.completeEvent(
        recording,
        observed.id,
        afterState,
        semantic.diffStates(beforeState, afterState),
      );
      save();
    };

    const onInput = (event) => {
      if (recording?.status !== 'recording' || synthetic(event)) return;
      const target = interactiveTarget(event.target);
      if (!target || !('value' in target || target.isContentEditable)) return;
      if (target.localName === 'input' && ['checkbox', 'radio'].includes(target.type)) return;
      if (pendingInput?.target !== target) {
        flushInput();
        pendingInput = {
          target,
          beforeState: recorder.stateFor(recording, recording.finalStateFingerprint) || capture(),
          timer: null,
        };
      }
      clearTimeout(pendingInput.timer);
      pendingInput.timer = setTimeout(flushInput, 400);
    };

    const onClick = (event) => {
      if (recording?.status !== 'recording' || synthetic(event) || event.detail === 0) return;
      flushInput();
      const target = interactiveTarget(event.target);
      if (!target) return;
      const beforeState = capture();
      const observed = begin('click', target, {
        redacted: false,
        value: null,
        valueType: 'null',
      }, beforeState);
      trackCompletion(observed, beforeState, expectsNavigation(target) ? 350 : 0);
    };

    const onKeyDown = (event) => {
      if (recording?.status !== 'recording' || synthetic(event) || event.key !== 'Enter') return;
      flushInput();
      const target = interactiveTarget(event.target) || event.target;
      if (!(target instanceof document.defaultView.Element)) return;
      const beforeState = capture();
      const observed = begin('press', target, {
        redacted: false,
        value: 'Enter',
        valueType: 'key',
      }, beforeState);
      trackCompletion(observed, beforeState, expectsNavigation(target) ? 350 : 0);
    };

    const installListeners = () => {
      if (listenersInstalled) return;
      listenersInstalled = true;
      document.addEventListener('click', onClick, true);
      document.addEventListener('input', onInput, true);
      document.addEventListener('change', flushInput, true);
      document.addEventListener('keydown', onKeyDown, true);
    };

    const initialize = () => {
      installListeners();
      recording = load();
      if (recording) {
        ledger = privacy.createLedger(recording.redactions);
        const current = capture();
        recording = recorder.completeNavigation(recording, current, semantic.diffStates);
        save();
      }
      renderIndicator();
      return recording;
    };

    const start = () => {
      if (recording?.status === 'recording') return recording.id;
      recording = recorder.createRecording({
        id: id(),
        tabId: 0,
        state: capture(),
        startedAt: now(),
        ledger,
      });
      save();
      renderIndicator();
      return recording.id;
    };

    const stop = () => {
      if (stopPromise) return stopPromise;
      if (recording?.status !== 'recording') return Promise.resolve(null);
      flushInput();
      stopPromise = Promise.allSettled([...pendingCompletions]).then(() => {
        const finalState = capture();
        recording = recorder.finishRecording(
          recording,
          finalState,
          now(),
          semantic.diffStates,
        );
        updateRedactions();
        save();
        renderIndicator();
        return recorder.toTrace(recording);
      }).finally(() => { stopPromise = null; });
      return stopPromise;
    };

    const status = () => recording ? {
      id: recording.id,
      status: recording.status,
      states: recording.stateOrder.length,
      steps: recording.steps.length,
      pending: Object.keys(recording.pendingEvents).length,
      indicator: document.documentElement.dataset.webMcpLearning,
      redactions: privacy.sanitizeLedgerSummary(recording.redactions),
    } : null;

    const trace = () => recording ? recorder.toTrace(recording) : null;

    const debug = () => recording ? recorder.debugArtifact(recording) : null;

    const downloadDebug = () => {
      if (!recording) throw new Error('There is no learning recording to download');
      return privacy.downloadDebugArtifact(
        recorder.toTrace(recording),
        recording.redactions,
        { document },
      );
    };

    const reset = () => {
      pendingInput = null;
      recording = null;
      storage.removeItem(storageKey);
      renderIndicator();
    };

    const destroy = () => {
      if (!listenersInstalled) return;
      listenersInstalled = false;
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('change', flushInput, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };

    return Object.freeze({
      debug,
      destroy,
      downloadDebug,
      initialize,
      reset,
      start,
      status,
      stop,
      trace,
    });
  };

  return Object.freeze({ createSession });
}));
