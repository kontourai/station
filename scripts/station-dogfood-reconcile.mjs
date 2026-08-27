#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_LOCK_MAX_AGE_MS = 30 * 60 * 1000;
const REMOTE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const RECOVERY_HISTORY_LIMIT = 20;
const RUNTIME_LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOCAL_HEALTH_TIMEOUT_MS = 10_000;
// Absolute maximum expiry the zero-step billing CI waiver will ever accept.
// #347 set this at 2026-08-01T06:00:00Z ("August runs remain blocked"). The
// owner revised the policy on 2026-08-01 (issue #1443, option b: re-sunset
// rather than retire) to 2026-09-01T06:00:00Z: hosted CI billing is deferred to
// August, so dogfood auto-promotion rides this waiver plus the local evidence
// protocol (docs/strategy/local-merge-readiness.md) until then. Everything else
// about the policy is unchanged — the waiver still only covers an exact
// zero-step billing failure, still fails closed past the maximum, and still
// never labels the provider run green.
//
// Two authorities carry this value: this constant and the literal in
// ops/dogfood/install-macos.zsh (a standalone zsh installer that cannot import
// it). Revise both together; the cutover-matrix behavior test pins the
// installer's literal against this exported constant so they cannot drift
// silently.
export const BILLING_WAIVER_MAX_EXPIRY_ISO = '2026-09-01T06:00:00Z';
const BILLING_WAIVER_MAX_EXPIRY = Date.parse(BILLING_WAIVER_MAX_EXPIRY_ISO);
const BILLING_ANNOTATION_REASON =
  "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings";
const GH_TIMEOUT_MS = 15_000;

function fail(message) {
  throw new Error(message);
}

// lstart is locale- and TZ-shaped; pin both so a recorded birth is a
// property of the process, not of who asked (#3049) — a skewed observation
// reads a LIVE lock holder as stale and reclaims its lock.
function defaultProcessBirth(pid) {
  const result = defaultRun('ps', ['-o', 'lstart=', '-p', String(pid)], {
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  return result.status === 0 ? String(result.stdout).trim() || null : null;
}

// The pre-pin observation, used ONLY to recognize births recorded by an
// older build during the upgrade window — never recorded (#3049).
function defaultProcessBirthLegacy(pid) {
  const result = defaultRun('ps', ['-o', 'lstart=', '-p', String(pid)]);
  return result.status === 0 ? String(result.stdout).trim() || null : null;
}

export function defaultRun(command, args, options = {}) {
  // Capture output via temp FILES, not pipes. `./station start` builds a
  // candidate with `stdio: 'inherit'`, which forwards our capture fds to
  // npm's whole descendant tree — and long-lived build daemons (esbuild
  // service processes) outlive the CLI holding the pipe's write end open,
  // so a pipe-based spawnSync never sees EOF and wedges the supervisor
  // forever (2026-07-28 incident, #1057). With file descriptors there is
  // no pipe to drain: spawnSync returns when the direct child exits,
  // regardless of what its descendants still hold.
  const token = randomUUID();
  const stdoutPath = path.join(tmpdir(), `station-dogfood-run-${token}.out`);
  const stderrPath = path.join(tmpdir(), `station-dogfood-run-${token}.err`);
  // Never load an unbounded capture file into memory: read at most the cap
  // (spawnSync's pipe maxBuffer used to provide this implicitly).
  const readCapped = (file) => {
    const cap = options.maxBuffer ?? RUNTIME_LOG_MAX_BYTES;
    const descriptor = openSync(file, 'r');
    try {
      const length = Math.min(fstatSync(descriptor).size, cap);
      const buffer = Buffer.alloc(length);
      const bytes = readSync(descriptor, buffer, 0, length, 0);
      return buffer.toString('utf8', 0, bytes);
    } finally {
      closeSync(descriptor);
    }
  };
  let stdoutFd = null;
  let stderrFd = null;
  try {
    stdoutFd = openSync(stdoutPath, 'w', 0o600);
    stderrFd = openSync(stderrPath, 'w', 0o600);
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
      timeout: options.timeoutMs,
    });
    return {
      status: result.status ?? 1,
      stdout: readCapped(stdoutPath),
      stderr: readCapped(stderrPath) || (result.error?.message ?? ''),
    };
  } finally {
    if (stdoutFd !== null) closeSync(stdoutFd);
    if (stderrFd !== null) closeSync(stderrFd);
    rmSync(stdoutPath, { force: true });
    rmSync(stderrPath, { force: true });
  }
}

function checked(run, command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} failed (${result.status}): ${String(result.stderr).trim() || 'no stderr'}`,
    );
  }
  return String(result.stdout).trim();
}

function canonicalPath(input) {
  let current = path.resolve(input);
  const suffix = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const real = existsSync(current) ? realpathSync.native(current) : current;
  return path.resolve(real, ...suffix);
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('dogfood config must be an object');
  }
  const requiredStrings = [
    'repo',
    'githubRepo',
    'instance',
    'stationHome',
    'supportDir',
    'logDir',
    'tailnetUrl',
  ];
  for (const key of requiredStrings) {
    if (typeof raw[key] !== 'string' || raw[key].trim() === '') {
      fail(`dogfood config ${key} must be a non-empty string`);
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.instance)) {
    fail('dogfood config instance must be a safe 1-64 character identifier');
  }
  if (raw.instance.toLowerCase() === 'default') {
    fail('dogfood config instance must be a dedicated non-default name');
  }
  for (const key of ['repo', 'stationHome', 'supportDir', 'logDir']) {
    if (!path.isAbsolute(raw[key]))
      fail(`dogfood config ${key} must be absolute`);
  }
  for (const key of ['serverPort', 'uiPort']) {
    if (!Number.isInteger(raw[key]) || raw[key] < 1 || raw[key] > 65535) {
      fail(`dogfood config ${key} must be an integer from 1 to 65535`);
    }
  }
  if (raw.serverPort > 65532) {
    fail(
      'dogfood config serverPort must be at most 65532 for voice/terminal/consent ports',
    );
  }
  const reservedPorts = [
    raw.serverPort,
    raw.serverPort + 1,
    raw.serverPort + 2,
    raw.serverPort + 3,
    raw.uiPort,
  ];
  if (new Set(reservedPorts).size !== reservedPorts.length) {
    fail('server, voice, terminal, consent, and UI ports must all be distinct');
  }
  let tailnet;
  try {
    tailnet = new URL(raw.tailnetUrl);
  } catch {
    fail('tailnetUrl must be a valid URL');
  }
  if (tailnet.protocol !== 'https:' || tailnet.username || tailnet.password) {
    fail('tailnetUrl must be an HTTPS URL without credentials');
  }
  if (tailnet.pathname !== '/' || tailnet.search || tailnet.hash) {
    fail(
      'tailnetUrl must be an HTTPS origin without a path, query, or fragment',
    );
  }

  const config = {
    ...raw,
    repo: path.resolve(raw.repo),
    stationHome: path.resolve(raw.stationHome),
    supportDir: path.resolve(raw.supportDir),
    logDir: path.resolve(raw.logDir),
    tailnetUrl: tailnet.origin,
  };
  const canonicalHome = canonicalPath(config.stationHome);
  const managedPaths = [
    ['repository', canonicalPath(config.repo)],
    ['supervisor support directory', canonicalPath(config.supportDir)],
    [
      'release directory',
      canonicalPath(path.join(config.supportDir, 'releases')),
    ],
    ['supervisor log directory', canonicalPath(config.logDir)],
  ];
  for (const [label, managed] of managedPaths) {
    if (
      containsPath(managed, canonicalHome) ||
      containsPath(canonicalHome, managed)
    ) {
      fail(
        `STATION_HOME must be external to the ${label}: ${config.stationHome}`,
      );
    }
  }
  return config;
}

function atomicWriteJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`cannot parse ${file}: ${error.message}`);
  }
}

export function acquireLock(
  lockPath,
  {
    now = Date.now(),
    maxAgeMs = DEFAULT_LOCK_MAX_AGE_MS,
    processAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code === 'EPERM';
      }
    },
    processBirth = defaultProcessBirth,
    afterStaleInspect,
    afterBaseline,
  } = {},
) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  let ownedInode;
  try {
    const descriptor = openSync(lockPath, 'wx', 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, birth: processBirth(process.pid), token, acquiredAt: new Date(now).toISOString() })}\n`,
    );
    closeSync(descriptor);
    ownedInode = statSync(lockPath).ino;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let observed;
    let observedContent;
    try {
      observed = statSync(lockPath);
      observedContent = readFileSync(lockPath, 'utf8');
      const confirmed = statSync(lockPath);
      if (confirmed.ino !== observed.ino || confirmed.dev !== observed.dev) {
        fail(
          `lock ownership changed while inspecting ${lockPath}; retry later`,
        );
      }
    } catch (baselineError) {
      if (baselineError.code === 'ENOENT') {
        fail(
          `lock ownership changed while inspecting ${lockPath}; retry later`,
        );
      }
      throw baselineError;
    }
    const baselineStillCurrent = () => {
      try {
        const current = statSync(lockPath);
        return (
          current.ino === observed.ino &&
          current.dev === observed.dev &&
          readFileSync(lockPath, 'utf8') === observedContent
        );
      } catch {
        return false;
      }
    };
    afterBaseline?.({ lockPath, observed, observedContent });
    if (!baselineStillCurrent()) {
      fail(`lock ownership changed while inspecting ${lockPath}; retry later`);
    }
    const age = now - observed.mtimeMs;
    let ownerPid;
    let ownerBirth;
    try {
      const lock = JSON.parse(observedContent);
      if (Number.isInteger(lock.pid) && lock.pid > 0) ownerPid = lock.pid;
      if (typeof lock.birth === 'string' && lock.birth !== '') {
        ownerBirth = lock.birth;
      }
    } catch {
      // A malformed lock is reclaimable only after the same stale threshold.
    }
    const observedBirth = ownerPid ? processBirth(ownerPid) : null;
    // A mismatch may be a birth recorded by a pre-pin build observed through
    // the pinned probe — re-check through the legacy lens before treating a
    // live holder as pid-reused (#3049 migration window). Lazy, and only
    // for the DEFAULT lookup: an injected test lookup stays exact, matching
    // journalOwnerAliveWith's gate.
    const birthMatches = () =>
      ownerBirth === observedBirth ||
      (processBirth === defaultProcessBirth &&
        ownerBirth === (defaultProcessBirthLegacy(ownerPid) ?? undefined));
    if (
      ownerPid &&
      processAlive(ownerPid) &&
      (!ownerBirth || !observedBirth || birthMatches())
    ) {
      if (!baselineStillCurrent()) {
        fail(
          `lock ownership changed while inspecting ${lockPath}; retry later`,
        );
      }
      fail(
        `dogfood reconcile lock ${lockPath} is owned by live PID ${ownerPid}`,
      );
    }
    if (age <= maxAgeMs) {
      if (!baselineStillCurrent()) {
        fail(
          `lock ownership changed while inspecting ${lockPath}; retry later`,
        );
      }
      fail(
        `another dogfood reconcile holds ${lockPath} (age ${Math.round(age / 1000)}s)`,
      );
    }
    afterStaleInspect?.({ lockPath, observed, observedContent });
    if (!baselineStillCurrent()) {
      fail(`lock ownership changed while reclaiming ${lockPath}; retry later`);
    }
    const quarantine = `${lockPath}.stale-${randomUUID()}`;
    try {
      renameSync(lockPath, quarantine);
      const quarantined = statSync(quarantine);
      const quarantinedContent = readFileSync(quarantine, 'utf8');
      if (
        quarantined.ino !== observed.ino ||
        quarantinedContent !== observedContent
      ) {
        if (!existsSync(lockPath)) renameSync(quarantine, lockPath);
        fail(
          `lock ownership changed while quarantining ${lockPath}; retry later`,
        );
      }
      rmSync(quarantine, { force: true });
    } catch (reclaimError) {
      if (existsSync(quarantine) && !existsSync(lockPath)) {
        renameSync(quarantine, lockPath);
      }
      if (reclaimError.code === 'ENOENT') {
        fail(
          `lock ownership changed while reclaiming ${lockPath}; retry later`,
        );
      }
      throw reclaimError;
    }
    return acquireLock(lockPath, {
      now,
      maxAgeMs,
      processAlive,
      processBirth,
      afterStaleInspect,
      afterBaseline,
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(readFileSync(lockPath, 'utf8'));
      const currentInode = statSync(lockPath).ino;
      if (current.token === token && currentInode === ownedInode) {
        unlinkSync(lockPath);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}

function secureDirectory(directory, label) {
  if (!existsSync(directory))
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(`${label} must be a real directory, not a symlink: ${directory}`);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    fail(`${label} must be owned by the current user: ${directory}`);
  }
  if ((info.mode & 0o077) !== 0) {
    fail(`${label} permissions must be 0700: ${directory}`);
  }
}

function secureFile(file, label) {
  if (!existsSync(file)) {
    const descriptor = openSync(file, 'wx', 0o600);
    closeSync(descriptor);
  }
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    fail(`${label} must be a real file, not a symlink: ${file}`);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    fail(`${label} must be owned by the current user: ${file}`);
  }
  if ((info.mode & 0o077) !== 0) {
    fail(`${label} permissions must be 0600: ${file}`);
  }
}

function requireOwnedRegularFile(file, label) {
  if (!path.isAbsolute(file)) fail(`${label} must be an absolute path`);
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    fail(`${label} must be a real file, not a symlink: ${file}`);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    fail(`${label} must be owned by the current user: ${file}`);
  }
}

/**
 * The canonical dogfood supervisor label. Renamed from
 * `ai.kontour.station-dogfood` when `io.kontourai.*` became the single package
 * root; the old label is now an ordinary legacy value an operator migrates
 * from via STATION_DOGFOOD_LEGACY_LABEL.
 */
const CANONICAL_DOGFOOD_LABEL = 'io.kontourai.station-dogfood';

export function createLegacyMigrationProof(
  {
    legacyLabel,
    legacyPlist,
    legacyPlistSnapshot,
    legacyRunner,
    legacyRunnerSnapshot,
  },
  run = defaultRun,
) {
  if (!/^[A-Za-z0-9._-]+$/.test(legacyLabel ?? '')) {
    fail('legacy migration label is invalid');
  }
  if (legacyLabel === CANONICAL_DOGFOOD_LABEL) {
    fail('legacy migration label must differ from the canonical supervisor');
  }
  for (const [file, label] of [
    [legacyPlist, 'legacy plist'],
    [legacyPlistSnapshot, 'legacy plist snapshot'],
    [legacyRunner, 'legacy runner'],
    [legacyRunnerSnapshot, 'legacy runner snapshot'],
  ]) {
    requireOwnedRegularFile(file, label);
  }
  const domain = `gui/${process.getuid()}`;
  return () => {
    requireOwnedRegularFile(legacyPlist, 'legacy plist');
    requireOwnedRegularFile(legacyPlistSnapshot, 'legacy plist snapshot');
    requireOwnedRegularFile(legacyRunner, 'legacy runner');
    requireOwnedRegularFile(legacyRunnerSnapshot, 'legacy runner snapshot');
    if (
      !readFileSync(legacyPlist).equals(readFileSync(legacyPlistSnapshot)) ||
      !readFileSync(legacyRunner).equals(readFileSync(legacyRunnerSnapshot))
    ) {
      return false;
    }
    const plist = run(
      'plutil',
      ['-convert', 'json', '-o', '-', legacyPlistSnapshot],
      { timeoutMs: 5_000, maxBuffer: 1024 * 1024 },
    );
    if (plist.status !== 0) return false;
    let contract;
    try {
      contract = JSON.parse(String(plist.stdout));
    } catch {
      return false;
    }
    if (
      contract.Label !== legacyLabel ||
      !Array.isArray(contract.ProgramArguments) ||
      contract.ProgramArguments.length !== 1 ||
      contract.ProgramArguments[0] !== legacyRunner
    ) {
      return false;
    }
    const legacy = run('launchctl', ['print', `${domain}/${legacyLabel}`], {
      timeoutMs: 5_000,
      maxBuffer: 1024 * 1024,
    });
    if (
      legacy.status !== 0 ||
      !String(legacy.stdout).includes(`\n\tpath = ${legacyPlist}\n`) ||
      !String(legacy.stdout).includes(`\n\tprogram = ${legacyRunner}\n`)
    ) {
      return false;
    }
    const canonical = run(
      'launchctl',
      ['print', `${domain}/${CANONICAL_DOGFOOD_LABEL}`],
      { timeoutMs: 5_000, maxBuffer: 1024 * 1024 },
    );
    return (
      canonical.status === 113 &&
      String(canonical.stderr).includes('Could not find service')
    );
  };
}

function cleanStatus(run, repo) {
  return checked(run, 'git', [
    '-C',
    repo,
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
}

function parseGitHubRepo(origin) {
  const match = String(origin).match(
    /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/i,
  );
  return match?.[1] ?? null;
}

function requireConfiguredGitHubOrigin(origin, configuredRepo) {
  const parsed = parseGitHubRepo(origin);
  if (!parsed || parsed.toLowerCase() !== configuredRepo.toLowerCase()) {
    fail(
      `origin ${origin} does not match configured GitHub repo ${configuredRepo}`,
    );
  }
}

function resolveCandidate(run, config) {
  const origin = checked(run, 'git', [
    '-C',
    config.repo,
    'remote',
    'get-url',
    'origin',
  ]);
  requireConfiguredGitHubOrigin(origin, config.githubRepo);
  checked(run, 'git', [
    '-C',
    config.repo,
    'fetch',
    '--prune',
    'origin',
    '+refs/heads/main:refs/remotes/origin/main',
  ]);
  const sha = checked(run, 'git', [
    '-C',
    config.repo,
    'rev-parse',
    'origin/main',
  ]);
  if (!/^[0-9a-f]{40}$/i.test(sha))
    fail(`origin/main did not resolve to a full SHA: ${sha}`);
  return sha.toLowerCase();
}

function requireCi(run, config, sha, { now, waiverExpiry }) {
  const output = checked(
    run,
    'gh',
    [
      'run',
      'list',
      '--repo',
      config.githubRepo,
      '--workflow',
      'CI',
      '--branch',
      'main',
      '--event',
      'push',
      '--limit',
      '100',
      '--json',
      'databaseId,headSha,status,conclusion,event,workflowName,url',
    ],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  let runs;
  try {
    runs = JSON.parse(output);
  } catch {
    fail('gh returned invalid JSON while checking the exact CI run');
  }
  if (!Array.isArray(runs)) fail('gh CI response must be an array');
  const exactRuns = runs.filter(
    (runRecord) =>
      String(runRecord.headSha).toLowerCase() === sha &&
      runRecord.workflowName === 'CI' &&
      runRecord.event === 'push',
  );
  if (exactRuns.length === 0) {
    fail(`no CI push run exists for exact origin/main SHA ${sha}`);
  }
  const exact =
    exactRuns.find(
      (runRecord) =>
        runRecord.status === 'completed' && runRecord.conclusion === 'success',
    ) ?? exactRuns[0];
  if (exact.status === 'completed' && exact.conclusion === 'success') {
    return { id: exact.databaseId, url: exact.url, outcome: 'success' };
  }
  if (exactRuns.length !== 1) {
    fail(
      `billing waiver requires exactly one non-success CI push run for exact SHA ${sha}`,
    );
  }
  if (exact.status !== 'completed' || exact.conclusion !== 'failure') {
    fail(
      `CI push run for ${sha} is not completed/success (status=${exact.status}, conclusion=${exact.conclusion ?? 'none'})`,
    );
  }
  const expiry = Date.parse(waiverExpiry ?? '');
  if (config.githubRepo !== 'kontourai/station')
    fail('billing waiver is bound to exact repository kontourai/station');
  if (
    !Number.isFinite(expiry) ||
    expiry > BILLING_WAIVER_MAX_EXPIRY ||
    now >= expiry
  ) {
    fail(
      `CI push run for ${sha} failed and billing waiver policy is missing, expired, or exceeds its maximum expiry`,
    );
  }
  const jobsOutput = checked(
    run,
    'gh',
    [
      'run',
      'view',
      String(exact.databaseId),
      '--repo',
      'kontourai/station',
      '--json',
      'jobs',
    ],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  let jobs;
  try {
    jobs = JSON.parse(jobsOutput)?.jobs;
  } catch {
    fail('gh returned invalid JSON while checking billing-failed jobs');
  }
  if (!Array.isArray(jobs) || jobs.length === 0)
    fail('billing waiver requires a non-empty jobs array');
  const failedJobs = [];
  for (const job of jobs) {
    if (job?.conclusion === 'skipped') continue;
    if (
      job?.conclusion !== 'failure' ||
      !Number.isInteger(job.databaseId) ||
      typeof job.name !== 'string' ||
      !Array.isArray(job.steps) ||
      job.steps.length !== 0
    ) {
      fail(
        'billing waiver permits only zero-step failed jobs and skipped jobs',
      );
    }
    const annotationsOutput = checked(
      run,
      'gh',
      [
        'api',
        '--method',
        'GET',
        `repos/kontourai/station/check-runs/${job.databaseId}/annotations`,
      ],
      { timeoutMs: GH_TIMEOUT_MS },
    );
    let annotations;
    try {
      annotations = JSON.parse(annotationsOutput);
    } catch {
      fail('gh returned invalid JSON while checking billing annotations');
    }
    if (
      !Array.isArray(annotations) ||
      annotations.length !== 1 ||
      annotations[0]?.annotation_level !== 'failure' ||
      annotations[0]?.message !== BILLING_ANNOTATION_REASON
    ) {
      fail('failed job lacks the exact billing/spending-limit annotation');
    }
    failedJobs.push({ id: job.databaseId, name: job.name });
  }
  if (failedJobs.length === 0)
    fail('billing waiver requires at least one proven failed job');
  return {
    id: exact.databaseId,
    url: exact.url,
    outcome: 'infrastructure-waived',
    waiver: {
      sha,
      runId: exact.databaseId,
      runUrl: exact.url,
      failedJobs,
      annotationReason: BILLING_ANNOTATION_REASON,
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiry).toISOString(),
    },
  };
}

function stationArgs(config, command, extra = []) {
  return [
    command,
    `--instance=${config.instance}`,
    `--base=${config.stationHome}`,
    `--port=${config.serverPort}`,
    `--ui-port=${config.uiPort}`,
    ...extra,
  ];
}

function stationEnv(config) {
  return {
    ...process.env,
    STATION_BUILD_BRANCH: 'main',
    STATION_HOME: config.stationHome,
  };
}

// Upper bounds so a hung CLI invocation degrades to a failed reconcile
// iteration (retried on the next cycle) instead of wedging the supervisor.
const STATION_BUILD_TIMEOUT_MS = 45 * 60 * 1000;
const STATION_LIFECYCLE_TIMEOUT_MS = 15 * 60 * 1000;

function runStation(run, releaseDir, config, command, extra = []) {
  return checked(run, './station', stationArgs(config, command, extra), {
    cwd: releaseDir,
    env: stationEnv(config),
    timeoutMs:
      command === 'build'
        ? STATION_BUILD_TIMEOUT_MS
        : STATION_LIFECYCLE_TIMEOUT_MS,
  });
}

function verifyLocalRelease(
  run,
  config,
  sha,
  releasePath,
  { allowWildcardHost = false } = {},
) {
  const instanceState = path.join(
    releasePath,
    '.station',
    'instances',
    `${config.instance}.json`,
  );
  const healthArgs = [
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'station-dogfood-health.mjs',
    ),
    `--instance-state=${instanceState}`,
    `--timeout-ms=${LOCAL_HEALTH_TIMEOUT_MS}`,
  ];
  if (allowWildcardHost) healthArgs.push('--allow-wildcard-host');
  const result = run(process.execPath, healthArgs);
  let health;
  try {
    health = JSON.parse(String(result.stdout).trim());
  } catch {
    health = null;
  }
  if (result.status !== 0 || !health?.healthy || health.identity?.sha !== sha) {
    const failedChecks = health?.failedChecks ?? ['unknown'];
    const error = new Error(
      `local service unit unhealthy: ${failedChecks.join(', ')}${result.stderr ? ` (${String(result.stderr).trim()})` : ''}`,
    );
    error.failedChecks = failedChecks;
    error.identity = health?.identity;
    error.pid = health?.pid;
    throw error;
  }
  return health;
}

function readTailnetJson(run, config, route, label) {
  const raw = checked(run, 'curl', [
    '--disable',
    '--proto',
    '=https',
    '--noproxy',
    '*',
    '--max-redirs',
    '0',
    '--fail',
    '--silent',
    '--show-error',
    '--max-time',
    '5',
    `${config.tailnetUrl}${route}`,
  ]);
  try {
    return JSON.parse(raw);
  } catch {
    fail(`tailnet ${label} returned invalid JSON`);
  }
}

function verifyTailnetRelease(run, config, expectedIdentity) {
  const identity = readTailnetJson(
    run,
    config,
    '/__station/identity',
    'identity',
  );
  const matchesExpected =
    identity?.instanceId === expectedIdentity.instanceId &&
    (identity?.sha ?? identity?.fullSha)?.toLowerCase() ===
      expectedIdentity.sha.toLowerCase() &&
    identity?.bootId === expectedIdentity.bootId;
  if (!matchesExpected)
    fail(
      `tailnet identity mismatch: expected ${expectedIdentity.instanceId}/${expectedIdentity.sha}/${expectedIdentity.bootId}`,
    );
  const readiness = readTailnetJson(
    run,
    config,
    '/api/system/readiness',
    'readiness',
  );
  if (readiness?.ready !== true || readiness?.status !== 'ready') {
    fail('tailnet readiness did not report ready');
  }
}

function stopRelease(run, release, config, intent = 'operator_stop') {
  const runtimePath = release?.runtimePath ?? release?.path;
  if (!runtimePath || !existsSync(runtimePath)) {
    fail(`recorded release is unavailable: ${runtimePath ?? 'missing path'}`);
  }
  runStation(run, runtimePath, config, 'stop', [`--stop-intent=${intent}`]);
}

function startRelease(run, release, config, options = {}) {
  runStation(run, release.path, config, 'start', [
    ...(options.force
      ? ['--force', '--stop-intent=recovery', '--rotate-log-on-restart']
      : []),
    '--host=127.0.0.1',
    `--log=${path.join(config.logDir, 'station-runtime.log')}`,
    `--lifecycle-journal=${path.join(config.logDir, 'station-lifecycle.jsonl')}`,
    `--readiness-file=${path.join(config.supportDir, 'state.json')}`,
  ]);
}

function rotateRuntimeLog(config) {
  const current = path.join(config.logDir, 'station-runtime.log');
  if (!existsSync(current)) return;
  const descriptor = openSync(
    current,
    constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
  );
  const opened = fstatSync(descriptor);
  if (opened.size <= RUNTIME_LOG_MAX_BYTES) {
    closeSync(descriptor);
    return;
  }
  if (
    !opened.isFile() ||
    (typeof process.getuid === 'function' && opened.uid !== process.getuid())
  ) {
    closeSync(descriptor);
    fail('runtime log descriptor is not a current-user regular file');
  }
  fchmodSync(descriptor, 0o600);
  const previous = `${current}.previous`;
  const temporary = `${current}.${randomUUID()}.rotation`;
  let temporaryDescriptor;
  try {
    temporaryDescriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, position);
      if (count === 0) break;
      let written = 0;
      while (written < count) {
        written += writeSync(
          temporaryDescriptor,
          buffer,
          written,
          count - written,
        );
      }
      position += count;
    }
    fsyncSync(temporaryDescriptor);
    closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;
    renameSync(temporary, previous);
    const currentPath = lstatSync(current);
    if (
      !currentPath.isFile() ||
      currentPath.isSymbolicLink() ||
      currentPath.ino !== opened.ino ||
      currentPath.dev !== opened.dev
    ) {
      fail('runtime log pathname changed during rotation');
    }
    ftruncateSync(descriptor, 0);
    fsyncSync(descriptor);
  } finally {
    if (temporaryDescriptor !== undefined) closeSync(temporaryDescriptor);
    closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function appendFailure(state, sha, phase, reason, now) {
  return {
    ...state,
    failedCandidates: [
      ...(Array.isArray(state.failedCandidates) ? state.failedCandidates : []),
      { sha, phase, reason, failedAt: new Date(now).toISOString() },
    ].slice(-20),
  };
}

function withReconciliation(state, phase, now, values = {}) {
  return {
    ...state,
    reconciliation: {
      desired: values.desired ?? state.reconciliation?.desired ?? null,
      source: values.source ?? state.reconciliation?.source ?? null,
      built: values.built ?? state.reconciliation?.built ?? null,
      running: values.running ?? state.reconciliation?.running ?? null,
      phase,
      updatedAt: new Date(now).toISOString(),
      failure: values.failure ?? null,
    },
  };
}

function recordStageFailure(state, sha, phase, error, now) {
  return withReconciliation(
    appendFailure(state, sha, phase, error.message, now),
    phase,
    now,
    {
      failure: {
        phase,
        reason: error.message,
        failedAt: new Date(now).toISOString(),
      },
    },
  );
}

function appendRecovery(state, receipt) {
  return {
    ...state,
    recoveryHistory: [
      ...(Array.isArray(state.recoveryHistory) ? state.recoveryHistory : []),
      receipt,
    ].slice(-RECOVERY_HISTORY_LIMIT),
  };
}

function healthState(status, recovery, extra = {}) {
  return {
    status,
    sha: recovery.sha,
    source: recovery.source,
    reason: recovery.reason,
    sender: recovery.sender,
    failedChecks: recovery.failedChecks,
    detectedAt: recovery.detectedAt,
    ...extra,
  };
}

function readyHealth(sha, source, checkedAt) {
  return {
    status: 'ready',
    sha,
    source,
    sender: 'unknown',
    failedChecks: [],
    checkedAt,
  };
}

function shouldPollRemote(state, now) {
  const last = Date.parse(state.lastRemoteCheckAt ?? '');
  return !Number.isFinite(last) || now - last >= REMOTE_CHECK_INTERVAL_MS;
}

function classifyPriorExit(config, healthError) {
  const identity = healthError.identity;
  const pid = healthError.pid;
  const base = {
    pid: Number.isInteger(pid) ? pid : null,
    bootId: identity?.bootId ?? null,
    exitCode: null,
    signal: null,
    intent: null,
    sender: 'unknown',
  };
  if (!identity?.bootId || !Number.isInteger(pid)) {
    return { ...base, classification: 'crash_unobserved' };
  }
  const journal = path.join(config.logDir, 'station-lifecycle.jsonl');
  if (!existsSync(journal))
    return { ...base, classification: 'crash_unobserved' };
  const journalRelease = acquireBoundedJournalLock(journal);
  let retainedLines;
  try {
    const retainedFiles = [`${journal}.previous`, journal].filter((file) =>
      existsSync(file),
    );
    for (const file of retainedFiles) secureFile(file, 'lifecycle journal');
    retainedLines = retainedFiles.flatMap((file) =>
      readFileSync(file, 'utf8').split('\n'),
    );
  } finally {
    journalRelease();
  }
  const events = retainedLines
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .filter(
      (event) =>
        event.instanceId === config.instance &&
        event.sha === identity.sha &&
        event.bootId === identity.bootId &&
        event.pid === pid,
    );
  const actual = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === 'process_exit' || event.type === 'shutdown_observed',
    );
  const intentEvent = [...events]
    .reverse()
    .find((event) => event.type === 'stop_intent');
  const intent = intentEvent?.intent;
  const stopResult = intentEvent?.operationId
    ? events.find(
        (event) =>
          event.type === 'stop_result' &&
          event.operationId === intentEvent.operationId,
      )
    : undefined;
  const observedSignal = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === 'shutdown_observed' &&
        (event.reason === 'SIGINT' || event.reason === 'SIGTERM'),
    );
  const expected = {
    promotion: 'expected_promotion',
    operator_stop: 'operator_stop',
    recovery: 'expected_recovery_stop',
    rollback: 'expected_rollback',
  };
  const actualAt = Date.parse(actual?.timestamp ?? '');
  const expectedStop =
    intent &&
    (stopResult?.result === 'completed' ||
      stopResult?.result === 'already_absent') &&
    Number.isFinite(actualAt) &&
    actualAt >= Date.parse(intentEvent.timestamp) &&
    actualAt <= Date.parse(stopResult.timestamp) &&
    actualAt <= Date.parse(intentEvent.expiresAt);
  const classification = expectedStop
    ? expected[intent]
    : !actual
      ? 'crash_unobserved'
      : observedSignal || actual.signal
        ? 'unexpected_signal'
        : 'crash';
  return {
    ...base,
    classification,
    intent: intent ?? null,
    exitCode: actual?.exitCode ?? null,
    signal: actual?.signal ?? observedSignal?.reason ?? actual?.reason ?? null,
  };
}

function journalProcessBirth(pid) {
  // Pinned like processBirth above: births must be env-independent (#3049).
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? String(result.stdout).trim() || null : null;
}

// Pre-pin observation for the upgrade window only — never recorded (#3049).
function journalProcessBirthLegacy(pid) {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? String(result.stdout).trim() || null : null;
}

function inspectJournalLock(lock) {
  let descriptor;
  try {
    descriptor = openSync(
      lock,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const info = fstatSync(descriptor);
    const owner = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (
      !info.isFile() ||
      !owner.token ||
      !Number.isInteger(owner.pid) ||
      typeof owner.birth !== 'string' ||
      owner.birth.length === 0
    ) {
      fail('lifecycle journal lock metadata is invalid');
    }
    return { owner, ino: info.ino, dev: info.dev };
  } finally {
    closeSync(descriptor);
  }
}

function journalLockOwnerAlive(owner) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code !== 'EPERM') return false;
  }
  const birth = journalProcessBirth(owner.pid);
  if (!birth || birth === owner.birth) return true;
  // A recorded birth from a pre-pin build mismatches the pinned probe for
  // the SAME live process — re-check through the legacy lens before
  // declaring the owner dead (#3049 migration window).
  return journalProcessBirthLegacy(owner.pid) === owner.birth;
}

function sameJournalLock(left, right) {
  return Boolean(
    left &&
      left.ino === right.ino &&
      left.dev === right.dev &&
      left.owner.token === right.owner.token &&
      left.owner.pid === right.owner.pid &&
      left.owner.birth === right.owner.birth,
  );
}

function sameOptionalJournalLock(left, right) {
  return right === null ? left === null : sameJournalLock(left, right);
}

function inspectJournalGuard(guard) {
  const inspected = inspectJournalLock(guard);
  if (!inspected) return null;
  const guarded = inspected.owner.guarded;
  if (
    !Number.isFinite(inspected.owner.createdAt) ||
    !Number.isFinite(inspected.owner.expiresAt) ||
    !guarded?.owner?.token ||
    !guarded.owner.birth ||
    !Number.isInteger(guarded.ino) ||
    !Number.isInteger(guarded.dev)
  )
    fail('lifecycle journal guard metadata is invalid');
  return inspected;
}

function sameJournalGuard(left, right) {
  return Boolean(
    left &&
      left.ino === right.ino &&
      left.dev === right.dev &&
      left.owner.token === right.owner.token &&
      left.owner.pid === right.owner.pid &&
      left.owner.birth === right.owner.birth,
  );
}

function publishJournalGuard(lock, observed, birth) {
  const guard = `${lock}.guard`;
  const token = randomUUID();
  const temporary = `${guard}.${token}.tmp`;
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  writeFileSync(
    descriptor,
    JSON.stringify({
      token,
      pid: process.pid,
      birth,
      createdAt: Date.now(),
      expiresAt: Date.now() + 5_000,
      guarded: observed,
    }),
  );
  fsyncSync(descriptor);
  closeSync(descriptor);
  try {
    linkSync(temporary, guard);
    return inspectJournalGuard(guard);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return null;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function deleteJournalGuard(pathname, observed) {
  if (!sameJournalGuard(inspectJournalGuard(pathname), observed)) return;
  const quarantine = `${pathname}.stale-${randomUUID()}`;
  renameSync(pathname, quarantine);
  if (!sameJournalGuard(inspectJournalGuard(quarantine), observed)) {
    if (!existsSync(pathname) && existsSync(quarantine)) {
      renameSync(quarantine, pathname);
    }
    fail('lifecycle journal guard changed during compare-delete');
  }
  rmSync(quarantine, { force: true });
}

function inspectJournalClaim(pathname) {
  let descriptor;
  try {
    descriptor = openSync(
      pathname,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const info = fstatSync(descriptor);
    const owner = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (
      !info.isFile() ||
      !owner.token ||
      !owner.birth ||
      !Number.isFinite(owner.expiresAt)
    )
      fail('journal guard reclamation claim metadata is invalid');
    return { path: pathname, owner, ino: info.ino, dev: info.dev };
  } finally {
    closeSync(descriptor);
  }
}

function sameJournalClaim(left, right) {
  return Boolean(
    left &&
      left.ino === right.ino &&
      left.dev === right.dev &&
      left.owner.token === right.owner.token,
  );
}

function deleteJournalClaim(claim, birthLookup, requireExpiredDead = false) {
  const current = inspectJournalClaim(claim.path);
  if (!sameJournalClaim(current, claim)) return;
  if (
    requireExpiredDead &&
    (current.owner.expiresAt > Date.now() ||
      journalOwnerAliveWith(current.owner, birthLookup ?? journalProcessBirth))
  )
    return;
  const quarantine = `${claim.path}.stale-${randomUUID()}`;
  renameSync(claim.path, quarantine);
  if (!sameJournalClaim(inspectJournalClaim(quarantine), claim)) {
    if (!existsSync(claim.path) && existsSync(quarantine)) {
      renameSync(quarantine, claim.path);
    }
    fail('journal guard reclamation claim changed during cleanup');
  }
  rmSync(quarantine, { force: true });
}

function activeJournalClaims(lock, guard, birthLookup = journalProcessBirth) {
  const directory = `${lock}.guard.claims`;
  if (!existsSync(directory)) return [];
  const now = Date.now();
  const claims = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith('.claim')) continue;
    const claim = inspectJournalClaim(path.join(directory, entry));
    if (!claim) continue;
    // Expiry makes a dead claim collectible; it never revokes a live owner's authority.
    if (claim.owner.expiresAt <= now) {
      if (!journalOwnerAliveWith(claim.owner, birthLookup)) {
        deleteJournalClaim(claim, birthLookup, true);
        continue;
      }
    }
    if (
      !guard ||
      (claim.owner.guardIno === guard.ino &&
        claim.owner.guardDev === guard.dev &&
        claim.owner.guardToken === guard.owner.token)
    )
      claims.push(claim);
  }
  return claims.sort(
    (left, right) =>
      left.owner.createdAt - right.owner.createdAt ||
      left.owner.token.localeCompare(right.owner.token),
  );
}

function journalClaimStillAuthoritative(lock, guard, claim, birthLookup) {
  const current = inspectJournalClaim(claim.path);
  if (
    !sameJournalClaim(current, claim) ||
    current.owner.pid !== process.pid ||
    birthLookup(process.pid) !== current.owner.birth ||
    !sameJournalGuard(inspectJournalGuard(`${lock}.guard`), guard)
  )
    return false;
  return sameJournalClaim(
    activeJournalClaims(lock, guard, birthLookup)[0],
    current,
  );
}

function journalOwnerAliveWith(owner, birthLookup) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code !== 'EPERM') return false;
  }
  const birth = birthLookup(owner.pid);
  if (!birth || birth === owner.birth) return true;
  // Same #3049 migration accept as journalLockOwnerAlive: a pre-pin
  // recorded birth read through the pinned probe mismatches for the same
  // live process. Only the default lookup gets the legacy re-check — an
  // injected test lookup stays exact.
  return (
    birthLookup === journalProcessBirth &&
    journalProcessBirthLegacy(owner.pid) === owner.birth
  );
}

function reclaimOrphanJournalGuard(lock, options, birthLookup, birth) {
  const guardPath = `${lock}.guard`;
  const guard = inspectJournalGuard(guardPath);
  if (!guard) return true;
  if (journalOwnerAliveWith(guard.owner, birthLookup)) return false;
  const directory = `${guardPath}.claims`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const claimPath = path.join(directory, `${token}.claim`);
  const claimTemporary = `${claimPath}.tmp`;
  const createdAt = Date.now();
  const descriptor = openSync(
    claimTemporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  writeFileSync(
    descriptor,
    JSON.stringify({
      token,
      pid: process.pid,
      birth,
      createdAt,
      expiresAt: createdAt + (options.claimLeaseMs ?? 250),
      guardIno: guard.ino,
      guardDev: guard.dev,
      guardToken: guard.owner.token,
    }),
  );
  fsyncSync(descriptor);
  closeSync(descriptor);
  linkSync(claimTemporary, claimPath);
  rmSync(claimTemporary, { force: true });
  const ownClaim = inspectJournalClaim(claimPath);
  if (!ownClaim) fail('failed to publish journal guard reclamation claim');
  options.afterClaimPublished?.(lock);
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    options.electionMs ?? 15,
  );
  const winner = activeJournalClaims(lock, guard, birthLookup)[0];
  if (!sameJournalClaim(winner, ownClaim)) {
    deleteJournalClaim(ownClaim);
    return false;
  }
  options.afterElectionWon?.(lock);
  try {
    if (
      !journalClaimStillAuthoritative(lock, guard, ownClaim, birthLookup) ||
      journalOwnerAliveWith(guard.owner, birthLookup)
    )
      return false;
    const canonical = inspectJournalLock(lock);
    if (sameJournalLock(canonical, guard.owner.guarded)) {
      if (
        !journalClaimStillAuthoritative(lock, guard, ownClaim, birthLookup) ||
        !sameJournalLock(inspectJournalLock(lock), guard.owner.guarded)
      )
        return false;
      const quarantine = `${lock}.orphan-${randomUUID()}`;
      renameSync(lock, quarantine);
      if (
        !journalClaimStillAuthoritative(lock, guard, ownClaim, birthLookup) ||
        inspectJournalLock(lock) !== null ||
        !sameJournalLock(inspectJournalLock(quarantine), guard.owner.guarded)
      ) {
        if (!existsSync(lock) && existsSync(quarantine))
          renameSync(quarantine, lock);
        return false;
      }
      rmSync(quarantine, { force: true });
    }
    if (!journalClaimStillAuthoritative(lock, guard, ownClaim, birthLookup)) {
      return false;
    }
    const canonicalBeforeGuardDelete = inspectJournalLock(lock);
    if (sameJournalLock(canonicalBeforeGuardDelete, guard.owner.guarded)) {
      return false;
    }
    const guardQuarantine = `${guardPath}.stale-${randomUUID()}`;
    renameSync(guardPath, guardQuarantine);
    const currentClaim = inspectJournalClaim(ownClaim.path);
    if (
      !sameJournalClaim(currentClaim, ownClaim) ||
      birthLookup(process.pid) !== ownClaim.owner.birth ||
      !sameJournalClaim(
        activeJournalClaims(lock, guard, birthLookup)[0],
        ownClaim,
      ) ||
      !sameJournalGuard(inspectJournalGuard(guardQuarantine), guard) ||
      !sameOptionalJournalLock(
        inspectJournalLock(lock),
        canonicalBeforeGuardDelete,
      )
    ) {
      if (!existsSync(guardPath) && existsSync(guardQuarantine)) {
        renameSync(guardQuarantine, guardPath);
      }
      return false;
    }
    rmSync(guardQuarantine, { force: true });
    return true;
  } finally {
    deleteJournalClaim(ownClaim);
  }
}

function guardedDeleteJournalLock(lock, observed, options = {}) {
  if (activeJournalClaims(lock).length > 0) return false;
  const birthLookup = options.birthFingerprint ?? journalProcessBirth;
  const birth = birthLookup(process.pid);
  if (!birth) fail('process birth fingerprint is required for guard ownership');
  const guardPath = `${lock}.guard`;
  const guard = publishJournalGuard(lock, observed, birth);
  if (!guard) return false;
  try {
    options.afterGuardAcquired?.(lock, observed);
    if (!sameJournalGuard(inspectJournalGuard(guardPath), guard)) return false;
    if (!sameJournalLock(inspectJournalLock(lock), observed)) return false;
    const quarantine = `${lock}.stale-${randomUUID()}`;
    renameSync(lock, quarantine);
    const moved = inspectJournalLock(quarantine);
    if (!sameJournalLock(moved, observed)) {
      if (!existsSync(lock) && existsSync(quarantine)) {
        renameSync(quarantine, lock);
      }
      fail('lifecycle journal lock changed during compare-delete');
    }
    rmSync(quarantine, { force: true });
    return true;
  } finally {
    deleteJournalGuard(guardPath, guard);
  }
}

function deletePublishedJournalLockUnderGuard(lock, owned) {
  if (
    (!existsSync(`${lock}.guard`) && activeJournalClaims(lock).length === 0) ||
    !sameJournalLock(inspectJournalLock(lock), owned)
  ) {
    return;
  }
  const quarantine = `${lock}.aborted-${randomUUID()}`;
  renameSync(lock, quarantine);
  if (!sameJournalLock(inspectJournalLock(quarantine), owned)) {
    if (!existsSync(lock) && existsSync(quarantine)) {
      renameSync(quarantine, lock);
    }
    fail('published lock changed during guarded abort');
  }
  rmSync(quarantine, { force: true });
}

export function acquireBoundedJournalLock(
  journal,
  timeoutMs = 10_000,
  options = {},
) {
  const lock = `${journal}.lock`;
  const birth = (options.birthFingerprint ?? journalProcessBirth)(process.pid);
  if (!birth) fail('process birth fingerprint is required for lock ownership');
  const token = randomUUID();
  const temporary = `${lock}.${token}.tmp`;
  const deadline = Date.now() + timeoutMs;
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  writeFileSync(
    descriptor,
    `${JSON.stringify({
      version: 1,
      pid: process.pid,
      birth,
      token,
      acquiredAt: new Date().toISOString(),
    })}\n`,
  );
  fsyncSync(descriptor);
  closeSync(descriptor);
  while (true) {
    if (existsSync(`${lock}.guard`)) {
      try {
        if (
          reclaimOrphanJournalGuard(
            lock,
            options,
            options.birthFingerprint ?? journalProcessBirth,
            birth,
          )
        )
          continue;
      } catch {}
      if (Date.now() >= deadline) {
        rmSync(temporary, { force: true });
        fail('lifecycle journal lock guard is held');
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    if (activeJournalClaims(lock).length > 0) {
      if (Date.now() >= deadline) {
        rmSync(temporary, { force: true });
        fail('lifecycle journal guard reclamation is active');
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    try {
      linkSync(temporary, lock);
      const owned = inspectJournalLock(lock);
      if (!owned) fail('published lifecycle lock disappeared');
      if (existsSync(`${lock}.guard`) || activeJournalClaims(lock).length > 0) {
        while (
          (existsSync(`${lock}.guard`) ||
            activeJournalClaims(lock).length > 0) &&
          Date.now() < deadline
        ) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        if (sameJournalLock(inspectJournalLock(lock), owned)) {
          guardedDeleteJournalLock(lock, owned, options);
        }
        if (
          Date.now() >= deadline &&
          sameJournalLock(inspectJournalLock(lock), owned)
        ) {
          deletePublishedJournalLockUnderGuard(lock, owned);
          rmSync(temporary, { force: true });
          fail('lifecycle journal lock guard is held');
        }
        continue;
      }
      rmSync(temporary, { force: true });
      return () => {
        try {
          guardedDeleteJournalLock(lock, owned, options);
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let observed = null;
      try {
        observed = inspectJournalLock(lock);
      } catch {}
      if (observed && !journalLockOwnerAlive(observed.owner)) {
        options.afterStaleInspect?.(lock, observed);
        guardedDeleteJournalLock(lock, observed, options);
        continue;
      }
      if (Date.now() >= deadline) {
        rmSync(temporary, { force: true });
        fail('lifecycle journal lock is held by a live process');
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function validateReleaseRecord(record, label, config, run) {
  if (record === null || record === undefined) return null;
  if (
    typeof record !== 'object' ||
    !/^[0-9a-f]{40}$/i.test(record.sha) ||
    typeof record.path !== 'string' ||
    !path.isAbsolute(record.path)
  ) {
    fail(`${label} release state is invalid`);
  }
  const releaseInfo = lstatSync(record.path);
  if (!releaseInfo.isDirectory() || releaseInfo.isSymbolicLink()) {
    fail(`${label} release must be a real directory, not a symlink`);
  }
  const releasesPath = path.join(config.supportDir, 'releases');
  const releasesInfo = lstatSync(releasesPath);
  if (!releasesInfo.isDirectory() || releasesInfo.isSymbolicLink()) {
    fail('release root must be a real directory, not a symlink');
  }
  const releasesRoot = canonicalPath(releasesPath);
  const expectedPath = canonicalPath(record.path);
  const releaseName = path.basename(expectedPath);
  const sha = record.sha.toLowerCase();
  if (
    record.adoptedAllowWildcardHost !== undefined &&
    (record.adoptedAllowWildcardHost !== true ||
      record.runtimePath === undefined ||
      record.adoptedIdentity === undefined)
  ) {
    fail(`${label} adopted wildcard authority is invalid`);
  }
  if (
    !containsPath(releasesRoot, expectedPath) ||
    path.dirname(expectedPath) !== releasesRoot ||
    (releaseName !== sha &&
      !new RegExp(`^${sha}--release-[0-9a-f-]{36}$`).test(releaseName))
  ) {
    fail(`${label} release path is outside its immutable SHA directory`);
  }
  const head = checked(run, 'git', [
    '-C',
    expectedPath,
    'rev-parse',
    'HEAD',
  ]).toLowerCase();
  if (head !== record.sha.toLowerCase()) {
    fail(`${label} release HEAD does not match recorded SHA`);
  }
  const symbolic = run('git', [
    '-C',
    expectedPath,
    'symbolic-ref',
    '-q',
    'HEAD',
  ]);
  if (symbolic.status !== 1 || String(symbolic.stdout).trim() !== '') {
    fail(`${label} release must remain detached`);
  }
  const manifestPath = path.join(
    expectedPath,
    `dist-server-${config.instance}`,
    'station-build.json',
  );
  const manifest = readJson(manifestPath, null);
  if (
    !manifest ||
    String(manifest.sha).toLowerCase() !== record.sha.toLowerCase() ||
    manifest.branch !== 'main' ||
    !Number.isFinite(Date.parse(manifest.builtAt))
  ) {
    fail(
      `${label} release build manifest is missing or does not match its SHA`,
    );
  }
  let runtimePath;
  if (record.runtimePath !== undefined) {
    if (
      typeof record.runtimePath !== 'string' ||
      !path.isAbsolute(record.runtimePath)
    ) {
      fail(`${label} runtime path is invalid`);
    }
    runtimePath = canonicalPath(record.runtimePath);
    const runtimeInfo = lstatSync(runtimePath);
    if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) {
      fail(`${label} runtime path must be a real directory`);
    }
    if (
      typeof process.getuid === 'function' &&
      runtimeInfo.uid !== process.getuid()
    ) {
      fail(`${label} runtime path must be owned by the current user`);
    }
    const runtimeOrigin = checked(run, 'git', [
      '-C',
      runtimePath,
      'remote',
      'get-url',
      'origin',
    ]);
    requireConfiguredGitHubOrigin(runtimeOrigin, config.githubRepo);
    if (record.adoptedIdentity !== undefined) {
      if (
        !record.adoptedIdentity ||
        typeof record.adoptedIdentity !== 'object' ||
        String(record.adoptedIdentity.sha).toLowerCase() !== sha ||
        record.adoptedIdentity.instanceId !== config.instance ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          record.adoptedIdentity.bootId ?? '',
        )
      ) {
        fail(`${label} adopted runtime identity is invalid`);
      }
      checked(run, 'git', [
        '-C',
        runtimePath,
        'cat-file',
        '-e',
        `${sha}^{commit}`,
      ]);
      checked(run, 'git', [
        '-C',
        runtimePath,
        'merge-base',
        '--is-ancestor',
        sha,
        'origin/main',
      ]);
    } else {
      const runtimeHead = checked(run, 'git', [
        '-C',
        runtimePath,
        'rev-parse',
        'HEAD',
      ]).toLowerCase();
      if (runtimeHead !== sha)
        fail(`${label} runtime HEAD does not match recorded SHA`);
    }
  }
  return {
    ...record,
    sha,
    path: expectedPath,
    ...(runtimePath ? { runtimePath } : {}),
  };
}

function removeRelease(run, config, releasePath) {
  if (!existsSync(releasePath)) return;
  const result = run('git', [
    '-C',
    config.repo,
    'worktree',
    'remove',
    '--force',
    releasePath,
  ]);
  if (result.status !== 0) {
    fail(
      `could not remove release worktree ${releasePath}: ${String(result.stderr).trim()}`,
    );
  }
}

function pruneReleases(run, config, keepPaths) {
  const releasesDir = path.join(config.supportDir, 'releases');
  if (!existsSync(releasesDir)) return;
  for (const entry of readdirSync(releasesDir, { withFileTypes: true })) {
    const releasePath = path.join(releasesDir, entry.name);
    if (
      entry.isDirectory() &&
      /^(?:[0-9a-f]{40})(?:--release-[0-9a-f-]{36})?$/i.test(entry.name) &&
      !keepPaths.has(canonicalPath(releasePath))
    ) {
      removeRelease(run, config, releasePath);
    }
  }
}

function prepareCandidate(run, config, sha, options = {}) {
  const releaseDir =
    options.releaseDir ?? path.join(config.supportDir, 'releases', sha);
  if (existsSync(releaseDir)) {
    checked(run, 'git', [
      '-C',
      config.repo,
      'worktree',
      'remove',
      '--force',
      releaseDir,
    ]);
  }
  mkdirSync(path.dirname(releaseDir), { recursive: true });
  checked(run, 'git', [
    '-C',
    config.repo,
    'worktree',
    'add',
    '--detach',
    releaseDir,
    sha,
  ]);
  const actual = checked(run, 'git', [
    '-C',
    releaseDir,
    'rev-parse',
    'HEAD',
  ]).toLowerCase();
  if (actual !== sha)
    fail(`detached candidate mismatch: expected ${sha}, received ${actual}`);
  const branch = run('git', ['-C', releaseDir, 'symbolic-ref', '-q', 'HEAD']);
  if (branch.status === 0 || String(branch.stdout).trim() !== '') {
    fail(`candidate ${sha} is not detached`);
  }
  const before = cleanStatus(run, releaseDir);
  if (before !== '') fail(`candidate ${sha} is dirty before build:\n${before}`);
  try {
    checked(run, 'npm', ['ci'], { cwd: releaseDir });
  } catch (error) {
    error.stage = 'install';
    throw error;
  }
  try {
    runStation(run, releaseDir, config, 'build');
  } catch (error) {
    error.stage = 'build';
    throw error;
  }
  const after = cleanStatus(run, releaseDir);
  if (after !== '') fail(`candidate ${sha} is dirty after build:\n${after}`);
  return releaseDir;
}

function resumeCandidate(run, config, sha, staged) {
  if (
    staged?.sha !== sha ||
    typeof staged.path !== 'string' ||
    !existsSync(staged.path)
  ) {
    return null;
  }
  try {
    const candidate = validateReleaseRecord(
      staged,
      'staged candidate',
      config,
      run,
    );
    if (cleanStatus(run, candidate.path) !== '') return null;
    return candidate;
  } catch {
    return null;
  }
}

export function adoptLegacyRuntime(
  rawConfig,
  {
    legacyPath,
    instanceState,
    legacyIdentity,
    allowWildcardHost = false,
    inactiveCanonicalState = null,
  },
  dependencies = {},
) {
  const clock = dependencies.now ?? Date.now;
  const config = validateConfig(rawConfig);
  const run = dependencies.run ?? defaultRun;
  secureDirectory(config.supportDir, 'supportDir');
  secureDirectory(config.logDir, 'logDir');
  for (const name of [
    'station-update.log',
    'station-runtime.log',
    'station-lifecycle.jsonl',
  ]) {
    secureFile(path.join(config.logDir, name), name);
  }
  const statePath = path.join(config.supportDir, 'state.json');
  const canonicalLegacy = canonicalPath(legacyPath);
  if (
    !legacyIdentity ||
    typeof legacyIdentity !== 'object' ||
    !/^[0-9a-f]{40}$/i.test(legacyIdentity.sha ?? '') ||
    legacyIdentity.instanceId !== config.instance ||
    typeof legacyIdentity.bootId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      legacyIdentity.bootId,
    )
  ) {
    fail('legacy adoption requires an exact preflight runtime identity');
  }
  const releaseLock = acquireLock(
    path.join(config.supportDir, 'reconcile.lock'),
    { now: clock(), maxAgeMs: dependencies.lockMaxAgeMs },
  );
  try {
    let state = readJson(statePath, {
      version: 1,
      active: null,
      previous: null,
      failedCandidates: [],
      recoveryHistory: [],
    });
    if (state.active) {
      if (
        typeof dependencies.proveMigrationAuthority !== 'function' ||
        dependencies.proveMigrationAuthority() !== true
      ) {
        fail(
          'legacy adoption requires a loaded legacy updater and an unloaded canonical supervisor',
        );
      }
      if (
        !inactiveCanonicalState ||
        JSON.stringify(inactiveCanonicalState) !== JSON.stringify(state)
      ) {
        fail(
          'legacy adoption requires an exact pre-install snapshot to replace inactive canonical state',
        );
      }
      if (
        state.active.adoptedAllowWildcardHost !== undefined &&
        (state.active.adoptedAllowWildcardHost !== true ||
          state.active.runtimePath === undefined ||
          state.active.adoptedIdentity === undefined)
      ) {
        fail('active adopted wildcard authority is invalid');
      }
      let canonicalHealth = null;
      try {
        canonicalHealth = verifyLocalRelease(
          run,
          config,
          state.active.sha,
          state.active.runtimePath ?? state.active.path,
          {
            allowWildcardHost: state.active.adoptedAllowWildcardHost === true,
          },
        );
      } catch {
        // The installer separately proves the canonical supervisor is unloaded.
      }
      const aliasesExactLegacyRuntime =
        canonicalHealth &&
        canonicalPath(state.active.runtimePath ?? state.active.path) ===
          canonicalLegacy &&
        state.active.sha.toLowerCase() === legacyIdentity.sha.toLowerCase() &&
        canonicalHealth.identity.sha.toLowerCase() ===
          legacyIdentity.sha.toLowerCase() &&
        canonicalHealth.identity.instanceId === legacyIdentity.instanceId &&
        canonicalHealth.identity.bootId === legacyIdentity.bootId;
      if (canonicalHealth && !aliasesExactLegacyRuntime) {
        fail('legacy adoption refuses to replace a healthy canonical release');
      }
    }
    const expectedInstanceState = path.join(
      canonicalLegacy,
      '.station',
      'instances',
      `${config.instance}.json`,
    );
    if (canonicalPath(instanceState) !== canonicalPath(expectedInstanceState)) {
      fail('legacy instance state is outside the explicit legacy worktree');
    }
    const legacySha = legacyIdentity.sha.toLowerCase();
    requireConfiguredGitHubOrigin(
      checked(run, 'git', [
        '-C',
        canonicalLegacy,
        'remote',
        'get-url',
        'origin',
      ]),
      config.githubRepo,
    );
    requireConfiguredGitHubOrigin(
      checked(run, 'git', ['-C', config.repo, 'remote', 'get-url', 'origin']),
      config.githubRepo,
    );
    checked(run, 'git', [
      '-C',
      config.repo,
      'fetch',
      '--prune',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
    checked(run, 'git', [
      '-C',
      config.repo,
      'cat-file',
      '-e',
      `${legacySha}^{commit}`,
    ]);
    checked(run, 'git', [
      '-C',
      config.repo,
      'merge-base',
      '--is-ancestor',
      legacySha,
      'origin/main',
    ]);
    const health = verifyLocalRelease(run, config, legacySha, canonicalLegacy, {
      allowWildcardHost,
    });
    if (
      health.identity.sha.toLowerCase() !== legacySha ||
      health.identity.instanceId !== legacyIdentity.instanceId ||
      health.identity.bootId !== legacyIdentity.bootId
    ) {
      fail('legacy runtime identity changed after preflight');
    }
    const sha = legacySha;
    const rollbackPath = path.join(
      config.supportDir,
      'releases',
      `${sha}--release-${randomUUID()}`,
    );
    const builtPath = prepareCandidate(run, config, sha, {
      releaseDir: rollbackPath,
    });
    const rollback = validateReleaseRecord(
      { sha, path: builtPath },
      'legacy rollback',
      config,
      run,
    );
    const commitHealth = verifyLocalRelease(
      run,
      config,
      legacySha,
      canonicalLegacy,
      { allowWildcardHost },
    );
    if (
      commitHealth.identity.sha.toLowerCase() !== legacySha ||
      commitHealth.identity.instanceId !== legacyIdentity.instanceId ||
      commitHealth.identity.bootId !== legacyIdentity.bootId
    ) {
      fail('legacy runtime identity changed before adoption commit');
    }
    const adoptedAt = new Date(clock()).toISOString();
    state = {
      ...state,
      active: {
        ...rollback,
        runtimePath: canonicalLegacy,
        adoptedAt,
        adoptedIdentity: commitHealth.identity,
        ...(allowWildcardHost ? { adoptedAllowWildcardHost: true } : {}),
      },
      health: readyHealth(sha, 'adoption', adoptedAt),
    };
    if (
      inactiveCanonicalState &&
      dependencies.proveMigrationAuthority() !== true
    ) {
      fail('legacy migration authority changed before adoption commit');
    }
    atomicWriteJson(statePath, state);
    return {
      action: 'adopted',
      sha,
      rollbackPath,
      identity: commitHealth.identity,
    };
  } finally {
    releaseLock();
  }
}

export function reconcile(rawConfig, dependencies = {}) {
  const clock = dependencies.now ?? Date.now;
  const invocationStartedMs = clock();
  const config = validateConfig(rawConfig);
  const run = dependencies.run ?? defaultRun;
  const lockNow = clock();
  secureDirectory(config.supportDir, 'supportDir');
  secureDirectory(config.logDir, 'logDir');
  secureFile(path.join(config.logDir, 'station-update.log'), 'update log');
  secureFile(path.join(config.logDir, 'station-runtime.log'), 'runtime log');
  secureFile(
    path.join(config.logDir, 'station-lifecycle.jsonl'),
    'lifecycle journal',
  );
  const statePath = path.join(config.supportDir, 'state.json');
  const releaseLock = acquireLock(
    path.join(config.supportDir, 'reconcile.lock'),
    {
      now: lockNow,
      maxAgeMs: dependencies.lockMaxAgeMs,
    },
  );
  try {
    let state = readJson(statePath, {
      version: 1,
      active: null,
      previous: null,
      failedCandidates: [],
      recoveryHistory: [],
    });
    state.active = validateReleaseRecord(state.active, 'active', config, run);
    state.previous = validateReleaseRecord(
      state.previous,
      'previous',
      config,
      run,
    );
    let recoveredActive = false;
    let activeIdentity = null;
    if (state.active) {
      try {
        activeIdentity = verifyLocalRelease(
          run,
          config,
          state.active.sha,
          state.active.runtimePath ?? state.active.path,
          {
            allowWildcardHost: state.active.adoptedAllowWildcardHost === true,
          },
        ).identity;
        if (
          state.active.adoptedIdentity &&
          (activeIdentity.sha.toLowerCase() !==
            state.active.adoptedIdentity.sha.toLowerCase() ||
            activeIdentity.instanceId !==
              state.active.adoptedIdentity.instanceId ||
            activeIdentity.bootId !== state.active.adoptedIdentity.bootId)
        ) {
          fail('adopted runtime identity changed after adoption');
        }
        state = withReconciliation(state, 'running-verified', clock(), {
          running: {
            sha: activeIdentity.sha,
            instanceId: activeIdentity.instanceId,
            bootId: activeIdentity.bootId,
            releasePath: state.active.path,
          },
        });
        atomicWriteJson(statePath, state);
      } catch (healthError) {
        const detectedMs = clock();
        const detectedAt = new Date(detectedMs).toISOString();
        const preDetectionDurationMs = detectedMs - invocationStartedMs;
        const exit = classifyPriorExit(config, healthError);
        const recovery = {
          sha: state.active.sha,
          detectedAt,
          failedChecks: healthError.failedChecks ?? ['unknown'],
          source: 'local-health',
          reason: healthError.message,
          sender: 'unknown',
          exit,
        };
        state = {
          ...state,
          health: healthState('unavailable', recovery),
        };
        atomicWriteJson(statePath, state);
        const attemptedMs = clock();
        const attemptedAt = new Date(attemptedMs).toISOString();
        state = {
          ...state,
          health: healthState('recovering', recovery, { attemptedAt }),
        };
        atomicWriteJson(statePath, state);
        try {
          if (state.active.runtimePath) {
            state.active = Object.fromEntries(
              Object.entries(state.active).filter(
                ([key]) =>
                  ![
                    'runtimePath',
                    'adoptedAt',
                    'adoptedIdentity',
                    'adoptedAllowWildcardHost',
                  ].includes(key),
              ),
            );
            atomicWriteJson(statePath, state);
          }
          startRelease(run, state.active, config, { force: true });
          const startedMs = clock();
          activeIdentity = verifyLocalRelease(
            run,
            config,
            state.active.sha,
            state.active.path,
          ).identity;
          const localVerifiedMs = clock();
          const localVerifiedAt = new Date(localVerifiedMs).toISOString();
          state.health = readyHealth(
            state.active.sha,
            'local-recovery-proof',
            localVerifiedAt,
          );
          atomicWriteJson(statePath, state);
          verifyTailnetRelease(run, config, activeIdentity);
          const recoveredMs = clock();
          const tailnetVerifiedAt = new Date(recoveredMs).toISOString();
          const recoveredAt = new Date(recoveredMs).toISOString();
          const durationMs = recoveredMs - detectedMs;
          const intervalAllowanceMs = 15_000;
          const budgetMs = 60_000;
          const postDetectionDurationMs = durationMs;
          const worstCaseEndToEndMs =
            intervalAllowanceMs +
            preDetectionDurationMs +
            postDetectionDurationMs;
          const withinBudget = worstCaseEndToEndMs <= budgetMs;
          const receipt = {
            ...recovery,
            attemptedAt,
            recoveredAt,
            outcome: 'recovered',
            localVerifiedAt,
            tailnetVerifiedAt,
            durationMs,
            invocationStartedAt: new Date(invocationStartedMs).toISOString(),
            preDetectionDurationMs,
            postDetectionDurationMs,
            intervalAllowanceMs,
            worstCaseEndToEndMs,
            budgetMs,
            withinBudget,
            budgetExceededByMs: Math.max(0, worstCaseEndToEndMs - budgetMs),
            stageDurationsMs: {
              detection: preDetectionDurationMs,
              lifecycleRestart: startedMs - attemptedMs,
              localVerification: localVerifiedMs - startedMs,
              tailnetVerification: recoveredMs - localVerifiedMs,
            },
          };
          state = appendRecovery(state, receipt);
          state.health = healthState('ready', recovery, {
            attemptedAt,
            recoveredAt,
            checkedAt: recoveredAt,
            failedChecks: [],
            reason: withinBudget
              ? 'all required local listeners and tailnet provenance are healthy'
              : `all required local listeners and tailnet provenance are healthy; recovery SLA exceeded by ${receipt.budgetExceededByMs}ms`,
            recoveredFromChecks: recovery.failedChecks,
            source: 'recovery',
          });
          atomicWriteJson(statePath, state);
          recoveredActive = true;
        } catch (recoveryError) {
          const failedMs = clock();
          const failedAt = new Date(failedMs).toISOString();
          const failedChecks = [
            ...new Set([
              ...recovery.failedChecks,
              ...(recoveryError.failedChecks ??
                (recoveryError.message.includes('tailnet') ? ['tailnet'] : [])),
            ]),
          ];
          const receipt = {
            ...recovery,
            failedChecks,
            attemptedAt,
            failedAt,
            outcome: 'failed',
            recoveryError: recoveryError.message,
            durationMs: failedMs - detectedMs,
            invocationStartedAt: new Date(invocationStartedMs).toISOString(),
            intervalAllowanceMs: 15_000,
            preDetectionDurationMs,
            postDetectionDurationMs: failedMs - detectedMs,
            worstCaseEndToEndMs:
              15_000 + preDetectionDurationMs + (failedMs - detectedMs),
            budgetMs: 60_000,
            withinBudget:
              15_000 + preDetectionDurationMs + (failedMs - detectedMs) <=
              60_000,
          };
          state = appendRecovery(state, receipt);
          state.health = healthState('unavailable', recovery, {
            attemptedAt,
            failedAt,
            failedChecks,
            recoveryError: recoveryError.message,
          });
          atomicWriteJson(
            statePath,
            appendFailure(
              state,
              state.active.sha,
              'recovery',
              `${healthError.message}; recovery verification failed: ${recoveryError.message}`,
              failedMs,
            ),
          );
          throw recoveryError;
        }
      }
    }
    // Availability of the already-promoted release is independent of whether a
    // newer origin/main candidate may be promoted. Prove and publish the active
    // release before resolving candidate CI so a pending candidate cannot leave
    // a healthy dogfood target reporting unavailable.
    if (state.active && activeIdentity && !recoveredActive) {
      state.health = readyHealth(
        state.active.sha,
        'local-current-proof',
        new Date(clock()).toISOString(),
      );
      atomicWriteJson(statePath, state);
      try {
        verifyTailnetRelease(run, config, activeIdentity);
      } catch (tailnetError) {
        state.health = {
          status: 'unavailable',
          sha: state.active.sha,
          source: 'tailnet-health',
          reason: tailnetError.message,
          sender: 'unknown',
          failedChecks: ['tailnet'],
          detectedAt: new Date(clock()).toISOString(),
        };
        atomicWriteJson(statePath, state);
        throw tailnetError;
      }
    }
    const tickNow = clock();
    const pendingSha =
      state.reconciliation?.desired?.sha ??
      state.reconciliation?.source?.sha ??
      state.reconciliation?.built?.sha;
    const pendingDesiredDiffers =
      typeof pendingSha === 'string' &&
      pendingSha !== activeIdentity?.sha &&
      state.reconciliation?.phase !== 'ready';
    if (
      state.active &&
      !pendingDesiredDiffers &&
      !shouldPollRemote(state, tickNow)
    ) {
      return {
        action: recoveredActive ? 'recovered' : 'current',
        sha: state.active.sha,
        ci: state.active.ci ?? null,
        remoteCheck: 'deferred',
      };
    }
    const sha = resolveCandidate(run, config);
    const resolvedAt = clock();
    state = withReconciliation(state, 'source-resolved', resolvedAt, {
      desired: { sha, resolvedAt: new Date(resolvedAt).toISOString() },
      source: { sha, repo: config.repo, ref: 'origin/main' },
    });
    state.lastRemoteCheckAt = new Date(resolvedAt).toISOString();
    atomicWriteJson(statePath, state);
    const ci = requireCi(run, config, sha, {
      now: clock(),
      waiverExpiry: (dependencies.env ?? process.env)
        .STATION_DOGFOOD_CI_BILLING_WAIVER_EXPIRES_AT,
    });
    if (state.active?.sha === sha) {
      if (!dependencies.deferPrune) {
        pruneReleases(
          run,
          config,
          new Set([state.active?.path, state.previous?.path].filter(Boolean)),
        );
      }
      return { action: recoveredActive ? 'recovered' : 'current', sha, ci };
    }

    const snapshotReferenced =
      dependencies.deferPrune && state.previous?.sha === sha;
    const candidateReleaseDir = snapshotReferenced
      ? path.join(
          config.supportDir,
          'releases',
          `${sha}--release-${randomUUID()}`,
        )
      : path.join(config.supportDir, 'releases', sha);
    let candidate = resumeCandidate(
      run,
      config,
      sha,
      state.reconciliation?.built,
    );
    let candidateCreated = false;
    let releaseDir = candidate?.path;
    try {
      if (!candidate) {
        state = withReconciliation(state, 'staging', clock(), {
          built: { sha, path: candidateReleaseDir, complete: false },
        });
        atomicWriteJson(statePath, state);
        releaseDir = prepareCandidate(run, config, sha, {
          releaseDir: candidateReleaseDir,
        });
        candidateCreated = true;
        candidate = validateReleaseRecord(
          { sha, path: releaseDir },
          'candidate',
          config,
          run,
        );
      }
      state = withReconciliation(state, 'built', clock(), {
        built: { sha, path: candidate.path, complete: true },
      });
      atomicWriteJson(statePath, state);
    } catch (error) {
      const phase = error.stage === 'install' ? 'install' : 'build';
      state = recordStageFailure(state, sha, phase, error, clock());
      atomicWriteJson(statePath, state);
      if (canonicalPath(candidateReleaseDir) !== state.previous?.path) {
        try {
          removeRelease(run, config, candidateReleaseDir);
        } catch {
          // Preserve the build failure as the primary actionable error.
        }
      }
      throw error;
    }
    if (dependencies.stageOnly) {
      return {
        action: 'staged',
        sha,
        runningSha: activeIdentity?.sha ?? null,
        candidatePath: candidate.path,
        candidateCreated,
        ci,
      };
    }
    const previousRunning = state.active;
    const previous = state.active
      ? Object.fromEntries(
          Object.entries(state.active).filter(
            ([key]) =>
              ![
                'runtimePath',
                'adoptedAt',
                'adoptedIdentity',
                'adoptedAllowWildcardHost',
              ].includes(key),
          ),
        )
      : null;
    let activeWasStopped = false;
    try {
      state = withReconciliation(state, 'promoting', clock());
      atomicWriteJson(statePath, state);
      if (previousRunning) {
        stopRelease(run, previousRunning, config, 'promotion');
        activeWasStopped = true;
      }
      rotateRuntimeLog(config);
      startRelease(run, candidate, config);
      const candidateHealth = verifyLocalRelease(
        run,
        config,
        candidate.sha,
        candidate.path,
      );
      state = {
        ...state,
        health: readyHealth(
          candidate.sha,
          'promotion-local-proof',
          new Date(clock()).toISOString(),
        ),
      };
      atomicWriteJson(statePath, state);
      verifyTailnetRelease(run, config, candidateHealth.identity);
    } catch (promotionError) {
      try {
        runStation(run, candidate.path, config, 'stop', [
          '--stop-intent=rollback',
        ]);
      } catch (candidateStopError) {
        const rollbackError = new Error(
          `${promotionError.message}; candidate stop proof failed: ${candidateStopError.message}`,
        );
        atomicWriteJson(
          statePath,
          recordStageFailure(state, sha, 'rollback', rollbackError, clock()),
        );
        fail(
          `promotion of ${sha} failed (${promotionError.message}); candidate stop proof also failed (${candidateStopError.message})`,
        );
      }
      if (previous && activeWasStopped) {
        try {
          rotateRuntimeLog(config);
          startRelease(run, previous, config);
          const rollbackHealth = verifyLocalRelease(
            run,
            config,
            previous.sha,
            previous.path,
          );
          state = {
            ...state,
            active: previous,
            health: readyHealth(
              previous.sha,
              'rollback-local-proof',
              new Date(clock()).toISOString(),
            ),
          };
          atomicWriteJson(statePath, state);
          verifyTailnetRelease(run, config, rollbackHealth.identity);
        } catch (rollbackError) {
          const combined = new Error(
            `${promotionError.message}; rollback failed: ${rollbackError.message}`,
          );
          atomicWriteJson(
            statePath,
            recordStageFailure(state, sha, 'rollback', combined, clock()),
          );
          fail(
            `promotion of ${sha} failed (${promotionError.message}); rollback of ${previous.sha} also failed (${rollbackError.message})`,
          );
        }
      }
      atomicWriteJson(
        statePath,
        recordStageFailure(state, sha, 'promotion', promotionError, clock()),
      );
      if (candidate.path !== state.previous?.path) {
        try {
          removeRelease(run, config, candidate.path);
        } catch {
          // Preserve the promotion failure as the primary actionable error.
        }
      }
      throw promotionError;
    }

    const promotedAt = new Date(clock()).toISOString();
    const promotedState = withReconciliation(state, 'ready', clock(), {
      built: { sha, path: candidate.path, complete: true },
      running: {
        sha,
        instanceId: config.instance,
        releasePath: candidate.path,
      },
    });
    atomicWriteJson(statePath, {
      ...promotedState,
      version: 1,
      active: { ...candidate, promotedAt, ci },
      previous,
      lastSuccessfulReconcileAt: promotedAt,
      health: readyHealth(sha, 'promotion', promotedAt),
    });
    if (!dependencies.deferPrune) {
      pruneReleases(
        run,
        config,
        new Set([candidate.path, previous?.path].filter(Boolean)),
      );
    }
    return { action: 'promoted', sha, previousSha: previous?.sha ?? null, ci };
  } finally {
    releaseLock();
  }
}

export function readSupervisorStatus(rawConfig) {
  const config = validateConfig(rawConfig);
  return readJson(path.join(config.supportDir, 'state.json'), {
    version: 1,
    active: null,
    previous: null,
    failedCandidates: [],
  });
}

export function pruneSupervisorReleases(rawConfig, dependencies = {}) {
  const config = validateConfig(rawConfig);
  const run = dependencies.run ?? defaultRun;
  const now = dependencies.now?.() ?? Date.now();
  secureDirectory(config.supportDir, 'supportDir');
  const releaseLock = acquireLock(
    path.join(config.supportDir, 'reconcile.lock'),
    { now, maxAgeMs: dependencies.lockMaxAgeMs },
  );
  try {
    const state = readJson(path.join(config.supportDir, 'state.json'), null);
    if (!state) fail('cannot prune releases without supervisor state');
    const active = validateReleaseRecord(state.active, 'active', config, run);
    const previous = validateReleaseRecord(
      state.previous,
      'previous',
      config,
      run,
    );
    pruneReleases(
      run,
      config,
      new Set([active?.path, previous?.path].filter(Boolean)),
    );
    return {
      activeSha: active?.sha ?? null,
      previousSha: previous?.sha ?? null,
    };
  } finally {
    releaseLock();
  }
}

export function rollbackInstall(
  rawConfig,
  { stateSnapshot, stateExisted },
  dependencies = {},
) {
  const config = validateConfig(rawConfig);
  const run = dependencies.run ?? defaultRun;
  const now = dependencies.now?.() ?? Date.now();
  secureDirectory(config.supportDir, 'supportDir');
  secureDirectory(config.logDir, 'logDir');
  const statePath = path.join(config.supportDir, 'state.json');
  const releaseLock = acquireLock(
    path.join(config.supportDir, 'reconcile.lock'),
    {
      now,
      maxAgeMs: dependencies.lockMaxAgeMs,
    },
  );
  try {
    const currentRaw = existsSync(statePath)
      ? readJson(statePath, null)
      : { active: null, previous: null };
    const currentActive = validateReleaseRecord(
      currentRaw?.active,
      'installer current active',
      config,
      run,
    );
    let priorRaw = null;
    let priorActive = null;
    if (stateExisted) {
      if (!stateSnapshot || !path.isAbsolute(stateSnapshot)) {
        fail('rollback state snapshot must be an absolute path');
      }
      priorRaw = readJson(stateSnapshot, null);
      priorActive = validateReleaseRecord(
        priorRaw?.active,
        'installer prior active',
        config,
        run,
      );
      validateReleaseRecord(
        priorRaw?.previous,
        'installer prior previous',
        config,
        run,
      );
    }

    if (currentActive) stopRelease(run, currentActive, config, 'rollback');

    if (stateExisted) {
      const snapshotBytes = readFileSync(stateSnapshot);
      const snapshotMode = statSync(stateSnapshot).mode & 0o777;
      const temporary = `${statePath}.${process.pid}.rollback`;
      writeFileSync(temporary, snapshotBytes, { mode: snapshotMode });
      chmodSync(temporary, snapshotMode);
      renameSync(temporary, statePath);
      if (!readFileSync(statePath).equals(snapshotBytes)) {
        fail('restored supervisor state differs from its installer snapshot');
      }
    } else {
      rmSync(statePath, { force: true });
    }

    if (priorActive) {
      rotateRuntimeLog(config);
      startRelease(run, priorActive, config);
      verifyLocalRelease(run, config, priorActive.sha, priorActive.path);
    }
    return {
      restored: stateExisted,
      activeSha: priorActive?.sha ?? null,
    };
  } finally {
    releaseLock();
  }
}

export function validateSupervisorConfig(rawConfig) {
  const config = validateConfig(rawConfig);
  secureDirectory(config.supportDir, 'supportDir');
  secureDirectory(config.logDir, 'logDir');
  return config;
}

function appendReconcileOutcome(config, outcome) {
  const line = `${new Date().toISOString()} ${JSON.stringify(outcome)}\n`;
  mkdirSync(config.logDir, { recursive: true });
  appendFileSync(path.join(config.logDir, 'station-update.log'), line);
  chmodSync(path.join(config.logDir, 'station-update.log'), 0o600);
}

export async function supervise(rawConfig, dependencies = {}) {
  const config = validateConfig(rawConfig);
  const intervalMs = dependencies.intervalMs ?? 15_000;
  const maxIterations = dependencies.maxIterations ?? Number.POSITIVE_INFINITY;
  const reconcileOnce = dependencies.reconcile ?? reconcile;
  const reportError =
    dependencies.reportError ?? ((error) => console.error(error));
  let stopped = false;
  let wake = null;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  const sleep =
    dependencies.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, milliseconds);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      }));
  const registerSignals = dependencies.registerSignals !== false;
  if (registerSignals) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  try {
    for (
      let iteration = 0;
      iteration < maxIterations && !stopped;
      iteration++
    ) {
      try {
        const outcome = reconcileOnce(config);
        appendReconcileOutcome(config, outcome);
      } catch (error) {
        reportError(
          `station dogfood reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (iteration + 1 < maxIterations && !stopped) await sleep(intervalMs);
    }
  } finally {
    if (registerSignals) {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
}

function loadConfig(configPath) {
  return readJson(path.resolve(configPath), null);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const run = dependencies.run ?? defaultRun;
  const [command = 'reconcile', ...rest] = argv;
  const configArg = rest.find((arg) => arg.startsWith('--config='));
  if (!configArg)
    fail(
      'usage: station-dogfood-reconcile.mjs <supervise|reconcile|status> --config=/absolute/path.json',
    );
  const configPath = configArg.slice('--config='.length);
  const config = loadConfig(configPath);
  if (command === 'validate-config') {
    const validated = validateSupervisorConfig(config);
    console.log(
      JSON.stringify({
        ok: true,
        supportDir: validated.supportDir,
        logDir: validated.logDir,
      }),
    );
    return;
  }
  if (command === 'rollback-install') {
    const snapshotArg = rest.find((arg) => arg.startsWith('--state-snapshot='));
    const existedArg = rest.find((arg) => arg.startsWith('--state-existed='));
    if (!snapshotArg || !existedArg) {
      fail('rollback-install requires --state-snapshot and --state-existed');
    }
    console.log(
      JSON.stringify(
        rollbackInstall(config, {
          stateSnapshot: snapshotArg.slice('--state-snapshot='.length),
          stateExisted: existedArg.slice('--state-existed='.length) === '1',
        }),
      ),
    );
    return;
  }
  if (command === 'adopt-legacy') {
    const legacyPathArg = rest.find((arg) => arg.startsWith('--legacy-path='));
    const instanceStateArg = rest.find((arg) =>
      arg.startsWith('--instance-state='),
    );
    const legacyShaArg = rest.find((arg) => arg.startsWith('--legacy-sha='));
    const legacyBootIdArg = rest.find((arg) =>
      arg.startsWith('--legacy-boot-id='),
    );
    const legacyInstanceIdArg = rest.find((arg) =>
      arg.startsWith('--legacy-instance-id='),
    );
    const inactiveCanonicalStateArg = rest.find((arg) =>
      arg.startsWith('--inactive-canonical-state='),
    );
    const legacyLabelArg = rest.find((arg) =>
      arg.startsWith('--legacy-label='),
    );
    const legacyPlistSnapshotArg = rest.find((arg) =>
      arg.startsWith('--legacy-plist-snapshot='),
    );
    const legacyPlistArg = rest.find((arg) =>
      arg.startsWith('--legacy-plist='),
    );
    const legacyRunnerArg = rest.find((arg) =>
      arg.startsWith('--legacy-runner='),
    );
    const legacyRunnerSnapshotArg = rest.find((arg) =>
      arg.startsWith('--legacy-runner-snapshot='),
    );
    const inactiveCanonicalStatePath = inactiveCanonicalStateArg?.slice(
      '--inactive-canonical-state='.length,
    );
    if (inactiveCanonicalStatePath) {
      secureFile(inactiveCanonicalStatePath, 'inactive canonical state');
      if (
        !legacyLabelArg ||
        !legacyPlistArg ||
        !legacyPlistSnapshotArg ||
        !legacyRunnerArg ||
        !legacyRunnerSnapshotArg
      ) {
        fail(
          'inactive canonical replacement requires the captured legacy launch contract',
        );
      }
    }
    if (
      !legacyPathArg ||
      !instanceStateArg ||
      !legacyShaArg ||
      !legacyBootIdArg ||
      !legacyInstanceIdArg
    ) {
      fail(
        'adopt-legacy requires --legacy-path, --instance-state, and exact preflight identity',
      );
    }
    console.log(
      JSON.stringify(
        adoptLegacyRuntime(
          config,
          {
            legacyPath: legacyPathArg.slice('--legacy-path='.length),
            instanceState: instanceStateArg.slice('--instance-state='.length),
            legacyIdentity: {
              sha: legacyShaArg.slice('--legacy-sha='.length),
              bootId: legacyBootIdArg.slice('--legacy-boot-id='.length),
              instanceId: legacyInstanceIdArg.slice(
                '--legacy-instance-id='.length,
              ),
            },
            allowWildcardHost: rest.includes('--allow-wildcard-host'),
            inactiveCanonicalState: inactiveCanonicalStatePath
              ? readJson(inactiveCanonicalStatePath)
              : null,
          },
          {
            proveMigrationAuthority: inactiveCanonicalStatePath
              ? createLegacyMigrationProof(
                  {
                    legacyLabel: legacyLabelArg.slice('--legacy-label='.length),
                    legacyPlist: legacyPlistArg.slice('--legacy-plist='.length),
                    legacyPlistSnapshot: legacyPlistSnapshotArg.slice(
                      '--legacy-plist-snapshot='.length,
                    ),
                    legacyRunner: legacyRunnerArg.slice(
                      '--legacy-runner='.length,
                    ),
                    legacyRunnerSnapshot: legacyRunnerSnapshotArg.slice(
                      '--legacy-runner-snapshot='.length,
                    ),
                  },
                  run,
                )
              : undefined,
            run,
          },
        ),
      ),
    );
    return;
  }
  if (command === 'reconcile') {
    const outcome = reconcile(config, {
      deferPrune: rest.includes('--defer-prune'),
      stageOnly: rest.includes('--stage-only'),
    });
    appendReconcileOutcome(config, outcome);
    console.log(JSON.stringify(outcome));
    return;
  }
  if (command === 'supervise') {
    await supervise(config);
    return;
  }
  if (command === 'prune') {
    console.log(JSON.stringify(pruneSupervisorReleases(config)));
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(readSupervisorStatus(config), null, 2));
    return;
  }
  fail(`unknown dogfood command: ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    console.error(`station dogfood reconcile failed: ${error.message}`);
    process.exitCode = 1;
  }
}
