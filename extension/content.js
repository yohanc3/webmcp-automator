(() => {
  'use strict';

  const source = WebMcpSourceBootstrap;
  const actor = WebMcpActorClient;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const sourceResult = source.handleMessage(message, sender, sendResponse);
    return sourceResult ?? false;
  });

  void source.initialize().catch(() => {});
  actor.start();
  actor.startReplay();

  void WebMcpAmbientRuntime.start().catch(() => {
    document.documentElement.dataset.webMcpAmbient = 'unavailable';
  });
})();
