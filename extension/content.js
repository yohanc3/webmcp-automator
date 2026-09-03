(() => {
  'use strict';

  const source = WebMcpSourceBootstrap;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const sourceResult = source.handleMessage(message, sender, sendResponse);
    return sourceResult ?? false;
  });

  void source.initialize().catch(() => {});

  void WebMcpAmbientRuntime.start().catch(() => {
    document.documentElement.dataset.webMcpAmbient = 'unavailable';
  });
})();
