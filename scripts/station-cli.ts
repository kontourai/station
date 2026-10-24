#!/usr/bin/env tsx

import { initializeSourceBootstrap } from './source-bootstrap.js';

initializeSourceBootstrap({ wrapperUrl: import.meta.url });

const { runPassiveCli } = await import('../packages/cli/src/passive-cli.js');
if (!runPassiveCli(process.argv.slice(2))) {
  const { runStationCliImplementation } = await import(
    './station-cli-implementation.js'
  );
  await runStationCliImplementation();
}
