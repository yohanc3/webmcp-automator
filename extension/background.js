'use strict';

importScripts(
  'manifest-contract.js',
  'semantic.js',
  'recorder-core.js',
  'shared/protocol.js',
  'shared/errors.js',
  'coordinator/bootstrap.js',
  'learning/privacy.js',
  'learning/semantic.js',
  'learning/retry-spool.js',
  'learning/ambient-capture.js',
);

WebMcpCoordinatorBootstrap.start();
