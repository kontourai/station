#!/usr/bin/env node
/**
 * The only supported dependency bootstrap. Phase one is inert; before phase
 * two we inspect every installed lifecycle package and grant only the exact
 * reviewed commands. Dependency hooks resolve reviewed local files; the
 * package manager's exact version is verified before it is used.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareDependencyInstallDrivers,
  withDependencyInstallGuard,
} from './lib/dependency-install-retirement.mjs';
import {
  assertNodePtyPrebuildConsistency,
  confinedPackageTarget,
  degradableLifecycleCapability,
  evaluateLifecyclePolicy,
  expectedLifecyclePurls,
  installedPackagePath,
  isArtifactAbsent,
  optionalPackageMayBeAbsent,
  platformMatches,
  preflightLifecycleArtifactTargets,
  prepareLifecycleArtifacts,
  readLifecycleLocks,
  readNodePtyPrebuildManifest,
  stageNodePtyPrebuild,
  validateAllowlist,
  verifyArtifact,
} from './lib/dependency-lifecycle-policy.mjs';
import { readPnpmWorkspace } from './lib/pnpm-lockfile.mjs';
import { assertWorkspaceDependencySatisfaction } from './lib/workspace-dependency-satisfaction.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowlistPath = resolve(
  root,
  'config/dependency-lifecycle-allowlist.json',
);
const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall'];

function loadPolicy() {
  return JSON.parse(readFileSync(allowlistPath, 'utf8'));
}

export function check({ cwd = root, bootstrap = false } = {}) {
  const allowlist = loadPolicy();
  if (bootstrap && !existsSync(resolve(cwd, 'pnpm-lock.yaml')))
    throw new Error('dependency lockfile is missing: pnpm-lock.yaml');
  const findings = bootstrap
    ? validateAllowlist(allowlist)
    : evaluateLifecyclePolicy({
        allowlist,
        nodes: readLifecycleLocks(cwd),
      });
  if (!bootstrap && existsSync(resolve(cwd, 'pnpm-lock.yaml'))) {
    const workspace = readPnpmWorkspace(cwd);
    if (
      workspace.verifyDepsBeforeRun !== false ||
      workspace.ignoreScripts !== true
    )
      findings.push(
        'pnpm workspace must disable automatic installs and dependency lifecycle scripts',
      );
  }
  if (findings.length)
    throw new Error(
      `dependency lifecycle policy failed:\n${findings.map((finding) => `- ${finding}`).join('\n')}`,
    );
  // #1245: a pinned Linux prebuild and its allowlist verification path must
  // flip together; any mixed state either verifies a file staging never
  // wrote or skips verifying the file the loader actually uses.
  assertNodePtyPrebuildConsistency(allowlist, readNodePtyPrebuildManifest(cwd));
  return allowlist;
}

function checkedFile(path, description) {
  if (!path || !existsSync(path) || !statSync(path).isFile())
    throw new Error(`cannot resolve ${description} as a local file`);
  return path;
}

export function resolveNpmCli(env = process.env, node = process.execPath) {
  const fromNpm = env.npm_execpath;
  if (fromNpm) {
    if (!isAbsolute(fromNpm) || !/npm-cli\.js$/.test(fromNpm))
      throw new Error('npm_execpath must name an absolute npm-cli.js file');
    return checkedFile(fromNpm, 'npm CLI');
  }
  // Node distributions ship npm beside their node binary. Windows keeps it in
  // `node_modules` next to node.exe; Unix distributions conventionally use
  // the sibling `lib/node_modules`. Both are explicit JS entries, never .cmd.
  const candidates = [
    resolve(dirname(node), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  return checkedFile(candidates.find(existsSync), 'npm CLI');
}

function command(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    timeout: options.timeout ?? 120_000,
    env: { ...process.env, ...options.env },
    windowsHide: true,
  });
}

export const INERT_INSTALL_TIMEOUT_ENV =
  'STATION_DEPENDENCY_INSTALL_TIMEOUT_MS';

export function inertInstallTimeout(
  platform = process.platform,
  env = process.env,
) {
  const override = env?.[INERT_INSTALL_TIMEOUT_ENV];
  if (override !== undefined && override !== '') {
    // Only a positive, finite, integral millisecond count is a timeout. A
    // malformed value is a mistake in the caller's environment, not a licence
    // to fall back to a default they believed they had replaced.
    const parsed = Number(override);
    if (!Number.isSafeInteger(parsed) || parsed <= 0)
      throw new Error(
        `${INERT_INSTALL_TIMEOUT_ENV} must be a positive whole number of milliseconds; received ${JSON.stringify(override)}`,
      );
    return parsed;
  }
  return platform === 'win32' ? 1_200_000 : 600_000;
}

/** npm is supplied by Node; it bootstraps exactly the reviewed pnpm pin.
 * npm exec's cache is shared without sharing the worktree's installed files.
 */
export function pnpmInvocation({
  cwd = root,
  env = process.env,
  node = process.execPath,
  platform = process.platform,
  exec = execFileSync,
} = {}) {
  const manifest = JSON.parse(
    readFileSync(resolve(cwd, 'package.json'), 'utf8'),
  );
  if (!/^pnpm@11\.\d+\.\d+$/.test(manifest.packageManager ?? ''))
    throw new Error('packageManager must pin an exact pnpm 11 version');
  const expected = manifest.packageManager.slice('pnpm@'.length);
  const fromPnpm = env.npm_execpath;
  const candidates = [];
  if (
    fromPnpm &&
    isAbsolute(fromPnpm) &&
    /[/\\]pnpm(?:\.(?:[cm]?js|exe))?$/.test(fromPnpm)
  )
    candidates.push(fromPnpm);
  for (const directory of (env.PATH ?? env.Path ?? '').split(
    platform === 'win32' ? ';' : delimiter,
  )) {
    if (!isAbsolute(directory)) continue;
    candidates.push(
      resolve(directory, platform === 'win32' ? 'pnpm.exe' : 'pnpm'),
    );
    // Script installations expose .cmd on Windows; resolve their JS entry
    // directly instead of invoking cmd.exe or interpolating shell arguments.
    if (platform === 'win32')
      candidates.push(
        resolve(directory, '../pnpm/bin/pnpm.cjs'),
        resolve(directory, 'node_modules/pnpm/bin/pnpm.cjs'),
      );
  }
  const candidate = candidates.find(
    (path) => existsSync(path) && statSync(path).isFile(),
  );
  if (candidate) {
    const cli = realpathSync(candidate);
    const invocation = /\.[cm]?js$/.test(cli)
      ? { command: node, args: [cli] }
      : { command: cli, args: [] };
    // A package manager may replace its own tree during install. Reject any
    // driver inside it before even invoking that driver's version probe.
    prepareDependencyInstallDrivers({
      root: cwd,
      nodePath: node,
      commandPath: invocation.command,
      scriptPath: invocation.args[0],
      clean: true,
    });
    const ownerPath = resolve(dirname(cli), '../package.json');
    let corepackShim = false;
    if (/\.[cm]?js$/.test(cli) && existsSync(ownerPath)) {
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
      corepackShim = owner.name === 'corepack';
      if (owner.name === 'pnpm' && owner.version !== expected)
        throw new Error('invoking pnpm version does not match packageManager');
    }
    let version;
    try {
      version = exec(invocation.command, [...invocation.args, '--version'], {
        cwd,
        env: { ...env, COREPACK_ENABLE_NETWORK: '0' },
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      }).trim();
    } catch (error) {
      // A Corepack shim can exist without the pinned manager installed.
      // Keep its network disabled and bootstrap the explicit pin via npm.
      if (
        !corepackShim ||
        !String(error?.stderr ?? error?.message ?? error).includes(
          'Network access disabled by the environment',
        )
      )
        throw error;
    }
    if (version !== undefined && version !== expected)
      throw new Error(
        `installed pnpm version ${version} does not match packageManager ${expected}`,
      );
    if (version !== undefined) return invocation;
  }
  const npmEnv = { ...env };
  if (npmEnv.npm_execpath && !/npm-cli\.js$/.test(npmEnv.npm_execpath))
    delete npmEnv.npm_execpath;
  return {
    command: node,
    args: [
      resolveNpmCli(npmEnv, node),
      'exec',
      '--yes',
      `--package=${manifest.packageManager}`,
      '--',
      'pnpm',
    ],
  };
}

export function pnpmCommand(
  args,
  cwd = root,
  invocation = pnpmInvocation({ cwd }),
) {
  command(invocation.command, [...invocation.args, ...args], {
    cwd,
    timeout: inertInstallTimeout(),
    env: { npm_config_ignore_scripts: 'true' },
  });
}

/** Refresh resolution only; callers review dependency policy before installing. */
export function refreshLock({ cwd = process.cwd() } = {}) {
  command(process.execPath, [
    resolve(root, 'scripts/node-runtime-contract.mjs'),
  ]);
  pnpmCommand(
    ['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile'],
    cwd,
  );
}

function approvedScripts(entry) {
  return Object.fromEntries(
    entry.hooks.map((hook) => [hook.name, hook.command]),
  );
}

function installedLifecycleScripts(packageRoot) {
  const manifest = JSON.parse(
    readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
  );
  return Object.fromEntries(
    LIFECYCLE_HOOKS.flatMap((name) =>
      typeof manifest.scripts?.[name] === 'string'
        ? [[name, manifest.scripts[name]]]
        : [],
    ),
  );
}

/** Validate every hook set before one approved script has a chance to run. */
export function preflightInstalledLifecycle(
  allowlist,
  { cwd = root, scope = 'root' } = {},
) {
  const ready = [];
  for (const entry of allowlist.entries.filter(
    (entry) => entry.scope === scope,
  )) {
    let packageRoot;
    try {
      packageRoot = installedPackagePath(cwd, entry);
    } catch (error) {
      if (optionalPackageMayBeAbsent(cwd, entry)) continue;
      throw error;
    }
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
    );
    if (manifest.name !== entry.name || manifest.version !== entry.version)
      throw new Error(
        `installed package identity drift for ${entry.lock}:${entry.path}`,
      );
    if (
      JSON.stringify(installedLifecycleScripts(packageRoot)) !==
      JSON.stringify(approvedScripts(entry))
    )
      throw new Error(`hook set drift for ${entry.lock}:${entry.path}`);
    ready.push({ entry, packageRoot });
  }
  return ready;
}

function confinedFile(packageRoot, relativePath) {
  return confinedPackageTarget(
    packageRoot,
    relativePath,
    `reviewed hook ${relativePath}`,
  );
}

function lifecycleEnvironment(packageRoot, hook) {
  return {
    npm_config_ignore_scripts: 'true',
    npm_lifecycle_event: hook.name,
    npm_lifecycle_script: hook.command,
    PATH: [
      resolve(packageRoot, 'node_modules/.bin'),
      dirname(process.execPath),
      process.env.PATH ?? '',
    ].join(process.platform === 'win32' ? ';' : ':'),
  };
}

function runExactHook(packageRoot, hook) {
  const nodeScript = /^node ([A-Za-z0-9_./-]+\.m?js)$/.exec(hook.command);
  const prebuildFallback =
    /^node (scripts\/prebuild\.js) \|\| node-gyp rebuild$/.exec(hook.command);
  const env = lifecycleEnvironment(packageRoot, hook);
  if (nodeScript) {
    command(process.execPath, [confinedFile(packageRoot, nodeScript[1])], {
      cwd: packageRoot,
      env,
    });
    return;
  }
  if (prebuildFallback) {
    try {
      command(
        process.execPath,
        [confinedFile(packageRoot, prebuildFallback[1])],
        {
          cwd: packageRoot,
          env,
        },
      );
      return;
    } catch {
      // node-gyp is npm's trusted toolchain dependency and is commonly
      // hoisted. Resolve its JS entry from Station's root manifest, rather
      // than pretending a root-hoisted file is package-local.
      const nodeGyp = checkedFile(
        createRequire(resolve(root, 'package.json')).resolve(
          'node-gyp/bin/node-gyp.js',
        ),
        'trusted local node-gyp entry',
      );
      command(process.execPath, [nodeGyp, 'rebuild'], {
        cwd: packageRoot,
        env,
      });
      return;
    }
  }
  throw new Error(`unsupported reviewed lifecycle command: ${hook.command}`);
}

/**
 * #1244: a degradable entry's failure becomes a loud capability report, not
 * an aborted install. One fixed, greppable line shape so `install.sh` logs,
 * CI receipts, and humans all find it: `DEGRADED <capability>: ...`.
 */
/**
 * Every message in an error's `cause` chain, outermost first.
 *
 * `retireDependencyInstall` (scripts/lib/dependency-install-retirement.mjs)
 * reports a verification failure as "Dependencies are not verified. Installer
 * state is retained at <dir>" and attaches the real reason as `cause`. This
 * CLI printed only `error.message`, so CI logs named a directory on the runner
 * -- which is never uploaded -- and no constraint at all. The failure was
 * diagnosable only by reproducing it locally.
 *
 * Bounded rather than trusted: a dependency's own error text lands in this
 * chain, so depth is capped and each message truncated.
 */
export function describeFailure(
  error,
  { maxDepth = 8, maxLength = 2000 } = {},
) {
  const lines = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; current !== undefined && depth < maxDepth; depth += 1) {
    if (typeof current === 'object' && current !== null) {
      if (seen.has(current)) break;
      seen.add(current);
    }
    const message = String(
      current instanceof Error ? current.message : current,
    ).slice(0, maxLength);
    if (message !== '')
      lines.push(depth === 0 ? message : `  caused by: ${message}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  return lines.length > 0 ? lines.join('\n') : String(error);
}

/**
 * What the CLI prints, and the exit code it sets, when an operation throws.
 *
 * Separated from `main`'s catch so the REPORTING is covered rather than only
 * the formatter: a test that exercises `describeFailure` alone still passes if
 * the catch goes back to printing `error.message`, which is how the cause was
 * being discarded in the first place. Verified by fault injection -- reverting
 * this to `error.message` reddens `reports the cause chain` below.
 */
export function reportCliFailure(error, { log = console.error } = {}) {
  log(describeFailure(error));
  return 1;
}

function reportDegradedCapability(entry, phase, error) {
  const degradable = degradableLifecycleCapability(entry);
  const cause = String(error instanceof Error ? error.message : error)
    .split(/\r?\n/, 1)[0]
    .trim();
  console.warn(
    `[dependency-lifecycle] DEGRADED ${degradable.capability}: ${entry.name} ${phase} failed — ${degradable.consequence}. Remediation: ${degradable.remediation}. Cause: ${cause}`,
  );
}

export function runApprovedHooks(allowlist, { cwd = root } = {}) {
  const ready = preflightInstalledLifecycle(allowlist, { cwd });
  for (const { entry } of ready)
    if (entry.decision === 'execute' && platformMatches(entry))
      preflightLifecycleArtifactTargets(cwd, entry);
  for (const { entry, packageRoot } of ready) {
    if (entry.decision !== 'execute' || !platformMatches(entry)) continue;
    console.log(
      `[dependency-lifecycle] approved build ${entry.lock}:${entry.path}`,
    );
    let built = true;
    try {
      for (const hook of entry.hooks) {
        const started = performance.now();
        runExactHook(packageRoot, hook);
        console.log(
          `[dependency-lifecycle] executed ${entry.lock}:${entry.path}:${hook.name} in ${Math.round(performance.now() - started)}ms`,
        );
      }
    } catch (error) {
      // #1244: only an entry that backs a degradable capability (today:
      // node-pty/terminal) may convert a failed BUILD into a loud degraded
      // install — typically a Linux host without a C++ toolchain. Every
      // other lifecycle failure still aborts, and the tamper/confinement
      // preflights above ran before any hook, so this never bypasses them.
      if (!degradableLifecycleCapability(entry)) throw error;
      reportDegradedCapability(entry, 'build', error);
      built = false;
    }
    // Artifact preparation is outside that catch on purpose. It enforces
    // confinement and restores only the approved execute bit, so its failure
    // is a trust-boundary result rather than "no compiler here" — it must
    // abort even for a degradable entry. Skipped when the build did not
    // produce anything to prepare.
    if (built) prepareLifecycleArtifacts(cwd, entry);
  }
}

/**
 * Runs every root artifact proof. A failure on an entry backing a degradable
 * capability (#1244, see `degradableLifecycleCapability`) becomes a loud
 * DEGRADED report and a `{ degraded: true }` result instead of an aborted
 * verify; every other entry's failure still throws. The artifact proof
 * itself stays fail-closed — `verifyArtifact` threw before this caught it.
 */
export function verifyLifecycleArtifacts(allowlist, { cwd = root } = {}) {
  return allowlist.entries
    .filter(
      (entry) =>
        entry.scope === 'root' && !optionalPackageMayBeAbsent(cwd, entry),
    )
    .map((entry) => {
      try {
        return verifyArtifact(cwd, entry);
      } catch (error) {
        // Degrade ONLY when the artifact is absent. verifyArtifact also
        // rejects redirected or escaping paths, installed-version drift, a
        // non-file target, and a failed real-PTY handshake; accepting those
        // as degradation would let a tampered or mis-identified native module
        // pass as merely unavailable, which is the opposite of this gate's
        // purpose. Being the terminal-backing entry buys a pass on "was never
        // built", never on a trust-boundary result.
        if (!degradableLifecycleCapability(entry) || !isArtifactAbsent(error))
          throw error;
        reportDegradedCapability(entry, 'artifact verification', error);
        return {
          skipped: false,
          degraded: true,
          detail: `${entry.lock}:${entry.path}`,
        };
      }
    });
}

export function verify({ cwd = root } = {}) {
  const allowlist = check({ cwd });
  preflightInstalledLifecycle(allowlist, { cwd });
  // This is intentionally after npm ci and before every green lifecycle
  // receipt. It validates what Node will resolve from each workspace, not
  // merely the versions represented somewhere in a lockfile.
  assertWorkspaceDependencySatisfaction({ root: cwd });
  const results = verifyLifecycleArtifacts(allowlist, { cwd });
  for (const result of results) {
    if (result.degraded) continue;
    console.log(
      `[dependency-lifecycle] ${result.skipped ? 'NOT_APPLICABLE' : 'artifact'} ${result.detail}`,
    );
  }
  return { allowlist, purls: expectedLifecyclePurls(allowlist) };
}

function stationOwnedHooks() {
  command(process.execPath, ['scripts/node-runtime-contract.mjs']);
  if (existsSync(resolve(root, '.git')))
    command(process.execPath, ['scripts/install-git-hooks.mjs']);
  else
    console.log(
      '[dependency-lifecycle] NOT_APPLICABLE git hooks outside a checkout',
    );
}

function inertInstallArgs(developer) {
  return [
    'install',
    '--ignore-scripts',
    '--config.node-linker=hoisted',
    '--config.enable-global-virtual-store=false',
    '--package-import-method=clone-or-copy',
    developer ? '--no-frozen-lockfile' : '--frozen-lockfile',
  ];
}

/**
 * #1245: stage the pinned, attested node-pty Linux prebuild (when this
 * checkout ships one for this platform/arch) into the installed package
 * BEFORE its approved hook runs, so `node scripts/prebuild.js || node-gyp
 * rebuild` takes the prebuild branch and no C++ toolchain is required.
 * See packaging/node-pty-prebuilds/README.md for the trust chain.
 */
export function stageLifecyclePrebuilds(allowlist, { cwd = root } = {}) {
  for (const entry of allowlist.entries) {
    if (entry.scope !== 'root' || entry.artifact?.proof !== 'node-pty-smoke')
      continue;
    const result = stageNodePtyPrebuild(cwd, entry);
    console.log(
      result.staged
        ? `[dependency-lifecycle] staged pinned prebuild ${entry.lock}:${entry.path}:${result.target} (sha256 ${result.sha256.slice(0, 12)})`
        : `[dependency-lifecycle] prebuild staging skipped for ${entry.lock}:${entry.path}: ${result.reason}`,
    );
  }
}

/** Inject only execution, preserving the actual guarded production phase order. */
export function install(
  { developer = false } = {},
  execution = {
    root,
    nodePath: process.execPath,
    pnpmInvocation,
    command,
    check,
    pnpmCommand,
    stageLifecyclePrebuilds,
    runApprovedHooks,
    stationOwnedHooks,
    verify,
  },
) {
  const nodeDriver = prepareDependencyInstallDrivers({
    root: execution.root,
    nodePath: execution.nodePath,
    clean: true,
  });
  execution.command(
    nodeDriver.nodePath,
    ['scripts/node-runtime-contract.mjs'],
    { cwd: execution.root },
  );
  const invocation = execution.pnpmInvocation({
    cwd: execution.root,
    node: nodeDriver.nodePath,
  });
  const drivers = prepareDependencyInstallDrivers({
    root: execution.root,
    nodePath: nodeDriver.nodePath,
    commandPath: invocation.command,
    scriptPath: isAbsolute(invocation.args[0] ?? '')
      ? invocation.args[0]
      : undefined,
    clean: true,
  });
  const boundInvocation = {
    command: drivers.commandPath,
    args: drivers.scriptPath
      ? [drivers.scriptPath, ...invocation.args.slice(1)]
      : [...invocation.args],
  };
  const allowlist = execution.check({ cwd: execution.root, bootstrap: true });
  return withDependencyInstallGuard({
    root: execution.root,
    clean: false,
    retireLegacy: true,
    run: () => {
      execution.pnpmCommand(
        inertInstallArgs(developer),
        execution.root,
        boundInvocation,
      );
      execution.check({ cwd: execution.root });
      execution.stageLifecyclePrebuilds(allowlist, { cwd: execution.root });
      execution.runApprovedHooks(allowlist, { cwd: execution.root });
      execution.stationOwnedHooks();
      return execution.verify({ cwd: execution.root });
    },
  });
}

export function propose({ cwd = root } = {}) {
  const nodes = readLifecycleLocks(cwd);
  return JSON.stringify(
    {
      schemaVersion: 1,
      entries: nodes.map((node) => ({
        ...node,
        hooks: [],
        decision: 'REVIEW_REQUIRED',
        owner: 'REVIEW_REQUIRED',
        reason: 'Review whether this dependency needs its lifecycle script.',
        artifact: { path: 'REVIEW_REQUIRED', proof: 'REVIEW_REQUIRED' },
        triggers: ['dependency refresh'],
      })),
    },
    null,
    2,
  );
}

function usage() {
  console.error(
    'Usage: node scripts/dependency-lifecycle.mjs <check|propose|install|ci|verify|lock>',
  );
}

if (process.argv[1]?.endsWith('dependency-lifecycle.mjs')) {
  const operation = process.argv[2];
  try {
    if (operation === 'check') check();
    else if (operation === 'propose') console.log(propose());
    else if (operation === 'install') install({ developer: true });
    else if (operation === 'ci') install({ developer: false });
    else if (operation === 'verify') verify();
    else if (operation === 'lock') refreshLock();
    else {
      usage();
      process.exitCode = 2;
    }
  } catch (error) {
    process.exitCode = reportCliFailure(error);
  }
}
