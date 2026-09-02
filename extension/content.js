(() => {
  'use strict';

  const { capturePageState, describeElement, diffStates, eventValue } = WebMcpSemantic;
  const { buildInputSchema, manifestMatchesLocation } = WebMcpManifest;
  const registrationControllers = new Map();
  const pendingCompletions = new Set();
  let recordingId = null;
  let pendingInput = null;

  const sendMessage = (message) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });

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

  const beginEvent = (kind, target, value, beforeState) => {
    const traceEvent = createTraceEvent(kind, target, value);
    if (!traceEvent) return null;
    chrome.runtime.sendMessage({
      type: 'TRACE_EVENT_STARTED',
      recordingId,
      event: traceEvent,
      beforeState,
    });
    return traceEvent;
  };

  const completeEvent = async (traceEvent, beforeState) => {
    if (!traceEvent) return;
    const afterState = await quietState();
    await sendMessage({
      type: 'TRACE_EVENT_COMPLETED',
      recordingId,
      eventId: traceEvent.id,
      delta: diffStates(beforeState, afterState),
      afterState,
    });
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
    await sendMessage({
      type: 'TRACE_EVENT_STARTED',
      recordingId,
      event: traceEvent,
      beforeState: input.beforeState,
    });
    await sendMessage({
      type: 'TRACE_EVENT_COMPLETED',
      recordingId,
      eventId: traceEvent.id,
      delta: diffStates(input.beforeState, afterState),
      afterState,
    });
  };

  const onInput = (event) => {
    if (!recordingId || globalThis.__webMcpRunnerActive) return;
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
    if (!recordingId || globalThis.__webMcpRunnerActive) return;
    if (event.detail === 0) return;
    void flushInput();
    const target = interactiveTarget(event.target);
    if (!target) return;
    const beforeState = capturePageState();
    const traceEvent = beginEvent('click', target, { redacted: false, value: null }, beforeState);
    trackCompletion(traceEvent, beforeState);
  };

  const onKeyDown = (event) => {
    if (!recordingId || globalThis.__webMcpRunnerActive || event.key !== 'Enter') return;
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

  const waitForJob = async (jobId, signal) => {
    while (!signal?.aborted) {
      const response = await sendMessage({ type: 'GET_JOB', jobId });
      if (!response?.ok) {
        throw new Error(response?.error || 'The adapter job disappeared');
      }
      if (response.job.status === 'completed') return response.job.result;
      if (response.job.status === 'failed') throw new Error(response.job.error);
      await new Promise((resolve) => { setTimeout(resolve, 200); });
    }
    throw new DOMException('The WebMCP execution was cancelled', 'AbortError');
  };

  const registerAdapters = async () => {
    registrationControllers.forEach((controller) => controller.abort());
    registrationControllers.clear();
    if (!document.modelContext?.registerTool) {
      await sendMessage({ type: 'WEBMCP_STATUS', available: false }).catch(() => {});
      return;
    }
    const response = await sendMessage({
      type: 'GET_ADAPTERS',
      origin: window.location.origin,
    });
    if (!response?.ok) return;

    const matching = response.adapters.filter(({ manifest }) => (
      manifestMatchesLocation(manifest, window.location.href)
    ));
    for (const adapter of matching) {
      const controller = new AbortController();
      registrationControllers.set(adapter.versionId, controller);
      await document.modelContext.registerTool({
        name: adapter.manifest.tool.name,
        description: adapter.manifest.tool.description,
        inputSchema: buildInputSchema(adapter.manifest.tool),
        annotations: {
          readOnlyHint: adapter.manifest.tool.annotations.readOnlyHint,
          untrustedContentHint: adapter.manifest.tool.annotations.untrustedContentHint,
        },
        execute: async (args, client = {}) => {
          const started = await sendMessage({
            type: 'START_JOB',
            adapter,
            args,
            sourceUrl: window.location.href,
          });
          if (!started?.ok) {
            throw new Error(started?.error || 'Could not start the adapter job');
          }
          return waitForJob(started.jobId, client.signal);
        },
      }, { signal: controller.signal });
    }
    await sendMessage({
      type: 'WEBMCP_STATUS',
      available: true,
      registered: matching.length,
    }).catch(() => {});
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'RECORDING_START') {
      recordingId = message.recordingId;
      pendingInput = null;
      pendingCompletions.clear();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === 'RECORDING_STOP') {
      flushInput()
        .then(() => Promise.allSettled([...pendingCompletions]))
        .then(() => {
          recordingId = null;
          sendResponse({ ok: true, finalState: capturePageState() });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'GET_PAGE_STATE') {
      sendResponse({ ok: true, state: capturePageState() });
      return false;
    }
    if (message.type === 'EXECUTE_STEP') {
      WebMcpRunner.executeStep(message.step, message.args, message.tool)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'REFRESH_ADAPTERS') {
      registerAdapters()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });

  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', flushInput, true);
  document.addEventListener('keydown', onKeyDown, true);

  const initialize = async () => {
    const response = await sendMessage({ type: 'PAGE_READY', state: capturePageState() });
    if (response?.recordingActive) {
      recordingId = response.recordingId;
    }
    // WebMCP registration is intentionally paused while the discovery pipeline is validated.
  };

  void initialize().catch(() => {
    // The extension can still record after the service worker restarts or the backend comes online.
  });
})();
