import { spawnSync } from 'node:child_process';
import { existsSync, opendirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  nodeMajor,
  SUPPORTED_NODE_MAJOR,
  SUPPORTED_NODE_RANGE,
} from './node-runtime-contract.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_CANDIDATES = 12;
const MAX_DIRECTORY_ENTRIES = 64;
const DISCOVERY_DEADLINE_MS = 5_000;
const PROBE_TIMEOUT_MS = 1_500;

function versionedNodeCandidates(root, prefix, suffix, deadline) {
  if (!existsSync(root)) return [];
  const matches = [];
  let directory;
  try {
    directory = opendirSync(root);
  } catch {
    return [];
  }
  try {
    for (let index = 0; index < MAX_DIRECTORY_ENTRIES; index += 1) {
      if (Date.now() >= deadline) break;
      const entry = directory.readSync();
      if (!entry) break;
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        matches.push(entry.name);
        matches.sort((left, right) => right.localeCompare(left));
        if (matches.length > 2) matches.length = 2;
      }
    }
  } finally {
    directory.closeSync();
  }
  return matches.map((entry) => join(root, entry, suffix));
}

function probeEnvironment(env, executable) {
  return {
    HOME: env.HOME,
    PATH: dirname(executable),
    SystemRoot: env.SystemRoot,
    TMPDIR: env.TMPDIR,
    TEMP: env.TEMP,
    TMP: env.TMP,
  };
}

export function probeNodeExecutable(
  executable,
  env = process.env,
  timeout = PROBE_TIMEOUT_MS,
) {
  const result = spawnSync(
    executable,
    [
      '-e',
      'process.stdout.write(JSON.stringify({name:process.release?.name,version:process.version,execPath:process.execPath}))',
    ],
    {
      encoding: 'utf8',
      env: probeEnvironment(env, executable),
      timeout,
      windowsHide: true,
    },
  );
  if (result.status !== 0) return null;
  try {
    const report = JSON.parse(result.stdout);
    if (report.name !== 'node' || typeof report.version !== 'string')
      return null;
    if (realpathSync(report.execPath) !== executable) return null;
    return report;
  } catch {
    return null;
  }
}

export function assertTrustedPath(target, label = 'Runtime path') {
  const canonical = realpathSync(target);
  const targetMetadata = statSync(canonical);
  if (!targetMetadata.isFile()) {
    throw new Error(`${label} is not a regular file: ${canonical}.`);
  }
  if (process.platform === 'win32') return canonical;

  const currentUid = process.getuid?.();
  let cursor = canonical;
  while (true) {
    const metadata = statSync(cursor);
    if (metadata.uid !== 0 && metadata.uid !== currentUid) {
      throw new Error(`${label} has an untrusted owner: ${cursor}.`);
    }
    if ((metadata.mode & 0o022) !== 0) {
      throw new Error(`${label} is group/world-writable: ${cursor}.`);
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return canonical;
}

function directNodeCandidates(env, currentExecutable) {
  return [
    currentExecutable,
    env.STATION_NODE && isAbsolute(env.STATION_NODE) ? env.STATION_NODE : null,
  ].filter(Boolean);
}

export function nodeManagerRootSpecs({
  env = process.env,
  home = homedir(),
  platform = process.platform,
} = {}) {
  const executable = platform === 'win32' ? 'node.exe' : join('bin', 'node');
  const major = String(SUPPORTED_NODE_MAJOR);
  const specs = [
    [
      env.MISE_DATA_DIR && join(env.MISE_DATA_DIR, 'installs/node'),
      major,
      executable,
    ],
    [join(home, '.local/share/mise/installs/node'), major, executable],
    [
      env.NVM_DIR && join(env.NVM_DIR, 'versions/node'),
      `v${major}.`,
      executable,
    ],
    [join(home, '.nvm/versions/node'), `v${major}.`, executable],
    [
      env.FNM_DIR && join(env.FNM_DIR, 'node-versions'),
      `v${major}.`,
      join('installation', executable),
    ],
    [
      join(home, '.fnm/node-versions'),
      `v${major}.`,
      join('installation', executable),
    ],
    [
      env.VOLTA_HOME && join(env.VOLTA_HOME, 'tools/image/node'),
      `${major}.`,
      executable,
    ],
    [join(home, '.volta/tools/image/node'), `${major}.`, executable],
  ];
  if (platform === 'win32') {
    specs.push(
      [
        env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'mise/installs/node'),
        major,
        'node.exe',
      ],
      [
        env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Volta/tools/image/node'),
        `${major}.`,
        'node.exe',
      ],
      [env.NVM_HOME, `v${major}.`, 'node.exe'],
    );
  }
  return specs.filter(([root]) => root);
}

function managerNodeCandidates(options, deadline) {
  const candidates = [];
  const seen = new Set();
  for (const [root, prefix, suffix] of nodeManagerRootSpecs(options)) {
    const key = `${root}\0${prefix}\0${suffix}`;
    if (seen.has(key) || Date.now() >= deadline) continue;
    seen.add(key);
    candidates.push(...versionedNodeCandidates(root, prefix, suffix, deadline));
  }
  return candidates;
}

function platformNodeCandidates(env, platform) {
  if (platform === 'win32') {
    return [
      env.NVM_SYMLINK && join(env.NVM_SYMLINK, 'node.exe'),
      env.NVM_HOME && join(env.NVM_HOME, 'node.exe'),
    ];
  }
  return [
    '/opt/homebrew/opt/node@24/bin/node',
    '/usr/local/opt/node@24/bin/node',
  ];
}

export function discoverNodeCandidates({
  env = process.env,
  currentExecutable = process.execPath,
  home = homedir(),
  platform = process.platform,
  deadline = Date.now() + DISCOVERY_DEADLINE_MS,
} = {}) {
  const options = { env, home, platform };
  const candidates = [
    ...directNodeCandidates(env, currentExecutable),
    ...managerNodeCandidates(options, deadline),
    ...platformNodeCandidates(env, platform),
  ];
  return [...new Set(candidates.filter(Boolean))].slice(0, MAX_CANDIDATES);
}

function probeCandidates(candidates, state) {
  for (const candidate of candidates) {
    const remaining = state.deadline - Date.now();
    if (remaining <= 0 || state.checked.length >= MAX_CANDIDATES) return null;
    if (!existsSync(candidate)) continue;
    let executable;
    try {
      executable = assertTrustedPath(candidate, 'Node executable');
    } catch {
      continue;
    }
    if (state.checked.some((entry) => entry.executable === executable))
      continue;
    const report = state.probe(
      executable,
      state.env,
      Math.min(PROBE_TIMEOUT_MS, remaining),
    );
    const version = report?.version ?? '';
    state.checked.push({ executable, version });
    if (nodeMajor(version) === SUPPORTED_NODE_MAJOR) {
      return { executable, version };
    }
  }
  return null;
}

export function resolveSupportedNode(options = {}) {
  const env = options.env ?? process.env;
  const probe = options.probe ?? probeNodeExecutable;
  const deadline = Date.now() + (options.deadlineMs ?? DISCOVERY_DEADLINE_MS);
  const state = { checked: [], deadline, env, probe };
  const directCandidates =
    options.candidates ??
    directNodeCandidates(env, options.currentExecutable ?? process.execPath);
  const directRuntime = probeCandidates(directCandidates, state);
  if (directRuntime) return directRuntime;

  if (!options.candidates) {
    const discoveryOptions = {
      env,
      home: options.home ?? homedir(),
      platform: options.platform ?? process.platform,
    };
    const discoveredRuntime = probeCandidates(
      [
        ...managerNodeCandidates(discoveryOptions, deadline),
        ...platformNodeCandidates(env, discoveryOptions.platform),
      ],
      state,
    );
    if (discoveredRuntime) return discoveredRuntime;
  }

  const observed = state.checked
    .filter((entry) => entry.version)
    .map((entry) => `${entry.version} at ${entry.executable}`)
    .join(', ');
  throw new Error(
    `Station local verification requires Node.js ${SUPPORTED_NODE_RANGE}, but no supported executable was found${observed ? ` (checked ${observed})` : ''}. Install the version in .nvmrc or set STATION_NODE to its executable path.`,
  );
}

export function pinnedNodeEnvironment(runtime, env = process.env) {
  const pinned = {
    ...env,
    PATH: [dirname(runtime.executable), env.PATH]
      .filter(Boolean)
      .join(delimiter),
    STATION_NODE: runtime.executable,
  };
  for (const key of Object.keys(pinned)) {
    if (['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())) {
      delete pinned[key];
    }
  }
  return pinned;
}

export function resolveTrustedNpmCli(runtime) {
  const installationRoot =
    process.platform === 'win32'
      ? dirname(runtime.executable)
      : dirname(dirname(runtime.executable));
  const npmCliCandidates = [
    join(dirname(runtime.executable), '../lib/node_modules/npm/bin/npm-cli.js'),
    join(dirname(runtime.executable), 'node_modules/npm/bin/npm-cli.js'),
  ];
  const npmCli = npmCliCandidates.find(
    (candidate) => candidate && existsSync(candidate),
  );
  if (!npmCli) {
    throw new Error(
      `Node ${runtime.version} was found at ${runtime.executable}, but its npm CLI could not be resolved.`,
    );
  }
  const canonical = assertTrustedPath(npmCli, 'npm CLI');
  const relativePath = relative(installationRoot, canonical);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `npm CLI escapes the selected Node installation: ${canonical}.`,
    );
  }
  return canonical;
}

function defaultVerificationCommand(runtime) {
  return [
    runtime.executable,
    [resolveTrustedNpmCli(runtime), 'run', 'verify:static'],
  ];
}

export function runLocalVerification({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = repoRoot,
  runtime = resolveSupportedNode({ env }),
} = {}) {
  const revalidatedExecutable = assertTrustedPath(
    runtime.executable,
    'Node executable',
  );
  const confirmed = probeNodeExecutable(runtime.executable, env);
  if (
    revalidatedExecutable !== runtime.executable ||
    !confirmed ||
    confirmed.version !== runtime.version ||
    nodeMajor(confirmed.version) !== SUPPORTED_NODE_MAJOR
  ) {
    throw new Error(
      `Resolved Node executable changed before verification: ${runtime.executable}.`,
    );
  }
  const separator = argv.indexOf('--');
  let command;
  let args;
  let npmCli;
  if (separator >= 0) {
    [command, ...args] = argv.slice(separator + 1);
    if (!command) throw new Error('Expected a command after --.');
  } else if (argv.length > 0) {
    throw new Error(
      'Pass an override command after --, or omit arguments to run verify:static.',
    );
  } else {
    [command, args] = defaultVerificationCommand(runtime);
    npmCli = args[0];
  }

  assertTrustedPath(runtime.executable, 'Node executable');
  if (npmCli && resolveTrustedNpmCli(runtime) !== npmCli) {
    throw new Error('npm CLI changed before verification.');
  }

  console.log(
    `[local-verification] Node ${runtime.version} at ${runtime.executable}`,
  );
  const result = spawnSync(command, args, {
    cwd,
    env: pinnedNodeEnvironment(runtime, env),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.signal ? 1 : (result.status ?? 1);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    process.exitCode = runLocalVerification();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
