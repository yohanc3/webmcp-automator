(function initializeCoordinatorCompatibility(root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.WebMcpCoordinatorCompatibility = api;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);

  class LegacyPollingCompatibilityAdapter {
    constructor({
      start,
      read,
      pollIntervalMs = 200,
      maxWaitMs = 30000,
      schedule = (callback, delay) => setTimeout(callback, delay),
      now = () => Date.now(),
    }) {
      this.start = start;
      this.read = read;
      this.pollIntervalMs = pollIntervalMs;
      this.maxWaitMs = maxWaitMs;
      this.schedule = schedule;
      this.now = now;
    }

    startJob(request) {
      return this.start(request);
    }

    getJob(jobId) {
      return this.read(jobId);
    }

    async waitForJob(jobId) {
      const deadline = this.now() + this.maxWaitMs;
      while (this.now() < deadline) {
        const job = await this.getJob(jobId);
        if (job && TERMINAL_STATUSES.includes(job.status)) return job;
        await new Promise((resolve) => { this.schedule(resolve, this.pollIntervalMs); });
      }
      throw new Error('Legacy polling compatibility request timed out');
    }
  }

  return {
    LegacyPollingCompatibilityAdapter,
    TERMINAL_STATUSES,
  };
}));
