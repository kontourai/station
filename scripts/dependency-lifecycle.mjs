#!/usr/bin/env node
/**
 * The only supported dependency bootstrap. Phase one is inert; before phase
 * two we inspect every installed lifecycle package and grant only the exact
 * reviewed commands. Nothing here resolves an executable by package name.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  confinedPackageTarget,
  degradableLifecycleCapability,
  evaluateLifecyclePolicy,
  expectedLifecyclePurls,
  installedPackagePath,
  optionalPackageMayBeAbsent,
  platformMatches,
  preflightLifecycleArtifactTargets,
  prepareLifecycleArtifacts,
  readLifecycleLocks,
  verifyArtifact,
} from './lib/dependency-lifecycle-policy.mjs';
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

export function check({ cwd = root } = {}) {
  const allowlist = loadPolicy();
  const findings = evaluateLifecyclePolicy({
    allowlist,
    nodes: readLifecycleLocks(cwd),
  });
  if (findings.length)
    throw new Error(
      `dependency lifecycle policy failed:\n${findings.map((finding) => `- ${finding}`).join('\n')}`,
    );
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

export function inertInstallTimeout(platform = process.platform) {
  return platform === 'win32' ? 1_200_000 : 600_000;
}

function npmCommand(args, cwd = root) {
  // A cold workspace install can legitimately exceed the short lifecycle-hook
  // bound. Windows cache misses may be slower; this remains finite at twenty
  // minutes there and ten minutes elsewhere. Lifecycle hooks stay at 2 minutes.
  command(process.execPath, [resolveNpmCli(), ...args], {
    cwd,
    timeout: inertInstallTimeout(),
  });
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
    try {
      for (const hook of entry.hooks) {
        const started = performance.now();
        runExactHook(packageRoot, hook);
        console.log(
          `[dependency-lifecycle] executed ${entry.lock}:${entry.path}:${hook.name} in ${Math.round(performance.now() - started)}ms`,
        );
      }
      prepareLifecycleArtifacts(cwd, entry);
    } catch (error) {
      // #1244: only an entry that backs a degradable capability (today:
      // node-pty/terminal) may convert a failed build into a loud degraded
      // install — typically a Linux host without a C++ toolchain. Every
      // other lifecycle failure still aborts, and the tamper/confinement
      // preflights above ran before any hook, so this never bypasses them.
      if (!degradableLifecycleCapability(entry)) throw error;
      reportDegradedCapability(entry, 'build', error);
    }
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
        if (!degradableLifecycleCapability(entry)) throw error;
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
  const patchPackage = createRequire(resolve(root, 'package.json')).resolve(
    'patch-package/index.js',
  );
  command(process.execPath, [patchPackage]);
  if (existsSync(resolve(root, '.git')))
    command(process.execPath, ['scripts/install-git-hooks.mjs']);
  else
    console.log(
      '[dependency-lifecycle] NOT_APPLICABLE git hooks outside a checkout',
    );
}

function inertInstall(developer) {
  const verb = developer ? 'install' : 'ci';
  npmCommand([verb, '--ignore-scripts']);
}

export function install({ developer = false } = {}) {
  // Node is a trust boundary for every following command. Check it before npm.
  command(process.execPath, ['scripts/node-runtime-contract.mjs']);
  const allowlist = check();
  inertInstall(developer);
  check();
  runApprovedHooks(allowlist);
  stationOwnedHooks();
  return verify();
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
    'Usage: node scripts/dependency-lifecycle.mjs <check|propose|install|ci|verify>',
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
    else {
      usage();
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
