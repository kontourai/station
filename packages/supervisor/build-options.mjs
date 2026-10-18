// esbuild options for the self-contained supervisor bundle. Shared by the
// root esbuild.config.mjs and the bundle test so both build the same artifact.
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
  };
}
