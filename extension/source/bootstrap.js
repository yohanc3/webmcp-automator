(function initializeSourceBootstrap(root, factory) {
  root.WebMcpSourceBootstrap = factory(
    root.WebMcpProtocol,
    root.WebMcpErrors,
    root.WebMcpManifest,
    root.WebMcpRunner,
  );
}(typeof globalThis === 'undefined' ? this : globalThis,
  (protocol, publicErrors, manifestContract, runner) => {
    'use strict';

    const {
      MESSAGE_TYPES,
      createMessage,
      isMessage,
      sendRuntimeMessage,
    } = protocol;
    const { buildInputSchema, manifestMatchesLocation } = manifestContract;
    const registrationControllers = new Map();

    const sendMessage = (message) => sendRuntimeMessage(chrome.runtime, message);

    const waitForJob = async (jobId, signal) => {
      while (!signal?.aborted) {
        const response = await sendMessage(createMessage(MESSAGE_TYPES.getJob, { jobId }));
        if (!response?.ok) {
          throw new Error(response?.error || 'The adapter job disappeared');
        }
        if (response.job.status === 'completed') return response.job.result;
        if (response.job.status === 'failed') throw new Error(response.job.error);
        await new Promise((resolve) => { setTimeout(resolve, 200); });
      }
      throw publicErrors.cancellationError();
    };

    const registerAdapters = async () => {
      registrationControllers.forEach((controller) => controller.abort());
      registrationControllers.clear();
      if (!document.modelContext?.registerTool) {
        await sendMessage(createMessage(MESSAGE_TYPES.webMcpStatus, {
          available: false,
        })).catch(() => {});
        return;
      }
      const response = await sendMessage(createMessage(MESSAGE_TYPES.getAdapters, {
        origin: window.location.origin,
      }));
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
            const started = await sendMessage(createMessage(MESSAGE_TYPES.startJob, {
              adapter,
              args,
              sourceUrl: window.location.href,
            }));
            if (!started?.ok) {
              throw new Error(started?.error || 'Could not start the adapter job');
            }
            return waitForJob(started.jobId, client.signal);
          },
        }, { signal: controller.signal });
      }
      await sendMessage(createMessage(MESSAGE_TYPES.webMcpStatus, {
        available: true,
        registered: matching.length,
      })).catch(() => {});
    };

    const handleMessage = (message, _sender, sendResponse) => {
      if (isMessage(message, MESSAGE_TYPES.executeStep)) {
        runner.executeStep(message.step, message.args, message.tool)
          .then((result) => sendResponse({ ok: true, ...result }))
          .catch((error) => sendResponse(publicErrors.legacyResponseFor(error)));
        return true;
      }
      if (isMessage(message, MESSAGE_TYPES.refreshAdapters)) {
        registerAdapters()
          .then(() => sendResponse({ ok: true }))
          .catch((error) => sendResponse(publicErrors.legacyResponseFor(error)));
        return true;
      }
      return undefined;
    };

    return {
      handleMessage,
      registerAdapters,
      waitForJob,
    };
  }));
