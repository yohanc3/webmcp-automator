'use strict';

const { readFile } = require('node:fs/promises');
const path = require('node:path');

const backend = (process.env.ACTION_MAPPER_BACKEND || 'http://127.0.0.1:4317').replace(/\/$/, '');
const fixturePath = path.resolve(
  __dirname,
  '../../server/tests/fixtures/storefront-search-trace.json',
);

const waitForDiscovery = async (sessionId) => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const response = await fetch(`${backend}/api/discover/${encodeURIComponent(sessionId)}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Discovery status failed with HTTP ${response.status}`);
    }
    if (body.status === 'candidate') return body;
    if (body.status === 'failed') throw new Error(body.error || 'Discovery failed');
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  throw new Error('Discovery did not complete within 180 seconds');
};

const run = async () => {
  const trace = JSON.parse(await readFile(fixturePath, 'utf8'));
  const response = await fetch(`${backend}/api/discover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trace }),
  });
  const accepted = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(accepted.error || `Discovery failed with HTTP ${response.status}`);
  }
  const body = await waitForDiscovery(accepted.sessionId);
  const actionMap = body.discovery?.actionMap;
  if (!actionMap || actionMap.schemaVersion !== 'action-map/1') {
    throw new Error('The backend returned no validated action-map/1 result');
  }
  const output = {
    model: body.model,
    sessionId: body.sessionId,
    privacy: body.privacy,
    summary: actionMap.summary,
    states: actionMap.states.map(({ id, label, urlPattern }) => ({ id, label, urlPattern })),
    actions: actionMap.actions.map((action) => ({
      id: action.id,
      name: action.name,
      status: action.status,
      safety: action.safety,
      route: `${action.fromState} -> ${action.toState || 'unknown'}`,
      steps: action.steps.map(({ op }) => op),
      output: action.output.mode,
      confidence: action.confidence,
      missingEvidence: action.missingEvidence,
    })),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
};

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
