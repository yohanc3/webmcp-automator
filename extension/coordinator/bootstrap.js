(function initializeCoordinatorBootstrap(root, factory) {
  root.WebMcpCoordinatorBootstrap = factory(
    root.WebMcpProtocol,
    root.WebMcpErrors,
  );
}(typeof globalThis === 'undefined' ? this : globalThis, (protocol, publicErrors) => {
  'use strict';

  const { MESSAGE_TYPES, createMessage } = protocol;

const BACKEND = 'http://127.0.0.1:4317';
const RECORDING_KEY = 'activeRecording';
const CANDIDATE_KEY = 'candidate';
const DISCOVERY_KEY = 'discoveryMap';
const DISCOVERY_SESSION_KEY = 'discoverySessionId';
const JOBS_KEY = 'jobs';
const WEBMCP_STATUS_KEY = 'webMcpStatus';
const ADAPTER_CACHE_KEY = 'adapterCache';
const advancingJobs = new Set();
let mutationQueue = Promise.resolve();
let started = false;

const storageGet = async (area, key, fallback) => {
  const values = await chrome.storage[area].get(key);
  return values[key] ?? fallback;
};

const storageSet = (area, key, value) => chrome.storage[area].set({ [key]: value });

const mutateSessionValue = (key, fallback, mutate) => {
  const run = mutationQueue.then(async () => {
    const current = await storageGet('session', key, fallback);
    const result = await mutate(current);
    await storageSet('session', key, current);
    return result;
  });
  mutationQueue = run.catch(() => {});
  return run;
};

const tabMessage = (tabId, message) => chrome.tabs.sendMessage(tabId, message);

const requestBackend = async (path, options = {}) => {
  const response = await fetch(`${BACKEND}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Backend request failed with status ${response.status}`);
  }
  return body;
};

const summarizeRecording = (recording) => {
  if (!recording) return null;
  const initialState = ActionMapperRecorder.stateFor(recording, recording.initialStateFingerprint);
  const finalState = ActionMapperRecorder.stateFor(recording, recording.finalStateFingerprint);
  return {
    id: recording.id,
    tabId: recording.tabId,
    status: recording.status,
    startedAt: recording.startedAt,
    stoppedAt: recording.stoppedAt || null,
    startUrl: initialState?.url || null,
    currentUrl: finalState?.url || initialState?.url || null,
    stateCount: recording.stateOrder.length,
    eventCount: recording.steps.length,
    events: recording.steps.slice(-8).map(({ event, delta }) => ({
      id: event.id,
      kind: event.kind,
      target: event.target?.name || event.target?.text || event.target?.css || 'page element',
      urlChanged: delta?.urlChanged === true,
      addedCount: delta?.added?.length || 0,
      removedCount: delta?.removed?.length || 0,
    })),
  };
};

const sanitizedTrace = (recording) => ActionMapperRecorder.toTrace(recording);

const waitForDiscovery = async (sessionId) => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const result = await requestBackend(`/api/discover/${encodeURIComponent(sessionId)}`);
    if (result.status === 'candidate') return result;
    if (result.status === 'failed') throw new Error(result.error || 'Action discovery failed');
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  throw new Error('Action discovery is still running; retry to read the completed result');
};

const startRecording = async (tabId) => {
  if (!Number.isInteger(tabId)) throw new Error('A browser tab is required');
  const page = await tabMessage(tabId, createMessage(MESSAGE_TYPES.getPageState));
  if (!page?.ok) throw new Error(page?.error || 'Could not read the page');
  const recording = ActionMapperRecorder.createRecording({
    id: crypto.randomUUID(),
    tabId,
    startedAt: new Date().toISOString(),
    state: page.state,
  });
  await storageSet('session', RECORDING_KEY, recording);
  await chrome.storage.session.remove([CANDIDATE_KEY, DISCOVERY_KEY]);
  await tabMessage(tabId, createMessage(MESSAGE_TYPES.recordingStart, {
    recordingId: recording.id,
  }));
  return summarizeRecording(recording);
};

const stopRecording = async () => {
  let recording = await storageGet('session', RECORDING_KEY, null);
  if (!recording || recording.status !== 'recording') {
    throw new Error('There is no active recording');
  }
  let finalState = ActionMapperRecorder.stateFor(recording, recording.finalStateFingerprint);
  try {
    const response = await tabMessage(
      recording.tabId,
      createMessage(MESSAGE_TYPES.recordingStop),
    );
    finalState = response?.finalState || finalState;
  } catch (error) {
    // Preserve the most recent navigation snapshot when the page is closing.
  }
  recording = await storageGet('session', RECORDING_KEY, recording);
  const finished = ActionMapperRecorder.finishRecording(
    recording,
    finalState,
    new Date().toISOString(),
  );
  await storageSet('session', RECORDING_KEY, finished);
  return summarizeRecording(finished);
};

const traceEventStarted = async (message, sender) => {
  await mutateSessionValue(RECORDING_KEY, null, (recording) => {
    if (!recording || recording.status !== 'recording'
      || recording.id !== message.recordingId || recording.tabId !== sender.tab?.id) {
      return;
    }
    Object.assign(
      recording,
      ActionMapperRecorder.beginEvent(recording, message.event, message.beforeState),
    );
  });
};

const traceEventCompleted = async (message, sender) => {
  await mutateSessionValue(RECORDING_KEY, null, (recording) => {
    if (!recording || recording.id !== message.recordingId || recording.tabId !== sender.tab?.id) {
      return;
    }
    Object.assign(
      recording,
      ActionMapperRecorder.completeEvent(
        recording,
        message.eventId,
        message.afterState,
        message.delta,
      ),
    );
  });
};

const finishNavigationEvents = async (tabId, state) => mutateSessionValue(
  RECORDING_KEY,
  null,
  (recording) => {
    if (!recording || recording.status !== 'recording' || recording.tabId !== tabId) {
      return null;
    }
    Object.assign(
      recording,
      ActionMapperRecorder.completeNavigation(recording, state, WebMcpSemantic.diffStates),
    );
    return { recordingId: recording.id };
  },
);

const discover = async () => {
  const recording = await storageGet('session', RECORDING_KEY, null);
  if (!recording || recording.status !== 'ready') {
    throw new Error('Stop a recording before discovering its action map');
  }
  if (recording.steps.length === 0) {
    throw new Error('The recording has no actions to discover from');
  }
  const accepted = await requestBackend('/api/discover', {
    method: 'POST',
    body: JSON.stringify({ trace: sanitizedTrace(recording) }),
  });
  await storageSet('session', DISCOVERY_SESSION_KEY, accepted.sessionId);
  const response = await waitForDiscovery(accepted.sessionId);
  const discovery = {
    ...response.discovery,
    privacy: response.privacy,
  };
  await storageSet('session', DISCOVERY_KEY, discovery);
  return discovery;
};

const refreshTabs = async (origin) => {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs
    .filter((tab) => {
      try {
        return new URL(tab.url).origin === origin;
      } catch (error) {
        return false;
      }
    })
    .map((tab) => tabMessage(tab.id, createMessage(MESSAGE_TYPES.refreshAdapters))));
};

const publishCandidate = async (adapterId, versionId, origin) => {
  await requestBackend('/api/adapters/publish', {
    method: 'POST',
    body: JSON.stringify({ adapterId, versionId }),
  });
  const cache = await storageGet('local', ADAPTER_CACHE_KEY, {});
  delete cache[origin];
  await storageSet('local', ADAPTER_CACHE_KEY, cache);
  await mutateSessionValue(CANDIDATE_KEY, null, (candidate) => {
    if (candidate?.adapterId === adapterId && candidate?.versionId === versionId) {
      candidate.status = 'active';
    }
  });
  await refreshTabs(origin);
};

const getAdapters = async (origin) => {
  const cache = await storageGet('local', ADAPTER_CACHE_KEY, {});
  try {
    const body = await requestBackend(`/api/adapters?origin=${encodeURIComponent(origin)}`);
    cache[origin] = {
      adapters: body.adapters,
      fetchedAt: new Date().toISOString(),
    };
    await storageSet('local', ADAPTER_CACHE_KEY, cache);
    return { adapters: body.adapters, stale: false };
  } catch (error) {
    if (cache[origin]) {
      return { adapters: cache[origin].adapters, stale: true, error: error.message };
    }
    throw error;
  }
};

const getJobs = () => storageGet('session', JOBS_KEY, {});

const changeJob = (jobId, mutate) => mutateSessionValue(JOBS_KEY, {}, (jobs) => {
  const job = jobs[jobId];
  if (!job) return null;
  mutate(job);
  job.updatedAt = new Date().toISOString();
  return job;
});

const reportRun = async (job, outcome, details = {}) => {
  const payload = {
    versionId: job.adapter.versionId,
    outcome,
    failedStep: details.failedStep ?? null,
    url: details.url || job.sourceUrl,
    error: details.error || null,
    observed: details.observed || null,
  };
  await requestBackend('/api/runs', {
    method: 'POST',
    body: JSON.stringify(payload),
  }).catch(() => {});
};

const finishJob = async (jobId, status, details) => {
  const job = await changeJob(jobId, (current) => {
    current.status = status;
    current.finishedAt = new Date().toISOString();
    if (status === 'completed') current.result = details.result;
    if (status === 'failed') {
      current.error = details.error;
      current.failedStep = details.failedStep;
    }
  });
  if (!job) return;
  await reportRun(job, status === 'completed' ? 'success' : 'failure', details);
  await chrome.tabs.remove(job.tabId).catch(() => {});
};

const advanceJob = async (jobId) => {
  if (advancingJobs.has(jobId)) return;
  advancingJobs.add(jobId);
  try {
    while (true) {
      const jobs = await getJobs();
      const job = jobs[jobId];
      if (!job || ['completed', 'failed'].includes(job.status)) return;
      const steps = job.adapter.manifest.tool.steps;
      if (job.stepIndex >= steps.length) {
        if (job.result === null) {
          const extraction = await tabMessage(job.tabId, {
            type: 'EXECUTE_STEP',
            step: {
              op: 'extract',
              target: {},
              valueFrom: null,
              literalValue: null,
              key: null,
              expectNavigation: false,
              timeoutMs: 5000,
            },
            args: job.args,
            tool: job.adapter.manifest.tool,
          }).catch((error) => ({ ok: false, error: error.message }));
          if (!extraction?.ok) {
            await finishJob(jobId, 'failed', {
              error: extraction?.error || 'Could not extract adapter output',
              failedStep: job.stepIndex,
            });
            return;
          }
          await changeJob(jobId, (current) => { current.result = extraction.result; });
          continue;
        }
        await finishJob(jobId, 'completed', { result: job.result });
        return;
      }

      const step = steps[job.stepIndex];
      await changeJob(jobId, (current) => { current.status = 'running'; });
      let response;
      try {
        response = await tabMessage(job.tabId, {
          type: 'EXECUTE_STEP',
          step,
          args: job.args,
          tool: job.adapter.manifest.tool,
        });
      } catch (error) {
        const attempts = (job.transportAttempts || 0) + 1;
        if (attempts <= 20) {
          await changeJob(jobId, (current) => {
            current.status = 'starting';
            current.transportAttempts = attempts;
          });
          setTimeout(() => { void advanceJob(jobId); }, 250);
          return;
        }
        response = { ok: false, error: `Execution page did not become ready: ${error.message}` };
      }
      if (!response?.ok) {
        await finishJob(jobId, 'failed', {
          error: response?.error || 'Adapter step failed',
          failedStep: job.stepIndex,
        });
        return;
      }
      await changeJob(jobId, (current) => {
        current.stepIndex += 1;
        current.result = response.result ?? current.result;
        current.transportAttempts = 0;
        current.status = response.navigating ? 'waiting-navigation' : 'running';
      });
      if (response.navigating) {
        setTimeout(() => { void advanceJob(jobId); }, 1500);
        return;
      }
    }
  } finally {
    advancingJobs.delete(jobId);
  }
};

const startJob = async (adapter, args, sourceUrl, sourceTabId) => {
  const validation = WebMcpManifest.validateManifest(adapter.manifest);
  if (!validation.valid) {
    throw new Error(`Stored adapter is invalid: ${validation.errors.join('; ')}`);
  }
  if (!WebMcpManifest.manifestMatchesLocation(validation.manifest, sourceUrl)) {
    throw new Error('This adapter is not valid for the current page');
  }
  const tab = await chrome.tabs.create({ url: sourceUrl, active: false });
  const job = {
    id: crypto.randomUUID(),
    tabId: tab.id,
    sourceTabId,
    sourceUrl,
    adapter: { ...adapter, manifest: validation.manifest },
    args,
    stepIndex: 0,
    status: 'starting',
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await mutateSessionValue(JOBS_KEY, {}, (jobs) => { jobs[job.id] = job; });
  setTimeout(() => { void advanceJob(job.id); }, 300);
  return job.id;
};

const pageReady = async (sender, state) => {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return { recordingActive: false };
  const recording = await finishNavigationEvents(tabId, state);
  const jobs = await getJobs();
  const job = Object.values(jobs).find((candidate) => (
    candidate.tabId === tabId && !['completed', 'failed'].includes(candidate.status)
  ));
  if (job) {
    setTimeout(() => { void advanceJob(job.id); }, 0);
  }
  return {
    recordingActive: Boolean(recording),
    recordingId: recording?.recordingId || null,
  };
};

const popupState = async () => {
  const [recording, discovery, webMcpStatus] = await Promise.all([
    storageGet('session', RECORDING_KEY, null),
    storageGet('session', DISCOVERY_KEY, null),
    storageGet('session', WEBMCP_STATUS_KEY, null),
  ]);
  return {
    recording: summarizeRecording(recording),
    discovery,
    webMcpStatus,
  };
};

const handleMessage = async (message, sender) => {
  switch (message.type) {
    case MESSAGE_TYPES.pageReady:
      return pageReady(sender, message.state);
    case MESSAGE_TYPES.getPopupState:
      return { ok: true, ...(await popupState()) };
    case MESSAGE_TYPES.publishCandidate:
      await publishCandidate(message.adapterId, message.versionId, message.origin);
      return { ok: true };
    case MESSAGE_TYPES.getBackendHealth:
      return { ok: true, health: await requestBackend('/health') };
    case MESSAGE_TYPES.getAdapters:
      return { ok: true, ...(await getAdapters(message.origin)) };
    case MESSAGE_TYPES.webMcpStatus:
      await storageSet('session', WEBMCP_STATUS_KEY, {
        available: message.available,
        registered: message.registered || 0,
        tabId: sender.tab?.id || null,
        updatedAt: new Date().toISOString(),
      });
      return { ok: true };
    case MESSAGE_TYPES.startJob:
      return {
        ok: true,
        jobId: await startJob(message.adapter, message.args, message.sourceUrl, sender.tab?.id),
      };
    case MESSAGE_TYPES.getJob: {
      const jobs = await getJobs();
      const job = jobs[message.jobId];
      if (!job) return { ok: false, error: 'Job not found' };
      if (!['completed', 'failed'].includes(job.status)) {
        setTimeout(() => { void advanceJob(job.id); }, 0);
      }
      return { ok: true, job };
    }
    default:
      return { ok: false, error: 'Unknown extension message' };
  }
};

const onMessage = (message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse(publicErrors.legacyResponseFor(error)));
  return true;
};

const onTabRemoved = (tabId) => {
  void getJobs().then((jobs) => {
    const job = Object.values(jobs).find((candidate) => (
      candidate.tabId === tabId && !['completed', 'failed'].includes(candidate.status)
    ));
    if (job) {
      void finishJob(job.id, 'failed', {
        error: 'The background execution tab was closed',
        failedStep: job.stepIndex,
      });
    }
  });
};

const start = () => {
  if (started) return;
  started = true;
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
};

return {
  handleMessage,
  start,
};
}));
