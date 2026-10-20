// esbuild options for the self-contained supervisor bundle. Shared by the
// root esbuild.config.mjs and src/__tests__/bundle.test.ts, which checks the
// output imports only Node built-ins and runs with no node_modules.
import { fileURLToPath } from 'node:url';

export const SUPERVISOR_BUNDLE_NAME = 'station-supervisor.js';

/** @param {string} outfile */
export function supervisorBuildOptions(outfile) {
  return {
    entryPoints: [fileURLToPath(new URL('./src/main.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: /** @type {const} */ ('node'),
    target: 'node24',
    format: /** @type {const} */ ('esm'),
    sourcemap: true,
    // Node built-ins only: anything else failing to resolve is a build error,
    // never a runtime import from a node_modules that is not shipped.
    external: ['node:*'],
    // Test-only knobs never reach the shipped bundle.
    define: {
      'process.env.STATION_SUPERVISOR_TEST_LOCK_DELAY_MS': 'undefined',
      'process.env.STATION_SUPERVISOR_TEST_POST_ACQUIRE_DELAY_MS': 'undefined',
    },
  };
}
