'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildInputSchema,
  manifestMatchesLocation,
  validateManifest,
} = require('../extension/manifest-contract');

const locator = (css = null) => ({
  css,
  role: null,
  name: null,
  placeholder: null,
  text: null,
  hrefContains: null,
});

const adapter = () => ({
  schemaVersion: 'learned-adapter/1',
  usable: true,
  site: {
    origin: 'https://example.com',
    routePatterns: ['/search'],
  },
  tool: {
    name: 'search_products',
    description: 'Search products',
    safety: 'read',
    parameters: [{
      name: 'query',
      description: 'Search query',
      type: 'string',
      required: true,
    }],
    steps: [{
      op: 'fill',
      target: locator('#search'),
      valueFrom: 'query',
      literalValue: null,
      key: null,
      expectNavigation: false,
      timeoutMs: 5000,
    }],
    output: {
      mode: 'page',
      collectionRoot: locator(),
      item: locator(),
      limit: 10,
      fields: [],
    },
    annotations: {
      readOnlyHint: true,
      untrustedContentHint: true,
    },
  },
  confidence: 0.9,
  evidence: 'Recorded once',
  issues: [],
});

test('validates a deterministic learned adapter', () => {
  assert.equal(validateManifest(adapter()).valid, true);
});

test('rejects an unknown schema version', () => {
  const candidate = adapter();
  candidate.schemaVersion = 'learned-adapter/99';
  const validation = validateManifest(candidate);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(' '), /schemaVersion/);
});

test('builds WebMCP input schema and respects route scope', () => {
  const candidate = adapter();
  assert.deepEqual(buildInputSchema(candidate.tool), {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
    additionalProperties: false,
  });
  assert.equal(manifestMatchesLocation(candidate, 'https://example.com/search?q=microphone'), true);
  assert.equal(manifestMatchesLocation(candidate, 'https://example.com/cart'), false);
});
