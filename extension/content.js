(() => {
  'use strict';

  const learning = WebMcpLearningBootstrap;
  const source = WebMcpSourceBootstrap;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const learningResult = learning.handleMessage(message, sender, sendResponse);
    if (learningResult !== undefined) return learningResult;

    const sourceResult = source.handleMessage(message, sender, sendResponse);
    return sourceResult ?? false;
  });

  learning.start();
  void learning.initialize().catch(() => {
    // The extension can still record after the service worker restarts or the backend comes online.
  });
})();
