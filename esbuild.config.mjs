import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { deriveServerBuildIdentity } from './scripts/lib/desktop-build-manifest.mjs';
import { STATION_SERVER_EXTERNALS } from './scripts/lib/server-build-config.mjs';

// jsonc-parser exposes its CommonJS UMD entry as `main` and its fully
// statically-importable implementation as `module`. esbuild's Node defaults
// select `main`, then preserve the UMD entry's relative require('./impl/*')
// calls inside our single-file server bundle. Those siblings do not exist in
// a packaged dist-server/, so boot fails before the readiness handshake.
//
// Keep this deliberately narrow instead of changing `mainFields` for every
// dependency: Station's own dispatch -> bearing runtime is the consumer, and
// only jsonc-parser needs its ESM distribution forced into the bundle.
const resolvePackage = createRequire(import.meta.url);
const jsoncParserEsmEntry = resolvePackage.resolve(
  'jsonc-parser/lib/esm/main.js',
);

// station#1985: the server's build-time baked identity fallback. A distinct
// banner global (`globalThis.__STATION_SERVER_BUILD__`), not an esbuild
// `define` — a `define` on `process.env.STATION_BUILD_SHA` would statically
// replace every runtime read of that env var with a build-time literal,
// permanently overriding supervisor metadata reads. The runtime resolver can
// then distinguish and prefer this served-bundle stamp over checkout-derived
// supervisor metadata. This mirrors the
// existing `globalThis.__STATION_CLI_BUNDLE__` precedent in
// `packages/cli/esbuild.config.mjs`.
const serverBuildIdentity = deriveServerBuildIdentity(process.cwd());

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  alias: {
    'jsonc-parser': jsoncParserEsmEntry,
  },
  external: STATION_SERVER_EXTERNALS,
  banner: {
    js: [
      "import { createRequire as __stationCreateRequire } from 'node:module'; const require = __stationCreateRequire(import.meta.url);",
      `globalThis.__STATION_SERVER_BUILD__ = ${JSON.stringify(serverBuildIdentity)};`,
    ].join('\n'),
  },
};

const serverDir = process.env.STATION_BUILD_SERVER_DIR || 'dist-server';

await Promise.all([
  esbuild.build({
    ...shared,
    entryPoints: ['./src-server/index.ts'],
    outfile: `${serverDir}/command-station.js`,
  }),
  esbuild.build({
    ...shared,
    entryPoints: ['./src-server/tools/station-control-server.ts'],
    outfile: `${serverDir}/station-control.js`,
  }),
  // station#1547: the credential-free docs server. Bundling it here is what
  // makes "documentation ships with Station, never fetched at runtime" a
  // build property — the topic prose is compiled into this artifact.
  esbuild.build({
    ...shared,
    entryPoints: ['./src-server/tools/station-docs-server.ts'],
    outfile: `${serverDir}/station-docs.js`,
  }),
  // station#1903: the self-update health-verification watchdog. It must
  // survive after the parent server process exits (that exit is what frees
  // the shared port for the new server to bind), so it has to be a real
  // separate process, spawned detached — never an in-process callback.
  esbuild.build({
    ...shared,
    entryPoints: ['./src-server/tools/self-update-watchdog-runner.ts'],
    outfile: `${serverDir}/self-update-watchdog.js`,
  }),
  // Native desktop registry I/O intentionally goes through this bundled
  // caller, so it retains the shared module's locked, fail-closed semantics.
  esbuild.build({
    ...shared,
    entryPoints: ['./src-server/tools/instance-registry-bridge.ts'],
    outfile: `${serverDir}/instance-registry-bridge.js`,
  }),
  // station#3218: scheduled store verification. `node:sqlite` is synchronous,
  // so `PRAGMA quick_check` in the server would stall the event loop for its
  // whole duration; this has to be a real separate process for the runtime to
  // stay responsive while it runs.
  esbuild.build({
    ...shared,
    entryPoints: ['./src-server/tools/store-integrity-probe.ts'],
    outfile: `${serverDir}/store-integrity-probe.js`,
  }),
  // The bound-directory Adapter invokes this fixed helper by import-meta
  // relative path. Build it beside the server bundle so packaged execution
  // cannot accidentally depend on the source checkout.
  esbuild.build({
    ...shared,
    entryPoints: [
      './src-server/services/agents/bound-directory-enumeration-helper.mjs',
    ],
    outfile: `${serverDir}/bound-directory-enumeration-helper.mjs`,
  }),
  // Durable room SQLite is synchronous by Node's API and therefore lives in
  // its own owned worker. Emit the worker beside the server bundle so the
  // import.meta.url-relative production path is as explicit as the source path.
  esbuild.build({
    ...shared,
    entryPoints: [
      './src-server/services/orchestration/project-task-room-history-worker.ts',
    ],
    outfile: `${serverDir}/project-task-room-history-worker.js`,
  }),
  // The private document worker is loaded via import.meta.url at runtime too.
  // Ship it beside the history worker: source-only availability passes dev
  // tests while a packaged server otherwise fails its first room request.
  esbuild.build({
    ...shared,
    entryPoints: [
      './src-server/services/orchestration/project-task-room-working-state-worker.ts',
    ],
    outfile: `${serverDir}/project-task-room-working-state-worker.js`,
  }),
]);
