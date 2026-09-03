'use strict';

importScripts(
  'manifest-contract.js',
  'semantic.js',
  'recorder-core.js',
  'shared/protocol.js',
  'shared/errors.js',
  'coordinator/run-state.js',
  'coordinator/run-coordinator.js',
  'coordinator/chrome-adapters.js',
  'coordinator/ready-runtime.js',
  'coordinator/bootstrap.js',
);

WebMcpCoordinatorBootstrap.start();
