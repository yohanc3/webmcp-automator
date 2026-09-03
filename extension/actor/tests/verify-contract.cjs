// Usage: NODE_PATH=/path/to/node_modules node verify-contract.cjs outcomes.json
// Development-only dependencies: ajv@8 and ajv-formats@3. Runtime has none.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const root = path.resolve(__dirname, '../../..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const actionSchema = read('documentation/contracts/action-list.schema.json');
const runSchema = read('documentation/contracts/run-message.schema.json');
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(actionSchema);
const validate = ajv.compile(runSchema);
const fixture = read('documentation/contracts/examples/owned-storefront.action-list.json');
assert(ajv.validate(actionSchema.$id, fixture), JSON.stringify(ajv.errors));
const outcomes = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert(outcomes.length > 0, 'No browser outcomes supplied');
for (const [index, outcome] of outcomes.entries()) {
  const envelope = {
    protocol: 'webmcp-run/1', requestId: 'request_test', runId: 'run_test',
    sequence: index + 1, sentAt: new Date().toISOString(),
    sender: { context: 'execution_content', tabId: 1, documentId: 'document_test' },
    ...outcome,
  };
  assert(validate(envelope), JSON.stringify({ index, errors: validate.errors }));
}
const source = fs.readFileSync(path.join(__dirname, '../runtime.js'), 'utf8');
assert(!/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|eval|Function|import|require)\s*\(/.test(source),
  'Runtime contains a network, dynamic-code, or dependency entry point');
console.log(`PASS: frozen action fixture and ${outcomes.length} actor envelopes validate; runtime has no network/dynamic-code dependencies`);
