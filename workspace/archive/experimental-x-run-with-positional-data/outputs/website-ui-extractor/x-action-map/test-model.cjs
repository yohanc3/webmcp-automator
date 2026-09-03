'use strict';

const assert = require('node:assert/strict');

require('./data.js');
require('./model.js');

const model = globalThis.XActionModel.createActionModel(globalThis.X_ACTION_SNAPSHOT);
const actions = model.actions;
const actionById = new Map(actions.map((action) => [action.id, action]));

assert.equal(actions.length, 240);
assert.equal(new Set(actions.map(({ id }) => id)).size, actions.length);
assert.equal(actions.every(({ title, outcome, category, confidence }) => (
  title && outcome && category && confidence
)), true);
assert.match(actionById.get('a64').title, /^Reply to /);
assert.match(actionById.get('a67').title, /^View analytics /);
assert.equal(actionById.get('a67').confidence, 'confirmed');
assert.equal(actionById.get('a20').confidence, 'unclear');
assert.equal(actionById.get('a14').href, 'https://x.com/home');

const confidenceCounts = actions.reduce((counts, { confidence }) => {
  counts[confidence] = (counts[confidence] || 0) + 1;
  return counts;
}, {});

assert.deepEqual(confidenceCounts, {
  unclear: 8,
  confirmed: 128,
  inferred: 104,
});

console.log('mapped all 240 XML actions with stable IDs and human-readable outcomes');
