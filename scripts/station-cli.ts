#!/usr/bin/env tsx

import { initializeSourceBootstrap } from './source-bootstrap.js';

initializeSourceBootstrap({ wrapperUrl: import.meta.url });

const { runStationCliImplementation } = await import(
  './station-cli-implementation.js'
);
await runStationCliImplementation();
