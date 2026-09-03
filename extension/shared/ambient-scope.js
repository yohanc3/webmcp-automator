(function initializeAmbientScope(root, factory) {
  const api = factory();
  root.WebMcpAmbientScope = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';
  const originFor = (value) => {
    try { const origin = new URL(value).origin; return /^https?:\/\//.test(origin) ? origin : null; } catch (error) { return null; }
  };
  const scopeFor = (origin) => {
    const normalized = originFor(origin);
    return normalized ? `site_${normalized.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(-80)}` : null;
  };
  return Object.freeze({ originFor, scopeFor });
}));
