(function initializeLearningBootstrap(root, factory) {
  root.WebMcpLearningBootstrap = factory(
    root.WebMcpProtocol,
    root.WebMcpErrors,
    root.WebMcpLearningSemantic || root.WebMcpSemantic,
    root.WebMcpLearningPrivacy || null,
  );
}(typeof globalThis === 'undefined' ? this : globalThis,
  (protocol, publicErrors, semantic, privacy) => {
  'use strict';

  const {
    capturePageState,
    describeElement,
    diffStates,
    eventValue,
  } = semantic;
  const { MESSAGE_TYPES, createMessage, isMessage, sendRuntimeMessage } = protocol;
  const pendingCompletions = new Set();
  let recordingId = null;
  let pendingInput = null;
  let started = false;

  const renderIndicator = () => {
    const active = Boolean(recordingId);
    document.documentElement.dataset.webMcpLearning = active ? 'recording' : 'idle';
    let indicator = document.querySelector('[data-webmcp-learning-ui="indicator"]');
    if (!active) {
      indicator?.remove();
      return;
    }
    if (indicator) return;
    indicator = document.createElement('div');
    indicator.dataset.webmcpLearningUi = 'indicator';
    indicator.setAttribute('role', 'status');
    indicator.textContent = '● Learning recording on';
    Object.assign(indicator.style, {
      background: '#171717',
      border: '1px solid rgba(255,255,255,.18)',
      borderRadius: '999px',
      bottom: '16px',
      boxShadow: '0 8px 24px rgba(0,0,0,.3)',
      color: '#fff',
      font: '600 12px/1 system-ui, sans-serif',
      left: '16px',
      padding: '10px 13px',
      pointerEvents: 'none',
      position: 'fixed',
      zIndex: '2147483647',
    });
    document.documentElement.append(indicator);
  };

  const sendMessage = (message) => sendRuntimeMessage(chrome.runtime, message);

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

  const createTraceEvent = (kind, target, value) => {
    if (!recordingId || globalThis.__webMcpRunnerActive || !(target instanceof Element)) {
      return null;
    }
    return {
      id: crypto.randomUUID(),
      kind,
      occurredAt: new Date().toISOString(),
      target: describeElement(target),
      value,
    };
  };

  const syntheticEvent = (event) => (
    globalThis.__webMcpActorActive === true
    || globalThis.__webMcpRunnerActive === true
    || event?.webMcpSynthetic === true
    || (privacy && event?.isTrusted === false)
  );

  const beginEvent = (kind, target, value, beforeState) => {
    const traceEvent = createTraceEvent(kind, target, value);
    if (!traceEvent) return null;
    chrome.runtime.sendMessage(createMessage(MESSAGE_TYPES.traceEventStarted, {
      recordingId,
      event: traceEvent,
      beforeState,
    }));
    return traceEvent;
  };

  const completeEvent = async (traceEvent, beforeState) => {
    if (!traceEvent) return;
    const afterState = await quietState();
    await sendMessage(createMessage(MESSAGE_TYPES.traceEventCompleted, {
      recordingId,
      eventId: traceEvent.id,
      delta: diffStates(beforeState, afterState),
      afterState,
    }));
  };

  const trackCompletion = (traceEvent, beforeState) => {
    const completion = completeEvent(traceEvent, beforeState).catch(() => {});
    pendingCompletions.add(completion);
    completion.finally(() => pendingCompletions.delete(completion));
  };

  const flushInput = async () => {
    if (!pendingInput) return;
    const input = pendingInput;
    pendingInput = null;
    clearTimeout(input.timer);
    const value = eventValue(input.target);
    const traceEvent = createTraceEvent('fill', input.target, value);
    if (!traceEvent) return;
    const afterState = capturePageState();
    await sendMessage(createMessage(MESSAGE_TYPES.traceEventStarted, {
      recordingId,
      event: traceEvent,
      beforeState: input.beforeState,
    }));
    await sendMessage(createMessage(MESSAGE_TYPES.traceEventCompleted, {
      recordingId,
      eventId: traceEvent.id,
      delta: diffStates(input.beforeState, afterState),
      afterState,
    }));
  };

  const onInput = (event) => {
    if (!recordingId || syntheticEvent(event)) return;
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
      void flushInput();
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
    if (!recordingId || syntheticEvent(event)) return;
    if (event.detail === 0) return;
    void flushInput();
    const target = interactiveTarget(event.target);
    if (!target) return;
    const beforeState = capturePageState();
    const traceEvent = beginEvent('click', target, { redacted: false, value: null }, beforeState);
    trackCompletion(traceEvent, beforeState);
  };

  const onKeyDown = (event) => {
    if (!recordingId || syntheticEvent(event) || event.key !== 'Enter') return;
    void flushInput();
    const target = interactiveTarget(event.target) || event.target;
    if (!(target instanceof Element)) return;
    const beforeState = capturePageState();
    const traceEvent = beginEvent('press', target, {
      redacted: false,
      value: 'Enter',
    }, beforeState);
    trackCompletion(traceEvent, beforeState);
  };

  const handleMessage = (message, _sender, sendResponse) => {
    if (isMessage(message, MESSAGE_TYPES.recordingStart)) {
      recordingId = message.recordingId;
      pendingInput = null;
      pendingCompletions.clear();
      renderIndicator();
      sendResponse({ ok: true });
      return false;
    }
    if (isMessage(message, MESSAGE_TYPES.recordingStop)) {
      flushInput()
        .then(() => Promise.allSettled([...pendingCompletions]))
        .then(() => {
          recordingId = null;
          renderIndicator();
          sendResponse({ ok: true, finalState: capturePageState() });
        })
        .catch((error) => sendResponse(publicErrors.legacyResponseFor(error)));
      return true;
    }
    if (isMessage(message, MESSAGE_TYPES.getPageState)) {
      sendResponse({ ok: true, state: capturePageState() });
      return false;
    }
    return undefined;
  };

  const initialize = async () => {
    const response = await sendMessage(createMessage(MESSAGE_TYPES.pageReady, {
      state: capturePageState(),
    }));
    if (response?.recordingActive) {
      recordingId = response.recordingId;
    }
    renderIndicator();
    // WebMCP registration is intentionally paused while the discovery pipeline is validated.
  };

  const start = () => {
    if (started) return;
    started = true;
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', flushInput, true);
    document.addEventListener('keydown', onKeyDown, true);
  };

  return {
    handleMessage,
    initialize,
    start,
    status: () => ({
      recordingId,
      state: recordingId ? 'recording' : 'idle',
      indicatorVisible: Boolean(document.querySelector('[data-webmcp-learning-ui="indicator"]')),
    }),
  };
}));
