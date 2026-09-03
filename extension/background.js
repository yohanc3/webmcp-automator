'use strict';

importScripts(
  'manifest-contract.js',
  'semantic.js',
  'recorder-core.js',
  'shared/protocol.js',
  'shared/ambient-scope.js',
  'shared/errors.js',
  'learning/privacy.js',
  'learning/semantic.js',
  'learning/retry-spool.js',
  'learning/ambient-capture.js',
  'coordinator/run-state.js',
  'coordinator/run-coordinator.js',
  'coordinator/chrome-adapters.js',
  'coordinator/candidate-replay.js',
  'coordinator/ready-runtime.js',
  'coordinator/bootstrap.js',
);

WebMcpCoordinatorBootstrap.start();
