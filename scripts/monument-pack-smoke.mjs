#!/usr/bin/env node
/**
 * Consumer smoke for the `@kontourai/monument` tarball (#3565, ADR 0005 Tier 1).
 *
 * The package is `private: true` and consumed in-repo as TypeScript source, so
 * nothing else in CI ever installs the artefact a stranger would get. This
 * script does, in a scratch directory outside the repository, with no loader
 * of any kind:
 *
 *   1. lists the tarball and refuses anything but `dist/*.js`, `dist/*.d.ts`
 *      and the manifest and docs (so no tests, sources, maps or configs);
 *   2. installs it with npm, then checks the installed manifest: the four
 *      entry points, each with `types` before `default`, each target present,
 *      none a `.ts` source file, and no Station dependency;
 *   3. reads every shipped module and refuses any specifier that is not a
 *      `node:` builtin or a file inside `dist/` (no Station import can ship);
 *   4. runs a plain `node` script that imports all four entry points, opens a
 *      memory store and a `node:sqlite` store and runs a command on each.
 *      Node does not strip types under `node_modules`, so an `exports` map
 *      that still points at `src/*.ts` fails here with
 *      ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING;
 *   5. type-checks a small consumer `.ts` against the declarations.
 *
 * Every step runs and every failure is reported, so one broken step cannot
 * hide that another is also broken.
 *
 * The tarball comes from `pnpm pack`, not `npm pack`: the `dist/` entry points
 * live in `publishConfig` (the in-repo consumers resolve `src/*.ts` through the
 * top-level `exports`), and only pnpm applies `publishConfig.exports`. This is
 * also what `changeset publish` runs here (it detects the pnpm workspace). An
 * `npm pack` or `npm publish` of this directory would ship `src/*.ts` entry
 * points. Step 1 and 2 reject that tarball.
 *
 *   node scripts/monument-pack-smoke.mjs                  build, pack, smoke
 *   node scripts/monument-pack-smoke.mjs --no-build       smoke the current dist/
 *   node scripts/monument-pack-smoke.mjs --tarball <tgz>  smoke an existing tarball
 *   node scripts/monument-pack-smoke.mjs --spec <name@v>  smoke a registry version
 *   node scripts/monument-pack-smoke.mjs --if-publishable  exit 0 while `private`
 *   node scripts/monument-pack-smoke.mjs --is-public      print public=true|false (and
 *                                     append it to $GITHUB_OUTPUT); exit 1 if the
 *                                     manifest cannot be read. `--manifest <path>`
 *                                     reads another manifest.
 *
 * POSIX only: it shells out to `tar`, `npm` and `pnpm`.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTURE_MAX_BYTES } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';
import { moduleReferences } from './monument-import-boundary-gate.mjs';

export const MONUMENT_DIR = 'packages/monument';
const PACKAGE_NAME = '@kontourai/monument';
/** Pinned here, not derived from the manifest under test. */
export const ENTRY_POINTS = Object.freeze([
  '.',
  './sqlite',
  './adapter',
  './testing',
]);
const TOP_LEVEL_FILES = new Set([
  'package.json',
  'README.md',
  'CONTEXT.md',
  'LICENSE',
]);
const STATION_PACKAGE = /^@kontourai\/station(?:-|$|\/)/;
const DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
];

const RUN_SCRIPT = `import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as kernel from '@kontourai/monument';
import * as adapter from '@kontourai/monument/adapter';
import * as sqlite from '@kontourai/monument/sqlite';
import * as testing from '@kontourai/monument/testing';

// A publish job's credentials must not reach the packed code.
for (const name of Object.keys(process.env))
  assert.doesNotMatch(
    name,
    /^(ACTIONS_ID_TOKEN_REQUEST_(URL|TOKEN)|NPM_ID_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN|GITHUB_TOKEN)$|_authToken$/i,
    'credential variable reached the consumer: ' + name,
  );

for (const specifier of [
  '@kontourai/monument',
  '@kontourai/monument/sqlite',
  '@kontourai/monument/adapter',
  '@kontourai/monument/testing',
]) {
  const resolved = import.meta.resolve(specifier);
  assert.match(resolved, /\\/node_modules\\/@kontourai\\/monument\\/dist\\/.+\\.js$/, resolved);
}
assert.equal(typeof kernel.openMemoryKernelStorage, 'function');
assert.equal(typeof adapter.runKernelTransactionStep, 'function');
assert.equal(typeof sqlite.openSqliteKernelStorage, 'function');
assert.equal(typeof testing.registerKernelConformance, 'function');

const claim = (owner) => ({
  type: 'turnDedup.claim',
  key: 'smoke',
  owner,
  now: 1,
  tracking: 'tracked',
});
const first = { id: 'first', pid: process.pid, identityKind: 'unverified' };
const second = { id: 'second', pid: process.pid, identityKind: 'unverified' };
const context = { liveness: () => 'live' };

const memory = kernel.openMemoryKernelStorage();
assert.deepEqual(await memory.execute(claim(first), context), {
  kind: 'claimed',
  reclaimed: false,
});
assert.deepEqual(await memory.execute(claim(second), context), {
  kind: 'contended',
});
await memory.close();

const file = sqlite.openSqliteKernelStorage({ path: join(process.cwd(), 'smoke.db') });
assert.deepEqual(await file.execute(claim(first), context), {
  kind: 'claimed',
  reclaimed: false,
});
await file.close();
console.log('plain node ok');
`;

const CHECK_SCRIPT = `import {
  openMemoryKernelStorage,
  type KernelStorage,
  type OwnerIdentity,
} from '@kontourai/monument';
import { runKernelTransactionStep, type KernelTransaction } from '@kontourai/monument/adapter';
import { openSqliteKernelStorage } from '@kontourai/monument/sqlite';
import { registerKernelConformance } from '@kontourai/monument/testing';

const owner: OwnerIdentity = { id: 'a', pid: 1, identityKind: 'unverified' };
const storage: KernelStorage = openMemoryKernelStorage();
const result = await storage.execute(
  { type: 'turnDedup.claim', key: 'k', owner, now: 1, tracking: 'tracked' },
  { liveness: () => 'live' },
);
if (result.kind === 'claimed') {
  const reclaimed: boolean = result.reclaimed;
  void reclaimed;
}
// The declarations are real types, not an implicit any.
// @ts-expect-error a volume must be a MemoryKernelVolume
openMemoryKernelStorage({ volume: 5 });
export type { KernelTransaction };
export { openSqliteKernelStorage, registerKernelConformance, runKernelTransactionStep };
`;

function tail(text, lines = 12) {
  const all = String(text ?? '')
    .trim()
    .split('\n');
  return all.slice(-lines).join('\n');
}

/**
 * Every spawned step has an explicit bound, so a hang ends the smoke instead
 * of running to the job's own limit. Generous: `npm install` and the
 * type-check can wait on a busy host (the type-check holds a host-wide slot).
 */
export const STEP_TIMEOUT_MS = 10 * 60 * 1000;
const QUICK_STEP_TIMEOUT_MS = 2 * 60 * 1000;

/** Own each command tree until completion or bounded termination. */
export async function run(command, args, options = {}) {
  const { timeoutMs = STEP_TIMEOUT_MS, ...spawnOptions } = options;
  const execution = executeOwnedCommand(command, args, undefined, command, {
    ...spawnOptions,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let cleanup;
  const stop = () =>
    (cleanup ??= terminateSuiteExecution(execution, {
      processLabel: command,
      terminationGraceMs: 1_000,
      terminationForceMs: 1_000,
      waitForSuiteSettlement,
    }).catch((error) => ({ settled: false, errors: [error] })));
  let cancellation;
  let interrupted = false;
  let cancelled;
  const cancellationSettled = new Promise((resolve) => {
    cancelled = resolve;
  });
  const cancel = (reason) => {
    cancellation ??= reason;
    void stop().then(() => cancelled({ status: null, signal: null }));
  };
  const capture = captureOwnedProcessOutput(execution, {
    maxBytes: CAPTURE_MAX_BYTES,
    onOverflow: () => cancel('output exceeded capture bound'),
  });
  const interrupt = () => {
    interrupted = true;
    cancel('interrupted');
  };
  const timer = setTimeout(() => cancel('timeout'), timeoutMs);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const result = await Promise.race([
      execution.completion,
      cancellationSettled,
    ]);
    const settlement = await stop();
    if (!settlement.settled || execution.isAlive()) {
      const error = new Error(`${command}: owned process tree did not settle`);
      error.code = 'MONUMENT_PROCESS_UNSETTLED';
      throw error;
    }
    if (interrupted) {
      const error = new Error(
        `${command}: interrupted after owned tree settlement`,
      );
      error.code = 'MONUMENT_PROCESS_INTERRUPTED';
      throw error;
    }
    const output = capture.finish();
    const timedOut = cancellation === 'timeout';
    const error =
      result.error ??
      (settlement.errors.length
        ? new Error('owned process cleanup reported errors')
        : output.truncated || output.invalidUtf8
          ? new Error('output was not safely captured')
          : undefined);
    const ok = !cancellation && !error && result.status === 0;
    return {
      ok,
      timedOut,
      status: result.status,
      stdout: output.stdout.text,
      stderr: output.stderr.text,
      describe: () =>
        `${command} ${args.join(' ')}: ${
          timedOut
            ? `timed out after ${timeoutMs} ms and owned tree was settled`
            : (cancellation ??
              error?.message ??
              `exit ${result.status}\n${tail(`${output.stderr.text}\n${output.stdout.text}`)}`)
        }`,
    };
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

const LOADER_VARIABLE = /^(NODE_OPTIONS|NODE_PATH|TSX_.*|NODE_ENV)$/;
/**
 * Registry and CI credentials. The packed code and the type-check run in a
 * publish job that holds an OIDC id-token request and may hold npm auth, and
 * neither has any use for them: names GitHub, npm and pnpm read for
 * publishing, and any `npm_config_` variable that carries a credential
 * (`npm_config_//registry.npmjs.org/:_authToken` included).
 */
const CREDENTIAL_VARIABLE =
  /^(ACTIONS_ID_TOKEN_REQUEST_(URL|TOKEN)|ACTIONS_RUNTIME_TOKEN|NPM_ID_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN|GITHUB_TOKEN|GH_TOKEN)$|^npm_config_.*(_authToken|_auth|_password|_username|_token)$/i;

/**
 * The environment of a consumer with no loader, flag, search path or
 * credential set. `source` is a seam for tests.
 */
export function plainEnvironment(source = process.env) {
  const env = { ...source, STATION_TYPECHECK_INCREMENTAL: '0' };
  for (const name of Object.keys(env))
    if (LOADER_VARIABLE.test(name) || CREDENTIAL_VARIABLE.test(name))
      delete env[name];
  return env;
}

/**
 * Whether the manifest is publishable, by the preflight's own rule in
 * publish-packages.yml (`if (pkg.private) continue`): any truthy `private`,
 * the string "true" included, is private. Throws on anything but a JSON
 * object, so a caller fails closed.
 */
export function monumentIsPublic(manifestText) {
  const manifest = JSON.parse(manifestText);
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest)
  )
    throw new Error('the manifest is not a JSON object');
  return !manifest.private;
}

/**
 * Failures for a tarball listing (`tar -tz`): only compiled output, the
 * manifest and the docs may ship.
 */
export function checkTarballListing(paths) {
  const failures = [];
  for (const path of paths) {
    if (path.endsWith('/')) continue;
    if (!path.startsWith('package/')) {
      failures.push(`tarball entry outside package/: ${path}`);
      continue;
    }
    const inner = path.slice('package/'.length);
    if (TOP_LEVEL_FILES.has(inner)) continue;
    if (
      inner.startsWith('dist/') &&
      (inner.endsWith('.js') || inner.endsWith('.d.ts')) &&
      !/(^|\/)__tests__\/|\.test\./.test(inner)
    )
      continue;
    failures.push(
      /(^|\/)__tests__\/|\.test\./.test(inner)
        ? `tarball ships a test: ${inner}`
        : `tarball ships an unexpected file: ${inner}`,
    );
  }
  return failures;
}

/**
 * Failures for a manifest as a consumer sees it: four entry points, each
 * `{ types, default }` in that order, naming compiled files that exist.
 */
export function checkConsumerManifest(manifest, exists) {
  const failures = [];
  const target = (label, value, suffix) => {
    if (typeof value !== 'string') {
      failures.push(`${label} is not a path: ${JSON.stringify(value)}`);
      return;
    }
    if (!value.startsWith('./dist/') || !value.endsWith(suffix))
      failures.push(
        `${label} must be a ./dist/*${suffix} file, got ${value} (a published entry point may not be TypeScript source)`,
      );
    else if (!exists(value))
      failures.push(`${label} names a missing file: ${value}`);
  };
  target('main', manifest.main, '.js');
  target('types', manifest.types, '.d.ts');
  const map = manifest.exports;
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    failures.push('exports is not a subpath map');
    return failures;
  }
  for (const key of ENTRY_POINTS) {
    const entry = map[key];
    if (entry === undefined) {
      failures.push(`exports is missing the ${key} entry point`);
      continue;
    }
    if (typeof entry === 'string') {
      target(`exports[${key}]`, entry, '.js');
      continue;
    }
    if (Object.keys(entry)[0] !== 'types')
      failures.push(`exports[${key}] must list "types" before "default"`);
    target(`exports[${key}].types`, entry.types, '.d.ts');
    target(`exports[${key}].default`, entry.default, '.js');
  }
  for (const key of Object.keys(map))
    if (!ENTRY_POINTS.includes(key))
      failures.push(`exports declares an unexpected entry point: ${key}`);
  for (const field of DEPENDENCY_FIELDS)
    for (const name of Object.keys(manifest[field] ?? {}))
      failures.push(`${field} declares ${name}; the package must have none`);
  return failures;
}

/**
 * Failures for the workspace manifest: the in-repo `exports` and the
 * published `publishConfig.exports` must name the same entry points, or an
 * entry added for Station would silently not ship.
 */
export function checkPublishConfigParity(manifest) {
  const failures = [];
  const local = Object.keys(manifest.exports ?? {}).sort();
  const published = Object.keys(manifest.publishConfig?.exports ?? {}).sort();
  if (JSON.stringify(local) !== JSON.stringify(published))
    failures.push(
      `exports (${local.join(', ')}) and publishConfig.exports (${published.join(', ')}) name different entry points`,
    );
  for (const key of ENTRY_POINTS)
    if (!local.includes(key))
      failures.push(`exports no longer declares the ${key} entry point`);
  for (const key of local)
    if (!ENTRY_POINTS.includes(key))
      failures.push(
        `exports declares ${key}; add it to ENTRY_POINTS in scripts/monument-pack-smoke.mjs so the smoke covers it`,
      );
  return failures;
}

/**
 * Failures for shipped modules: a specifier must be a `node:` builtin or a
 * file inside `dist/`. `files` is `[{ path: 'dist/x.js', text }]`.
 */
export function checkShippedImports(files) {
  const failures = [];
  for (const { path, text } of files) {
    for (const reference of moduleReferences(path, text)) {
      const { specifier } = reference;
      const where = `${path}:${reference.line}`;
      if (specifier === null || reference.how === 'module-loader') {
        failures.push(`${where} loads a module the smoke cannot read`);
      } else if (specifier.startsWith('node:')) {
        // builtin
      } else if (specifier.startsWith('.')) {
        const resolved = posix.normalize(
          posix.join(posix.dirname(path), specifier),
        );
        if (!resolved.startsWith('dist/'))
          failures.push(`${where} imports ${specifier}, outside dist/`);
      } else {
        failures.push(
          `${where} imports ${specifier}${STATION_PACKAGE.test(specifier) ? ' (a Station package)' : ''}; only node: builtins and dist/ files may ship`,
        );
      }
    }
  }
  return failures;
}

function listFiles(root, base = root) {
  const found = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) found.push(...listFiles(full, base));
    else
      found.push(
        full
          .slice(base.length + 1)
          .split(sep)
          .join('/'),
      );
  }
  return found;
}

function outsideRepository(path, repoRoot) {
  const real = realpathSync(path);
  const root = realpathSync(repoRoot);
  return real !== root && !real.startsWith(root + sep);
}

/**
 * Smoke one artefact. Exactly one of `tarball` (a `.tgz`) or `spec`
 * (`name@version` on the registry). Resolves to the list of failures.
 */
export async function smokePackage({ repoRoot, tarball, spec }) {
  const failures = [];
  const work = mkdtempSync(join(tmpdir(), 'monument-pack-smoke-'));
  let preserveScratch = false;
  try {
    if (!outsideRepository(work, repoRoot)) {
      failures.push(`scratch directory ${work} is inside the repository`);
      return failures;
    }
    let archive = tarball;
    if (spec) {
      const fetched = await run(
        'npm',
        ['pack', spec, '--pack-destination', work],
        {
          cwd: work,
          env: plainEnvironment(),
        },
      );
      if (!fetched.ok) {
        failures.push(`could not fetch ${spec}: ${fetched.describe()}`);
        return failures;
      }
      archive = join(work, fetched.stdout.trim().split('\n').at(-1));
    }

    // 1. The tarball's own listing.
    const listing = await run('tar', ['-tzf', archive], {
      timeoutMs: QUICK_STEP_TIMEOUT_MS,
    });
    if (!listing.ok) {
      failures.push(`could not list the tarball: ${listing.describe()}`);
      return failures;
    }
    failures.push(
      ...checkTarballListing(listing.stdout.split('\n').filter(Boolean)),
    );

    // 2. Install it as a consumer would.
    const consumer = join(work, 'consumer');
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, 'package.json'),
      `${JSON.stringify({ name: 'monument-smoke-consumer', private: true, type: 'module' })}\n`,
    );
    const installed = await run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        ...(spec ? [] : ['--offline']),
        spec ?? archive,
      ],
      { cwd: consumer, env: plainEnvironment() },
    );
    if (!installed.ok) {
      failures.push(`npm install failed: ${installed.describe()}`);
      return failures;
    }
    const packageRoot = join(
      consumer,
      'node_modules',
      ...PACKAGE_NAME.split('/'),
    );
    if (!existsSync(join(packageRoot, 'package.json'))) {
      failures.push(
        `npm installed no ${PACKAGE_NAME} (expected ${packageRoot}); is the tarball or spec that package?`,
      );
      return failures;
    }
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    );
    failures.push(
      ...checkConsumerManifest(manifest, (path) =>
        existsSync(join(packageRoot, path)),
      ),
    );

    // 3. Nothing but node: builtins and dist/ files can load.
    const modules = listFiles(packageRoot)
      .filter(
        (path) => path.startsWith('dist/') && /\.(?:js|d\.ts)$/.test(path),
      )
      .map((path) => ({
        path,
        text: readFileSync(join(packageRoot, path), 'utf8'),
      }));
    if (modules.length === 0)
      failures.push('the installed package has no dist/ modules');
    failures.push(...checkShippedImports(modules));

    // 4. Plain node: no loader, no flag.
    writeFileSync(join(consumer, 'run.mjs'), RUN_SCRIPT);
    const plain = await run(process.execPath, ['run.mjs'], {
      cwd: consumer,
      env: plainEnvironment(),
      timeoutMs: QUICK_STEP_TIMEOUT_MS,
    });
    if (!plain.ok)
      failures.push(`plain node import failed: ${plain.describe()}`);

    // 5. Declarations resolve for a TypeScript consumer.
    const typeRoots = join(repoRoot, 'node_modules', '@types');
    if (!existsSync(typeRoots)) {
      failures.push(
        `cannot type-check: ${typeRoots} is missing (run npm run dependencies:ci)`,
      );
    } else {
      writeFileSync(join(consumer, 'check.ts'), CHECK_SCRIPT);
      writeFileSync(
        join(consumer, 'tsconfig.json'),
        `${JSON.stringify({
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            target: 'ES2022',
            strict: true,
            noEmit: true,
            skipLibCheck: false,
            types: ['node'],
            typeRoots: [typeRoots],
          },
          files: ['check.ts'],
        })}\n`,
      );
      const types = await run(
        process.execPath,
        [join(repoRoot, 'scripts', 'tsc-slot.mjs'), '-p', 'tsconfig.json'],
        { cwd: consumer, env: plainEnvironment() },
      );
      if (!types.ok)
        failures.push(`type declarations do not resolve: ${types.describe()}`);
    }
    return failures;
  } catch (error) {
    preserveScratch = error?.code === 'MONUMENT_PROCESS_UNSETTLED';
    throw error;
  } finally {
    if (!preserveScratch) rmSync(work, { recursive: true, force: true });
    else console.error(`Unsettled process scratch retained: ${work}`);
  }
}

/** Build `dist/` and pack with pnpm into `destination`; returns the `.tgz`. */
export async function packMonument({ repoRoot, destination, build = true }) {
  const cwd = join(repoRoot, MONUMENT_DIR);
  if (build) {
    const built = await run('npm', ['run', 'build'], { cwd });
    if (!built.ok) throw new Error(`build failed: ${built.describe()}`);
  }
  const packed = await run(
    'pnpm',
    ['pack', '--pack-destination', destination],
    {
      cwd,
    },
  );
  if (!packed.ok) throw new Error(`pnpm pack failed: ${packed.describe()}`);
  const tarballs = readdirSync(destination).filter((name) =>
    name.endsWith('.tgz'),
  );
  if (tarballs.length !== 1)
    throw new Error(
      `expected one tarball in ${destination}, found ${tarballs.length}`,
    );
  return join(destination, tarballs[0]);
}

function parseArguments(argv) {
  const options = { build: true, ifPublishable: false, isPublic: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--no-build') options.build = false;
    else if (argument === '--if-publishable') options.ifPublishable = true;
    else if (argument === '--is-public') options.isPublic = true;
    else if (
      argument === '--tarball' ||
      argument === '--spec' ||
      argument === '--manifest'
    ) {
      index += 1;
      const value = argv[index];
      if (!value) throw new Error(`${argument} needs a value`);
      options[argument.slice(2)] = value;
    } else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.tarball && options.spec)
    throw new Error('pass at most one of --tarball and --spec');
  return options;
}

async function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(2);
  }
  const manifestPath =
    options.manifest ?? join(repoRoot, MONUMENT_DIR, 'package.json');
  let manifest;
  let isPublic;
  try {
    const manifestText = readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(manifestText);
    isPublic = monumentIsPublic(manifestText);
  } catch (error) {
    console.error(`FAIL: cannot read ${manifestPath}: ${error.message}`);
    process.exit(1);
  }
  if (options.isPublic) {
    // The publish workflow's gate: one line, `public=true|false`.
    const line = `public=${isPublic}`;
    console.log(line);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
    return;
  }
  if (options.ifPublishable && !isPublic) {
    console.log(
      `SKIP: ${PACKAGE_NAME} is private; nothing to publish, nothing to smoke.`,
    );
    return;
  }
  const failures = [];
  const scratch = mkdtempSync(join(tmpdir(), 'monument-pack-'));
  let preserveScratch = false;
  try {
    let tarball = options.tarball && resolve(options.tarball);
    if (!tarball && !options.spec) {
      failures.push(...checkPublishConfigParity(manifest));
      tarball = await packMonument({
        repoRoot,
        destination: scratch,
        build: options.build,
      });
    }
    failures.push(
      ...(await smokePackage({ repoRoot, tarball, spec: options.spec })),
    );
  } catch (error) {
    preserveScratch = error?.code === 'MONUMENT_PROCESS_UNSETTLED';
    failures.push(error.message);
  } finally {
    if (!preserveScratch) rmSync(scratch, { recursive: true, force: true });
    else console.error(`Unsettled process scratch retained: ${scratch}`);
  }
  if (failures.length > 0) {
    console.error(
      `FAIL: ${PACKAGE_NAME} consumer smoke: ${failures.length} problem(s)`,
    );
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(
    `OK: ${PACKAGE_NAME} consumer smoke: ${ENTRY_POINTS.length} entry points import under plain node and type-check.`,
  );
}

if (invokedDirectly(import.meta.url)) await main();
