(() => {
  'use strict';

  const ready = document.readyState === 'loading'
    ? new Promise((resolve) => {
      document.addEventListener('DOMContentLoaded', resolve, { once: true });
    })
    : Promise.resolve();
  let session;

  const getSession = async () => {
    await ready;
    if (!session) {
      session = WebMcpLearningSession.createSession({ document });
      session.initialize();
    }
    return session;
  };

  globalThis.DemoLearningHarness = Object.freeze({
    async debug() {
      return (await getSession()).debug();
    },
    async downloadDebug() {
      return (await getSession()).downloadDebug();
    },
    async reset() {
      return (await getSession()).reset();
    },
    async start() {
      const activeSession = await getSession();
      return {
        recordingId: activeSession.start(),
        status: activeSession.status(),
      };
    },
    async status() {
      return (await getSession()).status();
    },
    async stop() {
      return (await getSession()).stop();
    },
    async trace() {
      return (await getSession()).trace();
    },
  });

  void getSession();
})();
