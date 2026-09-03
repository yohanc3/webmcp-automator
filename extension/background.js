'use strict';

importScripts(
  'manifest-contract.js',
  'semantic.js',
  'recorder-core.js',
  'shared/protocol.js',
  'shared/errors.js',
  'coordinator/bootstrap.js',
);

WebMcpCoordinatorBootstrap.start();
