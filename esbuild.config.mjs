import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { relative, resolve } from 'node:path';
import * as esbuild from 'esbuild';
import {
  SUPERVISOR_BUNDLE_NAME,
  supervisorBuildOptions,
} from './packages/supervisor/build-options.mjs';
import { generateStationDocs } from './scripts/generate-station-docs.mjs';
import { authorTelemetryEndpoint } from './scripts/lib/author-telemetry-build.mjs';
import { deriveServerBuildIdentity } from './scripts/lib/desktop-build-manifest.mjs';
import { STATION_SERVER_EXTERNALS } from './scripts/lib/server-build-config.mjs';
import { assertAsciiServerBundles } from './scripts/lib/server-bundle-ascii.mjs';
import { assertNoBootDeniedStaticImports } from './scripts/lib/server-static-imports.mjs';

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

const buildBanner = [
  `globalThis.__STATION_SERVER_BUILD__ = ${JSON.stringify(serverBuildIdentity)};`,
  `globalThis.__STATION_AUTHOR_TELEMETRY_ENDPOINT__ = ${JSON.stringify(authorTelemetryEndpoint(serverBuildIdentity?.channel))};`,
].join('\n');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: 'linked',
  minify: true,
  keepNames: true,
  alias: {
    'jsonc-parser': jsoncParserEsmEntry,
  },
  external: STATION_SERVER_EXTERNALS,
  banner: {
    js: [
      "import { createRequire as __stationCreateRequire } from 'node:module'; const require = __stationCreateRequire(import.meta.url);",
      buildBanner,
    ].join('\n'),
  },
};

const serverDir = process.env.STATION_BUILD_SERVER_DIR || 'dist-server';

await generateStationDocs({ check: true });
mkdirSync(`${serverDir}/third-party/cedar`, { recursive: true });
for (const name of ['LICENSE', 'NOTICE']) {
  cpSync(
    `packaging/licenses/cedar/${name}`,
    `${serverDir}/third-party/cedar/${name}`,
  );
}

mkdirSync(`${serverDir}/third-party/media-tools`, { recursive: true });
cpSync(
  'packaging/licenses/media-tools/NOTICE',
  `${serverDir}/third-party/media-tools/NOTICE`,
);

// Bundles this build writes are checked; older files in serverDir are not.
const buildStartedMs = Date.now();
// Bind the core to this build's emitted stdio entry, even if the installation
// path later points to a different generation.
const docsEntry = `${serverDir}/station-docs.js`;
const docs = await esbuild.build({
  ...shared,
  // The same bytes must run as a file or an in-memory ESM module.
  banner: { js: buildBanner },
  entryPoints: ['./src-server/tools/station-docs-server.ts'],
  outfile: docsEntry,
  metafile: true,
  write: false,
});
const docsCode = docs.outputFiles.find(
  (file) => file.path === resolve(docsEntry),
);
if (!docsCode)
  throw new Error('Station Docs build did not emit its executable.');
const dependencies =
  docs.metafile.outputs[
    relative(process.cwd(), docsEntry).split('\\').join('/')
  ]?.imports;
if (
  !dependencies ||
  dependencies.some(
    (dependency) =>
      !dependency.path.startsWith('node:') || !isBuiltin(dependency.path),
  )
) {
  throw new Error('Station Docs must bundle all non-Node dependencies.');
}
for (const file of docs.outputFiles) writeFileSync(file.path, file.contents);
chmodSync(docsCode.path, 0o755);
const docsExecutable = {
  sha256: createHash('sha256').update(docsCode.contents).digest('hex'),
  size: docsCode.contents.byteLength,
};

await Promise.all([
  esbuild.build({
    ...shared,
    entryPoints: ['./src-server/tools/cedar-policy-probe.ts'],
    outfile: `${serverDir}/cedar-policy-probe.js`,
  }),
  esbuild.build({
    ...shared,
    entryPoints: [
      './src-server/services/secrets/telemetry-key-materialization-child.ts',
    ],
    outfile: `${serverDir}/telemetry-key-materialization-child.js`,
  }),
  esbuild.build({
    ...shared,
    entryPoints: ['./src-server/index.ts'],
    define: { __STATION_DOCS_EXECUTABLE__: JSON.stringify(docsExecutable) },
    outfile: `${serverDir}/command-station.js`,
  }),
  // The process supervisor holds listeners and hands them between core
  // generations. It is self-contained (Node built-ins only) and does not share
  // the server banner or externals: it must run with no node_modules beside it.
  esbuild.build(
    supervisorBuildOptions(`${serverDir}/${SUPERVISOR_BUNDLE_NAME}`),
  ),
  // The supervisor's workload host owns terminal PTYs across core
  // generations. It needs node-pty, so unlike the supervisor it runs beside
  // this build's node_modules; the supervisor starts the one beside the core
  // entry (WORKLOAD_HOST_BUNDLE_NAME in the supervisor protocol).
  esbuild.build({
    ...shared,
    entryPoints: ['./src-server/tools/station-pty-host.ts'],
    outfile: `${serverDir}/station-pty-host.js`,
  }),
  esbuild.build({
    ...shared,
    entryPoints: ['./src-server/tools/station-control-server.ts'],
    outfile: `${serverDir}/station-control.js`,
  }),
  esbuild.build({
    ...shared,
    entryPoints: ['./src-server/tools/station-knowledge-server.ts'],
    outfile: `${serverDir}/station-knowledge.js`,
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
  esbuild.build({
    ...shared,
    entryPoints: [
      './src-server/runtime/agents/durable-agent-checkpoint-worker.ts',
    ],
    outfile: `${serverDir}/durable-agent-checkpoint-worker.js`,
  }),
  // The fixed first-party Task reader uses the same relative packaged path.
  esbuild.build({
    ...shared,
    entryPoints: ['./src-server/services/search/task-search-worker.ts'],
    outfile: `${serverDir}/task-search-worker.js`,
  }),
  esbuild.build({
    ...shared,
    entryPoints: ['./src-server/services/search/transcript-search-worker.ts'],
    outfile: `${serverDir}/transcript-search-worker.js`,
  }),
  // A plugin draft build runs in its own disposable process (epic #2323 S3),
  // forked via an import.meta.url-relative path, so ship its entry beside
  // the server bundle like the workers above.
  esbuild.build({
    ...shared,
    entryPoints: ['./src-server/services/plugins/plugin-draft-build-child.ts'],
    outfile: `${serverDir}/plugin-draft-build-child.js`,
  }),
  // #3406: attached-session discovery reads session folders in this helper
  // process, spawned via an import.meta.url-relative path like the one above.
  esbuild.build({
    ...shared,
    entryPoints: [
      './src-server/services/orchestration/attached-session-path-child.ts',
    ],
    outfile: `${serverDir}/attached-session-path-child.js`,
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

assertAsciiServerBundles(serverDir, { sinceMs: buildStartedMs });
await assertNoBootDeniedStaticImports(`${serverDir}/command-station.js`);
