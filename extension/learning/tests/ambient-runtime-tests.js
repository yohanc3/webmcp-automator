'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const retrySpool = require('../retry-spool.js');

test('manual learning protocol types are absent', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../shared/protocol.js'), 'utf8');
  assert.doesNotMatch(source, /START_RECORDING|STOP_RECORDING|RECORDING_START|RECORDING_STOP|DISCOVER/);
});

test('ambient runtime carries session lifecycle and DOM-quiet hooks', () => {
  const source = fs.readFileSync(path.join(__dirname, '../ambient-runtime.js'), 'utf8');
  assert.match(source, /ambientLifecycle:/);
  assert.match(source, /same_document_route/);
  assert.match(source, /MutationObserver/);
  assert.match(source, /__webMcpAmbientLastObservation = null/);
});

test('retry spool storage is AES-GCM ciphertext-only by contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '../retry-spool.js'), 'utf8');
  assert.match(source, /AES-GCM/);
  assert.match(source, /exportKey\('jwk'/);
  assert.match(source, /importKey\('jwk'/);
  assert.match(source, /storage\.local\.remove/);
  assert.equal(typeof retrySpool.createChromeEncryptedStorage, 'function');
});
