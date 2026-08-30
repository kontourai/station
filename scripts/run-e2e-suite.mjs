import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getProductE2EExecutionPhases,
  getSpecsForSuite,
  PR_BROWSER_SMOKE_CONTRACT,
  validateE2EManifest,
} from '../tests/e2e-manifest.mjs';
import { copyBoundedE2EEvidence } from './lib/e2e-latest-evidence.mjs';
import {
  resolveE2ERunnerSelection,
  withValidatedNodePath,
} from './lib/e2e-runner-options.mjs';
import {
  findPreferredPortBlock,
  findPreferredPortOutside,
} from './lib/free-ports.mjs';
import {
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';

const SUPPORTED_SUITES = [
  'pr-smoke',
  'product',
  'first-run',
  'starter-clean-install',
  'smoke-live',
  'extended',
  'screenshot',
  'android',
];

export const E2E_SUITE_PORTS = Object.freeze({
  'pr-smoke': { server: 3232, ui: 5264 },
  product: { server: 3242, ui: 5274 },
  'first-run': { server: 3302, ui: 5334 },
  'starter-clean-install': { server: 3342, ui: 5374 },
  'smoke-live': { server: 3252, ui: 5284 },
  extended: { server: 3262, ui: 5294 },
  screenshot: { server: 3282, ui: 5314 },
  android: { server: 3292, ui: 5324 },
});

export function playwrightBrowsersDirectory(
  rootDir,
  configuredPath = process.env.PLAYWRIGHT_BROWSERS_PATH,
) {
  if (configuredPath && configuredPath !== '0')
    return resolve(rootDir, configuredPath);
  return join(rootDir, 'node_modules', 'playwright-core', '.local-browsers');
}

function assertPlaywrightBrowsersInstalled(rootDir) {
  const browsersDir = playwrightBrowsersDirectory(rootDir);
  const installed = existsSync(browsersDir)
    ? readdirSync(browsersDir).filter((entry) =>
        existsSync(join(browsersDir, entry, 'INSTALLATION_COMPLETE')),
      )
    : [];
  const hasChromium = installed.some((entry) => /^chromium-\d/.test(entry));
  const hasHeadlessShell = installed.some((entry) =>
    /^chromium_headless_shell-\d/.test(entry),
  );
  if (!hasChromium || !hasHeadlessShell) {
    throw new Error(
      `Playwright browsers are missing or incomplete in ${browsersDir} ` +
        `(found: ${installed.join(', ') || 'none'}). ` +
        'Install Chromium at the configured PLAYWRIGHT_BROWSERS_PATH before running E2E suites — ' +
        'failing fast here instead of letting every spec die on browserType.launch.',
    );
  }
}

function parseSuite(argv) {
  const suiteArg = argv.find((arg) => arg.startsWith('--suite='));
  const suite = suiteArg?.split('=')[1] ?? 'product';
  if (!SUPPORTED_SUITES.includes(suite)) {
    throw new Error(
      `Unknown E2E suite '${suite}'. Use ${SUPPORTED_SUITES.join(', ')}.`,
    );
  }
  return suite;
}

function shouldListSpecs(argv) {
  return argv.includes('--list') || argv.includes('--dry-run');
}

export function e2eTestResultsRoot(root, instance) {
  return join(root, 'test-results', instance);
}

/** Preserve a failing bucket's managed Playwright artifacts for the full-run pointer. */
export function retainE2EBucketFailureEvidence({
  testResultsRoot,
  evidenceRoot,
  suite,
}) {
  if (!evidenceRoot) return false;
  copyBoundedE2EEvidence(
    testResultsRoot,
    join(evidenceRoot, 'buckets', suite),
    { allowMissing: true, ignoredBasenames: ['.last-run.json'] },
  );
  return true;
}

const MAX_RETAINED_E2E_RESULT_ROOTS = 12;

function validE2EInstance(instance) {
  return typeof instance === 'string' && /^e2e-[a-z0-9-]+$/.test(instance);
}

export function removeE2ETestResults(root, instance) {
  if (!validE2EInstance(instance))
    throw new Error('unsafe E2E result instance');
  const parent = resolve(root, 'test-results');
  const target = resolve(e2eTestResultsRoot(root, instance));
  if (!target.startsWith(`${parent}/`))
    throw new Error('unsafe E2E result path');
  const parentInfo = lstatSync(parent, { throwIfNoEntry: false });
  if (parentInfo?.isSymbolicLink())
    throw new Error('refusing symlinked E2E result parent');
  const info = lstatSync(target, { throwIfNoEntry: false });
  if (info?.isSymbolicLink()) throw new Error('refusing symlinked E2E result');
  rmSync(target, { recursive: true, force: true });
}

/** Retain only the newest completed failure roots; active leases are fenced. */
export function sweepRetainedE2ETestResults(
  root,
  { maxRetained = MAX_RETAINED_E2E_RESULT_ROOTS } = {},
) {
  if (!Number.isSafeInteger(maxRetained) || maxRetained < 0)
    throw new Error('invalid E2E result retention bound');
  const parent = resolve(root, 'test-results');
  const parentInfo = lstatSync(parent, { throwIfNoEntry: false });
  if (!parentInfo) return 0;
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    throw new Error('unsafe E2E result parent');
  const completed = readdirSync(parent, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        validE2EInstance(entry.name) &&
        !existsSync(e2eLeasePath(root, entry.name)),
    )
    .flatMap((entry) => {
      const info = lstatSync(join(parent, entry.name), {
        throwIfNoEntry: false,
      });
      return info?.isDirectory() && !info.isSymbolicLink()
        ? [{ instance: entry.name, mtimeMs: info.mtimeMs }]
        : [];
    })
    .sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs ||
        left.instance.localeCompare(right.instance),
    );
  for (const { instance } of completed.slice(maxRetained))
    removeE2ETestResults(root, instance);
  return Math.max(0, completed.length - maxRetained);
}

export function assertSupportedE2EPlatform(platform = process.platform) {
  if (platform === 'win32') {
    throw new Error(
      'Station E2E requires a POSIX host with process-group settlement; Windows needs a separately owned host lane.',
    );
  }
}

const E2E_SETTLEMENT_MS = 5_000;
const E2E_STARTUP_DEADLINE_MS = 120_000;
const E2E_STOP_DEADLINE_MS = 15_000;
const E2E_STOP_SETTLEMENT_MS = 7_500;
const E2E_LEASE_DIRECTORY = '.kontourai/e2e-runs';
const E2E_STARTUP_CAPTURE_BYTES = 16 * 1024;
const E2E_STARTUP_FAILURE_TAIL_BYTES = 4 * 1024;

/**
 * A successful launcher exit alone is not settlement: it may have left an
 * exact descendant holding this run's temp/output paths.  Keep that fence
 * until the shared owned-process primitive can prove the group is gone.
 */
export async function settleE2EExecution(
  execution,
  processLabel,
  {
    terminate = terminateSuiteExecution,
    waitForSettlement = waitForSuiteSettlement,
  } = {},
) {
  const result = await execution.completion;
  if (!execution.isAlive()) return result;
  const cleanup = await terminate(execution, {
    processLabel,
    waitForSuiteSettlement: waitForSettlement,
    terminationGraceMs: E2E_SETTLEMENT_MS,
    terminationForceMs: E2E_SETTLEMENT_MS,
  });
  if (!cleanup.settled || cleanup.errors?.length) {
    throw new Error(
      `${processLabel} left an owned process group alive; retaining its run lease`,
    );
  }
  return result;
}

/**
 * Bounds one already-owned command without ever falling back to process-name
 * matching. A deadline still allows the shared lifecycle to send SIGTERM,
 * wait, and escalate to SIGKILL for that exact process group.
 */
export async function awaitOwnedCommandDeadline(
  execution,
  processLabel,
  {
    deadlineMs,
    terminationGraceMs = E2E_SETTLEMENT_MS,
    terminationForceMs = E2E_SETTLEMENT_MS,
    terminate = terminateSuiteExecution,
    waitForSettlement = waitForSuiteSettlement,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)
    throw new Error('owned command deadline must be a positive integer');
  let timer;
  try {
    const outcome = await Promise.race([
      execution.completion.then((result) => ({ kind: 'completed', result })),
      new Promise((resolve) => {
        timer = setTimer(() => resolve({ kind: 'timed_out' }), deadlineMs);
        timer?.unref?.();
      }),
    ]);
    if (outcome.kind === 'completed' && !execution.isAlive())
      return outcome.result;

    const cleanup = await terminate(execution, {
      processLabel,
      waitForSuiteSettlement: waitForSettlement,
      terminationGraceMs,
      terminationForceMs,
    });
    if (!cleanup.settled || cleanup.errors?.length)
      throw new Error(
        `${processLabel}${outcome.kind === 'timed_out' ? ` timed out after ${deadlineMs}ms` : ' exited'}; exact process group did not settle, retaining diagnostics and lease`,
      );
    if (outcome.kind === 'timed_out')
      throw new Error(
        `${processLabel} timed out after ${deadlineMs}ms; exact process group settled after ${cleanup.escalated ? 'SIGTERM and SIGKILL' : 'SIGTERM'}`,
      );
    return outcome.result;
  } finally {
    if (timer !== undefined) clearTimer(timer);
  }
}

function startOwned(command, args, options = {}, processLabel = command) {
  const { env = process.env, ...spawnOverrides } = options;
  const execution = executeOwnedProcess(command, args, spawn, processLabel, {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    ...spawnOverrides,
    env: withValidatedNodePath(env),
  });
  // Children run in their own process groups so a crash-recovery owner can
  // target exactly one run. Register both terminal signals immediately: a
  // signal delivered while `station start` or Playwright is in flight must
  // settle that group before this runner releases its named temp/output paths.
  const onSignal = () => {
    void terminateSuiteExecution(execution, {
      processLabel,
      waitForSuiteSettlement,
      terminationGraceMs: E2E_SETTLEMENT_MS,
      terminationForceMs: E2E_SETTLEMENT_MS,
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  void execution.completion.finally(() => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  });
  return execution;
}

async function run(command, args, options = {}) {
  const execution = startOwned(command, args, options, command);
  const result = await settleE2EExecution(execution, command);
  if (result.status === 0) return;
  throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

export async function runE2EExecutionPhases(phases, execute) {
  const failures = [];
  for (const phase of phases) {
    try {
      await execute(phase);
    } catch (error) {
      failures.push({ phase: phase.name, error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      failures
        .map(
          ({ phase, error }) =>
            `${phase}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .join('; '),
    );
  }
}

export function e2ePhaseOutputRoot(testResultsRoot, suite, phaseName) {
  return suite === 'product'
    ? join(testResultsRoot, phaseName)
    : testResultsRoot;
}

async function runWithinOwnedDeadline(
  command,
  args,
  { deadlineMs, terminationGraceMs, terminationForceMs, ...options },
) {
  const execution = startOwned(command, args, options, command);
  const result = await awaitOwnedCommandDeadline(execution, command, {
    deadlineMs,
    terminationGraceMs,
    terminationForceMs,
  });
  if (result.status === 0) return;
  throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

function stopE2EInstance(instance) {
  return runWithinOwnedDeadline(
    './station',
    ['stop', `--instance=${instance}`],
    {
      deadlineMs: E2E_STOP_DEADLINE_MS,
      terminationGraceMs: E2E_STOP_SETTLEMENT_MS,
      terminationForceMs: E2E_STOP_SETTLEMENT_MS,
    },
  );
}

export function appendE2EStartupOutputTail(
  current,
  chunk,
  maxBytes = E2E_STARTUP_CAPTURE_BYTES,
) {
  const combined = `${current}${chunk.toString()}`;
  if (Buffer.byteLength(combined) <= maxBytes) return combined;
  const points = Array.from(combined);
  let tail = '';
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const next = `${points[index]}${tail}`;
    if (Buffer.byteLength(next) > maxBytes) break;
    tail = next;
  }
  return tail;
}

export function renderE2EStartupFailureTail(
  output,
  logPath,
  maxBytes = E2E_STARTUP_FAILURE_TAIL_BYTES,
) {
  const tail = appendE2EStartupOutputTail('', output, maxBytes);
  return tail
    ? ` Startup output tail:\n${tail}${logPath ? `\nServer log: ${logPath}` : ''}`
    : logPath
      ? ` Server log: ${logPath}`
      : '';
}

// Like run(), but retains only a bounded startup tail. `./station start` can
// print an entire Vite/build transcript (~19k+ bytes) before it is ready; a
// successful run needs one concise handoff, while failures still need enough
// text to classify an instance-registry collision. The owned process and
// settlement protocol is identical to run(); only presentation is different.
async function runCapturing(command, args, options = {}) {
  const execution = startOwned(
    command,
    args,
    { ...options, stdio: ['inherit', 'pipe', 'pipe'] },
    command,
  );
  const { child } = execution;
  let output = '';
  let observedBytes = 0;
  let outputTruncated = false;
  const capture = (stream) => {
    stream.on('data', (chunk) => {
      observedBytes += Buffer.byteLength(chunk);
      const next = appendE2EStartupOutputTail(output, chunk);
      outputTruncated ||= next.length < output.length + chunk.toString().length;
      output = next;
    });
  };
  capture(child.stdout);
  capture(child.stderr);
  let result;
  try {
    result = await awaitOwnedCommandDeadline(execution, command, {
      deadlineMs: E2E_STARTUP_DEADLINE_MS,
    });
  } catch (error) {
    result = { status: 1, error };
  }
  return {
    code: result.status ?? 1,
    output: result.error ? `${output}${String(result.error)}` : output,
    observedBytes,
    outputTruncated,
  };
}

function e2eLeasePath(root, instance) {
  return join(root, E2E_LEASE_DIRECTORY, `${instance}.json`);
}

function e2eRecoveryClaimPath(root, instance) {
  return join(root, E2E_LEASE_DIRECTORY, `.${instance}.recovery.json`);
}

function e2eLeaseLockPath(root, instance) {
  return join(root, E2E_LEASE_DIRECTORY, `.${instance}.lock`);
}

function assertLeaseDirectory(root) {
  const rootPath = resolve(root);
  // Resolve the existing root once to ensure the containment root exists;
  // `/var` -> `/private/var` aliases on macOS are legitimate, so compare
  // containment lexically from the caller's resolved worktree path below.
  realpathSync(rootPath);
  const kontourai = join(rootPath, '.kontourai');
  if (existsSync(kontourai) && lstatSync(kontourai).isSymbolicLink())
    throw new Error(`unsafe E2E lease ancestry: ${kontourai}`);
  const directory = join(root, E2E_LEASE_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`unsafe E2E lease directory: ${directory}`);
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows does not provide POSIX modes.
  }
  return directory;
}

function validLease(root, leasePath, lease) {
  try {
    assertLeaseDirectory(root);
    const rootPath = resolve(root);
    if (
      !lease ||
      lease.root !== rootPath ||
      typeof lease.instance !== 'string' ||
      leasePath !== e2eLeasePath(rootPath, lease.instance)
    )
      return false;
    const expected = [
      `dist-server-${lease.instance}`,
      `dist-ui-${lease.instance}`,
    ].sort();
    if (
      !Array.isArray(lease.outputDirs) ||
      lease.outputDirs.length !== 2 ||
      [...lease.outputDirs].sort().join('\n') !== expected.join('\n')
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

export function writeE2ERunLease(
  root,
  instance,
  outputDirs,
  daemon = null,
  start = null,
) {
  const directory = assertLeaseDirectory(root);
  const path = e2eLeasePath(root, instance);
  const lock = acquireE2ELeaseLock(root, instance, 'writer');
  if (!lock) throw new Error(`E2E run is locked: ${instance}`);
  try {
    const recoveryClaim = e2eRecoveryClaimPath(root, instance);
    if (existsSync(recoveryClaim))
      throw new Error(`E2E run is being recovered: ${instance}`);
    const temporary = join(directory, `.${instance}.${process.pid}.tmp`);
    writeFileSync(
      temporary,
      `${JSON.stringify({
        version: 2,
        root: resolve(root),
        instance,
        outputDirs,
        state: daemon ? 'running' : 'starting',
        runner: processIdentity(process.pid),
        daemon,
        start,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // Windows does not provide POSIX modes.
    }
    if (!lockIsHeld(lock))
      throw new Error(`E2E run lock changed before publication: ${instance}`);
    renameSync(temporary, path);
    return path;
  } finally {
    releaseE2ELeaseLock(lock);
  }
}

function readE2ELease(root, instance) {
  return readLeaseAt(e2eLeasePath(root, instance));
}

function readLeaseAt(path) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function processIdentity(pid, runPs = spawnSync) {
  if (!Number.isInteger(pid) || pid < 1 || process.platform === 'win32')
    return null;
  const started = runPs('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    // lstart is locale- and TZ-shaped; pin so identity is env-independent
    // (#3049).
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    windowsHide: true,
  });
  if (started.status !== 0 || !started.stdout.trim()) return null;
  const grouped = runPs('ps', ['-o', 'pgid=', '-p', String(pid)], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const pgid = Number.parseInt(grouped.stdout.trim(), 10);
  return {
    pid,
    processStart: started.stdout.trim(),
    pgid: Number.isInteger(pgid) && pgid > 0 ? pgid : null,
  };
}

const E2E_OPERATOR_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const E2E_UI_BOOTSTRAP_PATH = '/.well-known/station/v1/pairing/ui-bootstrap';

function isValidE2EOperatorCredential(credential) {
  return (
    typeof credential === 'string' &&
    E2E_OPERATOR_CREDENTIAL_PATTERN.test(credential) &&
    Buffer.from(credential, 'base64url').byteLength === 32
  );
}

function e2eOperatorAuthorizationHeaders(credential) {
  if (!isValidE2EOperatorCredential(credential)) {
    throw new Error('E2E operator credential is missing or malformed');
  }
  return { Authorization: `Bearer ${credential}` };
}

export function extractE2EUiBootstrapToken(output) {
  const matches = [
    ...String(output).matchAll(
      /#station-ui-bootstrap=([A-Za-z0-9_-]{43})(?:\s|$)/g,
    ),
  ];
  if (matches.length !== 1) {
    throw new Error(
      'Station startup output did not publish exactly one UI bootstrap token',
    );
  }
  return matches[0][1];
}

/**
 * Exchanges the launcher capability for the browser's session cookie, over
 * exactly the URL `station start` printed.
 *
 * The exchange goes through the UI PORT (station#3876). That is the whole
 * point of it: the printed
 * `http://127.0.0.1:<uiPort>/#station-ui-bootstrap=…` is how an operator
 * reaches their own Station, so it is the journey the `host` half of
 * `devicePresentation` has to be earned on. `POST /pairing/ui-bootstrap`
 * stamps `locality: 'home-possession'` when the caller is a browser on this
 * machine — direct, or behind Station's own UI proxy attesting a loopback
 * client and a loopback browser `Host` (`isSameMachineBrowserCaller` in
 * `src-server/runtime/routes/runtime-routes.ts`). It previously stamped only
 * the direct-socket exchange, which is why this dialled the server port and
 * why no spec was driving the real journey. A regression in that attestation
 * now reddens the host fixture's own premise assertion, on the URL a user
 * types.
 *
 * WHAT THIS DOES NOT DO, measured on a live instance rather than assumed: it
 * does not change the device class any EXISTING spec sees. `playwright.config`
 * also seeds the operator credential into Connect's vault, the SDK sends it as
 * a bearer, and the bearer is the principal the boundary binds — cookie plus
 * operator bearer reads `paired`, exactly as operator bearer alone does. So
 * the suite-wide default context is a paired device either way; what changes
 * here is only that the credential this function PUBLISHES is one a spec can
 * present ALONE to be the host.
 *
 * WHY IT CANNOT LIVE IN A SPEC. The launcher capability is single-use and a
 * fresh mint replaces the "Station local UI" device record, revoking the
 * session every concurrently running spec is holding. The runner is therefore
 * the only place a home-possession credential can be obtained; WHICH class a
 * context adopts is chosen in `tests/helpers/device-class-context.ts`, per
 * spec.
 *
 * `Origin` stays the UI origin because that is where the browser will present
 * the cookie. The dialled authority is `127.0.0.1:<uiPort>` — a loopback
 * `Host`, which is the fact the proxy attests upstream.
 */
export async function issueE2EBrowserSession({
  uiPort,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65_535) {
    throw new Error('E2E UI port is invalid');
  }
  if (!isValidE2EOperatorCredential(token)) {
    throw new Error('E2E UI bootstrap token is missing or malformed');
  }
  const origin = `http://localhost:${uiPort}`;
  const response = await fetchImpl(
    `http://127.0.0.1:${uiPort}${E2E_UI_BOOTSTRAP_PATH}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      body: JSON.stringify({ token }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `E2E UI bootstrap exchange failed with HTTP ${response.status}`,
    );
  }
  const setCookie = response.headers.get('set-cookie');
  const match = /^station-device=([A-Za-z0-9_-]{43})(?:;|$)/.exec(
    setCookie ?? '',
  );
  if (!match || !isValidE2EOperatorCredential(match[1])) {
    throw new Error('E2E UI bootstrap response omitted a valid session cookie');
  }
  return match[1];
}

/**
 * Reads the operator credential persisted by the exact disposable Station
 * instance this run just started. The harness uses it only for protected host
 * operations, including daemon identity discovery and pairing approval.
 *
 * Throws rather than returning undefined so a missing or malformed record
 * aborts setup before any unauthenticated protected request is attempted.
 */
function readE2EOperatorCredential(root, instance, knownRegistry) {
  const registryPath = join(root, '.station', 'instances', `${instance}.json`);
  const registry =
    knownRegistry ?? JSON.parse(readFileSync(registryPath, 'utf8'));
  const home = registry?.baseDir;
  if (typeof home !== 'string' || !home) {
    throw new Error(
      `Station instance registry ${registryPath} did not publish a home directory`,
    );
  }
  let record;
  try {
    record = JSON.parse(
      readFileSync(join(home, 'security', 'environment.json'), 'utf8'),
    );
  } catch (error) {
    throw new Error(
      `Station security record under ${home} did not publish a valid operator credential`,
      { cause: error },
    );
  }
  if (!isValidE2EOperatorCredential(record?.credential)) {
    throw new Error(
      `Station security record under ${home} did not publish a valid operator credential`,
    );
  }
  return record.credential;
}

function readE2EBootstrapAuthority(root, instance) {
  const registryPath = join(root, '.station', 'instances', `${instance}.json`);
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  return {
    registry,
    operatorCredential: readE2EOperatorCredential(root, instance, registry),
  };
}

export async function discoverE2EDaemon({
  root,
  instance,
  serverPort,
  uiPort,
  bootstrapAuthority,
  fetchImpl = globalThis.fetch,
  readRegistry = (path) => JSON.parse(readFileSync(path, 'utf8')),
  readOperatorCredential = readE2EOperatorCredential,
  processIdentityFn = processIdentity,
} = {}) {
  if (process.platform === 'win32')
    throw new Error('cannot prove exact E2E daemon identity on Windows');
  const registry =
    bootstrapAuthority?.registry ??
    readRegistry(join(root, '.station', 'instances', `${instance}.json`));
  if (
    !Number.isInteger(registry?.serverPid) ||
    !Number.isInteger(registry?.uiPid) ||
    typeof registry?.bootId !== 'string' ||
    registry?.serverFingerprint?.pid !== registry.serverPid ||
    typeof registry?.serverFingerprint?.startToken !== 'string' ||
    registry?.uiFingerprint?.pid !== registry.uiPid ||
    typeof registry?.uiFingerprint?.startToken !== 'string'
  ) {
    throw new Error(
      'Station registry did not publish daemon pid and boot identity',
    );
  }
  const credential =
    bootstrapAuthority?.operatorCredential ??
    readOperatorCredential(root, instance, registry);
  const response = await fetchImpl(
    `http://localhost:${serverPort}/api/system/identity`,
    { headers: e2eOperatorAuthorizationHeaders(credential) },
  );
  if (!response.ok)
    throw new Error('Station daemon identity endpoint is unavailable');
  const identity = await response.json();
  const uiResponse = await fetchImpl(
    `http://localhost:${uiPort}/__station/identity`,
  );
  if (!uiResponse.ok)
    throw new Error('Station UI identity endpoint is unavailable');
  const uiIdentity = await uiResponse.json();
  if (
    identity?.instanceId !== instance ||
    identity?.bootId !== registry.bootId ||
    uiIdentity?.instanceId !== instance ||
    uiIdentity?.bootId !== registry.bootId
  )
    throw new Error('Station registry and daemon boot identity differ');
  const server = processIdentityFn(registry.serverPid);
  const ui = processIdentityFn(registry.uiPid);
  if (!server?.processStart || !server.pgid || !ui?.processStart || !ui.pgid)
    throw new Error('cannot prove exact E2E daemon process identities');
  return {
    server: { ...server, fingerprint: registry.serverFingerprint },
    ui: { ...ui, fingerprint: registry.uiFingerprint },
    instanceId: instance,
    bootId: registry.bootId,
  };
}

export function daemonIsLive(daemon, processIdentityFn = processIdentity) {
  if (process.platform === 'win32' || !daemon?.server || !daemon?.ui)
    return true;
  return [daemon.server, daemon.ui].some((expected) => {
    const actual = processIdentityFn(expected.pid);
    return Boolean(
      actual &&
        actual.processStart === expected.processStart &&
        actual.pgid === expected.pgid,
    );
  });
}

export function canReclaimE2ELease(lease, processIdentityFn = processIdentity) {
  return Boolean(
    process.platform !== 'win32' &&
      Array.isArray(lease.outputDirs) &&
      lease?.daemon &&
      !daemonIsLive(lease.daemon, processIdentityFn),
  );
}

function sameProcessIdentity(expected, actual) {
  return Boolean(
    expected &&
      actual &&
      expected.pid === actual.pid &&
      expected.processStart === actual.processStart &&
      expected.pgid === actual.pgid,
  );
}

function readE2ELeaseLock(path) {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function acquireE2ELeaseLock(root, instance, kind) {
  const path = e2eLeaseLockPath(root, instance);
  const owner = {
    version: 1,
    kind,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    process: processIdentity(process.pid),
  };
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    // Run instance ids are unique, so a lock that outlives its owner is safe
    // evidence to retain for explicit maintenance. Never transfer or delete
    // an existing lock: that would require an unsupported compare-and-rename
    // primitive and could move a live successor's lock (ABA).
    return null;
  }
  try {
    writeFileSync(join(path, 'owner.json'), `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return { path, owner };
  } catch {
    // Only the owner whose token was just published may release this lock.
    // If publication itself failed, no contender can acquire `path` until we
    // remove this still-empty directory.
    if (!readE2ELeaseLock(path)) rmSync(path, { recursive: true, force: true });
    return null;
  }
}

function lockIsHeld(lock) {
  const owner = readE2ELeaseLock(lock.path);
  return Boolean(owner && owner.token === lock.owner.token);
}

function releaseE2ELeaseLock(lock) {
  if (!lockIsHeld(lock)) return false;
  const retiredPath = `${lock.path}.released-${lock.owner.token}`;
  try {
    // Move only the directory carrying our exact token, then delete the
    // private tombstone. A new writer can only acquire the canonical path
    // after this rename and is never a target of the deletion below.
    renameSync(lock.path, retiredPath);
    rmSync(retiredPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Startup writes a lease before `station start` so an interrupted runner can
 * never leave unowned build output behind. A fatal build failure can therefore
 * happen before there is a daemon identity to settle. Only that still-live
 * runner may release its own `starting` lease after it has stopped the named
 * instance; crash recovery deliberately remains daemon-only.
 */
export function canCleanStartingE2ELease(lease, runnerIdentity) {
  return Boolean(
    process.platform !== 'win32' &&
      lease?.state === 'starting' &&
      !lease.daemon &&
      sameProcessIdentity(lease.runner, runnerIdentity),
  );
}

function sameLease(expected, actual) {
  return Boolean(
    expected &&
      actual &&
      expected.root === actual.root &&
      expected.instance === actual.instance &&
      expected.state === actual.state &&
      expected.version === actual.version &&
      expected.outputDirs?.join('\n') === actual.outputDirs?.join('\n') &&
      JSON.stringify(expected.runner) === JSON.stringify(actual.runner) &&
      JSON.stringify(expected.daemon) === JSON.stringify(actual.daemon) &&
      JSON.stringify(expected.start) === JSON.stringify(actual.start),
  );
}

function removeExactLeaseAndOutputs(
  root,
  leasePath,
  lease,
  removeOutputs = true,
) {
  if (!validLease(root, leasePath, lease))
    throw new Error('unsafe E2E lease binding');
  if (!sameLease(lease, readE2ELease(root, lease.instance)))
    throw new Error('E2E lease changed before cleanup');
  const absoluteRoot = resolve(root);
  if (removeOutputs) {
    for (const output of lease.outputDirs) {
      if (typeof output !== 'string' || !/^dist-(server|ui)-e2e-/.test(output))
        throw new Error('unsafe E2E lease output path');
      const target = resolve(absoluteRoot, output);
      if (!target.startsWith(`${absoluteRoot}/`))
        throw new Error('unsafe E2E output');
      const info = lstatSync(target, { throwIfNoEntry: false });
      if (info?.isSymbolicLink())
        throw new Error(`refusing symlink output: ${target}`);
      rmSync(target, { recursive: true, force: true });
    }
  }
  const leaseInfo = lstatSync(leasePath, { throwIfNoEntry: false });
  if (!leaseInfo?.isFile() || leaseInfo.isSymbolicLink())
    throw new Error('unsafe E2E lease replacement');
  if (!sameLease(lease, readE2ELease(root, lease.instance)))
    throw new Error('E2E lease changed during cleanup');
  rmSync(leasePath, { force: true });
}

export async function cleanupE2ERun({
  root,
  leasePath,
  lease,
  stopInstance,
  processIdentityFn = processIdentity,
  runnerIdentity = processIdentityFn(process.pid),
} = {}) {
  if (!lease?.instance)
    return {
      settled: false,
      errors: [
        'E2E lease has no instance identity; retaining lease and outputs',
      ],
    };
  const lock = acquireE2ELeaseLock(
    root,
    lease.instance,
    'cleanup',
    processIdentityFn,
  );
  if (!lock)
    return {
      settled: false,
      errors: ['E2E lease is locked; retaining lease and outputs'],
    };
  const errors = [];
  try {
    if (
      !lockIsHeld(lock) ||
      !validLease(root, leasePath, lease) ||
      !sameLease(lease, readE2ELease(root, lease.instance))
    ) {
      return {
        settled: false,
        errors: [
          'E2E lease changed before cleanup; retaining lease and outputs',
        ],
      };
    }
    try {
      await stopInstance();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (
      !canReclaimE2ELease(lease, processIdentityFn) &&
      !canCleanStartingE2ELease(lease, runnerIdentity)
    ) {
      errors.push(
        'E2E daemon did not prove settled; retaining lease and outputs',
      );
    }
    if (errors.length > 0) return { settled: false, errors };
    if (!lockIsHeld(lock))
      return {
        settled: false,
        errors: ['E2E lease lock changed; retaining lease and outputs'],
      };
    removeExactLeaseAndOutputs(root, leasePath, lease);
    return { settled: true, errors: [] };
  } finally {
    releaseE2ELeaseLock(lock);
  }
}

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function validStartAttempt(start) {
  return Boolean(
    start &&
      validPort(start.serverPort) &&
      validPort(start.serverPort + 1) &&
      validPort(start.serverPort + 2) &&
      validPort(start.serverPort + 3) &&
      validPort(start.uiPort) &&
      start.serverPort !== start.uiPort &&
      Array.isArray(start.groupMembers) &&
      start.groupMembers.every(
        (member) =>
          Number.isInteger(member?.pid) &&
          typeof member?.processStart === 'string' &&
          Number.isInteger(member?.pgid) &&
          member.pgid === start.launcher?.pgid,
      ) &&
      (start.launcher === null ||
        (Number.isInteger(start.launcher?.pid) &&
          typeof start.launcher?.processStart === 'string' &&
          Number.isInteger(start.launcher?.pgid))),
  );
}

function exactProcessIsLive(identity, processIdentityFn) {
  return Boolean(
    identity && sameProcessIdentity(identity, processIdentityFn(identity.pid)),
  );
}

function exactStarterMemberIsLive(start, processIdentityFn) {
  return Boolean(
    start?.groupMembers?.some((member) =>
      exactProcessIsLive(member, processIdentityFn),
    ),
  );
}

function knownExactProcessGroupMembers(identity, runPs = spawnSync) {
  if (!Number.isInteger(identity?.pgid) || identity.pgid < 1) return [];
  const listed = runPs('ps', ['-o', 'pid=', '-g', String(identity.pgid)], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (listed.status !== 0) return [identity];
  const members = listed.stdout
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .map((pid) => processIdentity(pid, runPs))
    .filter((member) => member?.pgid === identity.pgid);
  return members.some((member) => sameProcessIdentity(member, identity))
    ? members
    : [identity];
}

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function startAttemptPortsAreAvailable(
  start,
  portAvailable = portIsAvailable,
) {
  return (
    validStartAttempt(start) &&
    (
      await Promise.all([
        portAvailable(start.serverPort),
        portAvailable(start.serverPort + 1),
        portAvailable(start.serverPort + 2),
        portAvailable(start.serverPort + 3),
        portAvailable(start.uiPort),
      ])
    ).every(Boolean)
  );
}

export async function terminateExactStarter(
  start,
  processIdentityFn = processIdentity,
  kill = process.kill,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const identity = start?.launcher;
  if (!identity || !exactStarterMemberIsLive(start, processIdentityFn))
    return false;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    // Once no exact recorded member remains, the numeric PGID no longer
    // authorizes any observation or another signal: it could belong to a
    // foreign reused group. The recovered ports are checked separately.
    if (!exactStarterMemberIsLive(start, processIdentityFn)) return true;
    try {
      kill(-identity.pgid, signal);
    } catch {
      return false;
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(25);
      if (!exactStarterMemberIsLive(start, processIdentityFn)) return true;
    }
  }
  return false;
}

function claimRecoveryLease(root, leasePath, lease) {
  const claimPath = e2eRecoveryClaimPath(root, lease.instance);
  if (existsSync(claimPath) || !sameLease(lease, readLeaseAt(leasePath)))
    return null;
  try {
    renameSync(leasePath, claimPath);
  } catch {
    return null;
  }
  if (sameLease(lease, readLeaseAt(claimPath))) return claimPath;
  // An unrecognized claim is evidence of a concurrent or corrupt mutation.
  // Retain it rather than using a replace-capable restoration rename.
  return null;
}

function recoveryClaimIsHeld(leasePath, claimPath, lease) {
  return !existsSync(leasePath) && sameLease(lease, readLeaseAt(claimPath));
}

function releaseRecoveryClaim(leasePath, claimPath, lease) {
  if (!recoveryClaimIsHeld(leasePath, claimPath, lease)) return false;
  try {
    // link(2) fails if a canonical successor exists. Unlike rename, it can
    // never replace that successor during release.
    linkSync(claimPath, leasePath);
    rmSync(claimPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function removeClaimedLeaseAndOutputs(
  root,
  leasePath,
  claimPath,
  lease,
  removeOutputs = true,
) {
  if (!recoveryClaimIsHeld(leasePath, claimPath, lease))
    throw new Error('E2E recovery lease changed before cleanup');
  const absoluteRoot = resolve(root);
  if (removeOutputs) {
    for (const output of lease.outputDirs) {
      const target = resolve(absoluteRoot, output);
      if (!target.startsWith(`${absoluteRoot}/`))
        throw new Error('unsafe E2E output');
      const info = lstatSync(target, { throwIfNoEntry: false });
      if (info?.isSymbolicLink())
        throw new Error(`refusing symlink output: ${target}`);
      rmSync(target, { recursive: true, force: true });
    }
  }
  if (!recoveryClaimIsHeld(leasePath, claimPath, lease))
    throw new Error('E2E recovery lease changed during cleanup');
  rmSync(claimPath, { force: true });
}

/**
 * Recover a runner that died while its `station start` child was still in the
 * build/boot window. A planned-port lease is reclaimable only after the
 * original runner is gone, any recorded starter group is exactly settled, and
 * all ports that the named instance could have exposed are bindable again.
 *
 * Legacy pre-attempt leases have no port/child proof. They can only lose their
 * lease when both of their recorded outputs are already absent; this repairs
 * orphaned metadata without claiming an unknown live directory.
 */
export async function recoverInterruptedE2ELease({
  root,
  leasePath,
  lease,
  stopInstance,
  processIdentityFn = processIdentity,
  portAvailable = portIsAvailable,
  terminateStarter = terminateExactStarter,
} = {}) {
  if (
    process.platform === 'win32' ||
    !validLease(root, leasePath, lease) ||
    lease?.state !== 'starting' ||
    lease.daemon ||
    exactProcessIsLive(lease.runner, processIdentityFn)
  )
    return { reclaimed: false, removedOutputs: false };

  if (lease.start && !validStartAttempt(lease.start))
    return { reclaimed: false, removedOutputs: false };

  // A launcher-less planned attempt may have died in the spawn-to-publication
  // window while an unrecorded build child was still starting. Ports are not
  // proof during that window, so leave its lease and outputs untouched.
  if (lease.start?.launcher === null)
    return { reclaimed: false, removedOutputs: false };

  const lock = acquireE2ELeaseLock(
    root,
    lease.instance,
    'recovery',
    processIdentityFn,
  );
  if (!lock) return { reclaimed: false, removedOutputs: false };

  try {
    const claimPath = claimRecoveryLease(root, leasePath, lease);
    if (!claimPath) return { reclaimed: false, removedOutputs: false };

    if (!lease.start) {
      if (lease.outputDirs.every((output) => !existsSync(join(root, output)))) {
        removeClaimedLeaseAndOutputs(root, leasePath, claimPath, lease, false);
        return { reclaimed: true, removedOutputs: false };
      }
      releaseRecoveryClaim(leasePath, claimPath, lease);
      return { reclaimed: false, removedOutputs: false };
    }

    if (!exactStarterMemberIsLive(lease.start, processIdentityFn)) {
      if (!(await startAttemptPortsAreAvailable(lease.start, portAvailable))) {
        if (!lockIsHeld(lock))
          return { reclaimed: false, removedOutputs: false };
        releaseRecoveryClaim(leasePath, claimPath, lease);
        return { reclaimed: false, removedOutputs: false };
      }
      if (
        !lockIsHeld(lock) ||
        !recoveryClaimIsHeld(leasePath, claimPath, lease)
      )
        return { reclaimed: false, removedOutputs: false };
      removeClaimedLeaseAndOutputs(root, leasePath, claimPath, lease);
      return { reclaimed: true, removedOutputs: true };
    }

    // The shared lock fences every cooperating writer before named stop,
    // group signaling, and output deletion. The recovery claim remains a
    // durable crash record while those actions are in flight.
    if (!lockIsHeld(lock) || !recoveryClaimIsHeld(leasePath, claimPath, lease))
      return { reclaimed: false, removedOutputs: false };
    try {
      await stopInstance(lease.instance);
    } catch {
      return { reclaimed: false, removedOutputs: false };
    }
    if (!lockIsHeld(lock) || !recoveryClaimIsHeld(leasePath, claimPath, lease))
      return { reclaimed: false, removedOutputs: false };

    // A named stop is preferred, but it does not necessarily own an orphaned
    // build descendant. A process-group signal is allowed only while one of
    // the persisted member identities still matches exactly.
    if (exactStarterMemberIsLive(lease.start, processIdentityFn)) {
      if (!(await terminateStarter(lease.start, processIdentityFn)))
        return { reclaimed: false, removedOutputs: false };
    }
    if (!lockIsHeld(lock) || !recoveryClaimIsHeld(leasePath, claimPath, lease))
      return { reclaimed: false, removedOutputs: false };
    if (exactStarterMemberIsLive(lease.start, processIdentityFn))
      return { reclaimed: false, removedOutputs: false };

    if (!(await startAttemptPortsAreAvailable(lease.start, portAvailable)))
      return { reclaimed: false, removedOutputs: false };
    if (!lockIsHeld(lock) || !recoveryClaimIsHeld(leasePath, claimPath, lease))
      return { reclaimed: false, removedOutputs: false };

    removeClaimedLeaseAndOutputs(root, leasePath, claimPath, lease);
    return { reclaimed: true, removedOutputs: true };
  } finally {
    releaseE2ELeaseLock(lock);
  }
}

export async function recoverInterruptedE2ERuns({
  root = process.cwd(),
  stopInstance = stopE2EInstance,
  ...options
} = {}) {
  let entries;
  try {
    entries = readdirSync(assertLeaseDirectory(root));
  } catch {
    return 0;
  }
  let reclaimed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const instance = entry.slice(0, -'.json'.length);
    const leasePath = e2eLeasePath(root, instance);
    const lease = readE2ELease(root, instance);
    if (!lease || lease.instance !== instance) continue;
    const result = await recoverInterruptedE2ELease({
      root,
      leasePath,
      lease,
      stopInstance,
      ...options,
    });
    if (result.reclaimed) reclaimed += 1;
  }
  return reclaimed;
}

/**
 * station#1177: classify a failed `./station start` for the retry loop.
 * - 'port-overlap': the CLI's own registry check rejected the block.
 * - 'boot-race': start proceeded but the boot-identity wait lost a port
 *   race — either another instance answered the identity poll ('managed
 *   boot identity mismatch': a concurrent session's runner bound the port
 *   between our free-port check and our bind), nothing answered at all
 *   ('fetch failed'), or the runtime reports that this exact selected server
 *   port became unavailable. These mean THIS block is contested, not that
 *   the build/config is broken — retry on the next block, exactly like an
 *   overlap rejection.
 * - 'fatal': anything else (a genuinely broken boot must abort loudly).
 */
export function classifyStartFailure(output, expectedServerPort) {
  if (/requested ports overlap another live Station instance/i.test(output)) {
    return 'port-overlap';
  }
  if (
    validPort(expectedServerPort) &&
    output.includes(
      `Port ${expectedServerPort} is already in use or unavailable.`,
    )
  ) {
    return 'boot-race';
  }
  if (
    /Timed out waiting for .*(\/api\/system\/identity|\/__station\/identity) \((managed boot identity mismatch|fetch failed)\)/i.test(
      output,
    )
  ) {
    return 'boot-race';
  }
  return 'fatal';
}

/**
 * station#1177: the start-with-retry loop, extracted for behavior tests.
 * Picks a port block near the (already jittered) preferred bias, attempts
 * `./station start`, and on a collision-classified failure (registry
 * overlap or a lost boot race) cleans up and retries on the next +30
 * block. A fatal classification aborts immediately with the CLI's own
 * message; exhaustion reports the LAST classified failure (review MED: a
 * deterministic crash misclassified as a race must not be reported as
 * "could not find a free port block" with no cause).
 */
export async function startWithPortRetry({
  label,
  logPath,
  preferredPorts,
  maxAttempts,
  pickServerPort,
  pickUiPort,
  startInstance,
  stopInstance,
  warn,
  onStarted = () => {},
}) {
  let lastFailure = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const serverBias = preferredPorts.server + attempt * 30;
    const uiBias = preferredPorts.ui + attempt * 30;
    const serverPort = await pickServerPort(serverBias);
    const uiPort = await pickUiPort(uiBias, serverPort);

    const result = await startInstance(serverPort, uiPort);
    if (result.code === 0) {
      onStarted({
        label,
        serverPort,
        uiPort,
        observedBytes: result.observedBytes ?? 0,
        outputTruncated: result.outputTruncated === true,
      });
      return { serverPort, uiPort };
    }

    const failureKind = classifyStartFailure(result.output, serverPort);
    if (failureKind === 'fatal') {
      throw new Error(
        `./station start failed for ${label} (exit ${result.code}) — not a port collision; aborting.` +
          renderE2EStartupFailureTail(result.output, logPath),
      );
    }
    lastFailure = { kind: failureKind, output: result.output };
    warn(
      failureKind === 'port-overlap'
        ? `[e2e] ports ${serverPort}/${uiPort} overlap a live Station instance — ` +
            `retrying on the next port block (attempt ${attempt + 1}/${maxAttempts}).`
        : `[e2e] boot lost a port race on ${serverPort}/${uiPort} (station#1177: ` +
            `a concurrent session's instance answered or claimed the port) — ` +
            `retrying on the next port block (attempt ${attempt + 1}/${maxAttempts}).`,
    );
    // A partial start may have detached the daemon already. A failed stop is
    // not best effort: continuing would reuse contested ports and outputs.
    await stopInstance();
  }
  throw new Error(
    `./station start for ${label} did not survive ${maxAttempts} port-block attempts; ` +
      `last failure was '${lastFailure?.kind ?? 'unknown'}'. If this repeats ` +
      `with 'boot-race' on a quiet host, the boot itself is likely crashing` +
      (logPath ? '.' : '') +
      renderE2EStartupFailureTail(lastFailure?.output ?? '', logPath),
  );
}

/**
 * station#1177: a per-invocation jitter (whole port-block steps of 30, same
 * stepping the retry loop uses) added to the suite's preferred port bias so
 * concurrent sessions don't all herd onto the same starting block. Seedable
 * for tests; bounded so direct attempt biases stay roughly within server
 * 3232-3992 / UI 5264-6024 — bands may overlap other suites', which is safe
 * because the OS free-port check and the CLI's registry rejection both stand
 * in front of any actual bind.
 */
export function portBiasJitter(random = Math.random) {
  const MAX_JITTER_BLOCKS = 16;
  return Math.floor(random() * (MAX_JITTER_BLOCKS + 1)) * 30;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttpOk(url, label, requestInit, fetchImpl) {
  const deadline = Date.now() + 30_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response =
        requestInit === undefined
          ? await fetchImpl(url)
          : await fetchImpl(url, requestInit);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  throw new Error(
    `${label} did not become ready at ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function waitForE2EBootstrapReady({
  serverPort,
  uiPort,
  operatorCredential,
  fetchImpl = globalThis.fetch,
} = {}) {
  const protectedRequest = {
    headers: e2eOperatorAuthorizationHeaders(operatorCredential),
  };
  await Promise.all([
    waitForHttpOk(
      `http://localhost:${serverPort}/api/system/status`,
      'API',
      protectedRequest,
      fetchImpl,
    ),
    waitForHttpOk(
      `http://localhost:${serverPort}/config/app`,
      'app config',
      protectedRequest,
      fetchImpl,
    ),
    waitForHttpOk(`http://localhost:${uiPort}/`, 'UI', undefined, fetchImpl),
  ]);
}

export async function seedE2EEngineChoice(
  baseUrl,
  operatorCredential,
  fetchImpl = globalThis.fetch,
) {
  const response = await fetchImpl(`${baseUrl}/config/app`, {
    method: 'PUT',
    headers: {
      ...e2eOperatorAuthorizationHeaders(operatorCredential),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ builtinAgentEngineConnectionId: null }),
  });
  if (!response.ok) {
    throw new Error(
      `Could not seed the ordinary-suite engine choice: HTTP ${response.status}`,
    );
  }
  const result = await response.json();
  if (result?.success !== true) {
    throw new Error(
      `Could not seed the ordinary-suite engine choice: ${result?.error ?? 'invalid response'}`,
    );
  }
}

/**
 * Record the guided first run as already decided, for every suite but its own.
 *
 * `config-loader-app.ts` writes `firstRun.status: "pending"` exactly once, when
 * a home is CREATED — and every ordinary suite runs against a throwaway home it
 * just created. `resolveFirstRunOffer` reads `pending` as `autoOpen`, so
 * `FirstRunHomeChapter` mounts inside Home as a `ResponsiveDialogSurface`: a
 * focus-trapping modal at `--layer-dialog` with its own scrim, over the first
 * screen every one of these specs lands on.
 *
 * That is correct product behaviour and the wrong precondition for this bucket.
 * It cost 54 of 134 failures in the 2026-08-23 product baseline, and it cost
 * them in a shape that reads like a stale locator rather than an unseeded
 * state: Playwright reports the intended element as visible, enabled and
 * stable, then names `first-run-chapter__overlay` (or the surface's own
 * `responsive-dialog-header`) as the subtree intercepting the click, and the
 * action retries until the test times out. Specs asserting `dialog` count 0
 * after an Escape saw 1 — the chapter, still open behind the dialog they closed.
 *
 * So this is the same seed as `seedE2EEngineChoice` and for the same stated
 * reason: an ordinary suite exercises an ESTABLISHED Station. It is recorded
 * through `POST /config/first-run`, the one route allowed to write the fact, so
 * the server stamps its own observation and the transition rule in
 * `describeFirstRunTransitionViolation` still arbitrates it. The dedicated
 * Clean-install buckets never call this and keep the real `pending` home,
 * which is where their own first-run behaviour is proven.
 *
 * It fails loudly. A suite that could not establish this precondition would
 * otherwise produce exactly the timeouts above, one bucket later.
 */
export async function seedE2EFirstRunDecision(
  baseUrl,
  operatorCredential,
  fetchImpl = globalThis.fetch,
) {
  const response = await fetchImpl(`${baseUrl}/config/first-run`, {
    method: 'POST',
    headers: {
      ...e2eOperatorAuthorizationHeaders(operatorCredential),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'completed' }),
  });
  if (!response.ok) {
    throw new Error(
      `Could not settle the ordinary-suite first-run decision: HTTP ${response.status}`,
    );
  }
  const result = await response.json();
  if (result?.success !== true) {
    throw new Error(
      `Could not settle the ordinary-suite first-run decision: ${result?.error ?? 'invalid response'}`,
    );
  }
}

/**
 * Acknowledge the usage-telemetry disclosure, for every suite but its own.
 *
 * This is the second half of `seedE2EFirstRunDecision`, and it exists because
 * of it. `shouldRenderUsageTelemetryDisclosure`
 * (`onboarding-setup-store.ts:235-245`) withholds the STANDALONE disclosure
 * modal while a home is `pending` — on a fresh home its content is the first
 * STEP of the first-run chapter instead, so at most one overlay reaches the
 * first screen. Settling first run therefore UNMASKS the disclosure: the
 * chapter's scrim is replaced by `station-dialog__overlay`, and the ordinary
 * suites go on failing with the same "subtree intercepts pointer events" shape
 * one modal later. Verified live in exactly that way before this was added.
 *
 * `STATION_E2E_SYSTEM_STATUS_READY=1` is what makes this reachable rather than
 * hypothetical: it keeps the setup launcher away, which is the other condition
 * the disclosure waits on.
 *
 * Acknowledged through the product's own route so the service records it the
 * way the modal's "I understand" does, rather than by writing the home. The
 * Clean-install buckets never call this: there the disclosure is a step of
 * the chapter, and proving it is their job.
 */
export async function seedE2EUsageTelemetryDisclosure(
  baseUrl,
  operatorCredential,
  fetchImpl = globalThis.fetch,
) {
  const response = await fetchImpl(
    `${baseUrl}/api/usage-telemetry/disclosure/acknowledgements`,
    {
      method: 'POST',
      headers: e2eOperatorAuthorizationHeaders(operatorCredential),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not acknowledge the ordinary-suite usage-telemetry disclosure: HTTP ${response.status}`,
    );
  }
  const result = await response.json();
  if (result?.success !== true || result?.data?.acknowledged !== true) {
    throw new Error(
      'Could not acknowledge the ordinary-suite usage-telemetry disclosure: the service did not report it acknowledged',
    );
  }
}

export function isCleanInstallE2ESuite(suite) {
  return suite === 'first-run' || suite === 'starter-clean-install';
}

/**
 * Keep clean-install proof independent from any telemetry configuration in the
 * invoking shell. Empty endpoints prevent both direct product telemetry and
 * OTLP exports; the explicit enablement flag also proves the product's own
 * disabled path rather than merely relying on absent configuration.
 */
export function suiteStationE2EEnv(suite) {
  // station#4464 arbiter rule, same shape as `STATION_E2E_SCREENS` below: an
  // EXPLICIT key in every branch, never a conditional spread. Both consumers
  // spread this after `...process.env`, so a stray `STATION_E2E_MUSE_PROVIDER`
  // already sitting in the runner's own environment would otherwise survive
  // into a suite that never asked for it. `undefined` is not stringified —
  // Node's `spawn` omits any key whose value is `undefined` — so the
  // non-smoke-live suites hand the child no such variable at all.
  const museProvider =
    suite === 'smoke-live' ? SMOKE_LIVE_MUSE_PROVIDER : undefined;
  // #875: explicit in every branch for the same inherited-environment reason
  // as the Muse override. Only the screenshot server requests suppression;
  // the server still requires its temp-home + e2e-screenshot instance
  // conjunction before honoring this value.
  const suppressNativeEngineAdoption = suite === 'screenshot' ? '1' : undefined;
  if (suite === 'starter-clean-install') {
    return {
      STATION_E2E_FIRST_RUN: '1',
      STATION_E2E_RESOURCE_POSTURE_HEALTHY: '1',
      STATION_TELEMETRY_ENABLED: 'false',
      STATION_TELEMETRY_ENDPOINT: '',
      STATION_USAGE_TELEMETRY_KEY: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      STATION_TELEMETRY_API_KEY: '',
      STATION_E2E_MUSE_PROVIDER: museProvider,
      STATION_E2E_SUPPRESS_NATIVE_ENGINE_ADOPTION: suppressNativeEngineAdoption,
    };
  }
  if (suite === 'first-run')
    return {
      STATION_E2E_FIRST_RUN: '1',
      STATION_E2E_MUSE_PROVIDER: museProvider,
      STATION_E2E_SUPPRESS_NATIVE_ENGINE_ADOPTION: suppressNativeEngineAdoption,
    };
  return {
    STATION_E2E_SYSTEM_STATUS_READY: '1',
    STATION_E2E_MUSE_PROVIDER: museProvider,
    STATION_E2E_SUPPRESS_NATIVE_ENGINE_ADOPTION: suppressNativeEngineAdoption,
  };
}

/**
 * #550 — what makes `agents-new-muse-echo-turn.spec.ts` runnable.
 *
 * Station has never passed `--provider` to `muse exec`, so muse's own default
 * (`meta`) always applied and a muse turn cost a live Meta key plus a network
 * round trip — which is why muse was the one engine family whose create-an-
 * agent-and-run-a-turn journey was covered by nothing. `echo` is muse's OWN
 * provider for this: same event envelope, answered from the prompt alone.
 *
 * Scoped to `smoke-live` because that is the only bucket whose server runs a
 * muse turn; no other spec in it touches the muse engine, so nothing else in
 * the bucket changes behavior.
 *
 * Naming it here does not by itself authorize it. The server honors this only
 * on a runtime it can attest is disposable — a `--temp-home` under a
 * runner-owned instance id — so the same variable on a persistent home is
 * inert (`museProviderOverrideContained` in
 * `src-server/providers/adapters/muse-adapter.ts`).
 */
export const SMOKE_LIVE_MUSE_PROVIDER = 'echo';

export function establishedUserPlaywrightEnv(suite) {
  return isCleanInstallE2ESuite(suite)
    ? {}
    : { STATION_E2E_ESTABLISHED_USER: '1' };
}

/**
 * Reclaim build output left behind by interrupted runs.
 *
 * A suite run builds into `dist-server-<instance>` / `dist-ui-<instance>`, named
 * for a per-run instance id, and removes them in its `finally`. That works when
 * the run finishes — but a run killed by Ctrl-C, a CI timeout, or a `pkill`
 * never reaches `finally`, and its two builds stay forever. 116 of them holding
 * 1.4 GB had accumulated in one checkout.
 *
 * The cost is not disk. That much churn keeps FSEvents and Spotlight saturated —
 * observed at 135% CPU with eight mdworker processes on a 15-core machine — and
 * Playwright's actionability check waits for an element to stop moving between
 * frames. On a machine in that state it times out, so specs fail with
 * `locator.click`/`locator.fill` timeouts that look exactly like flakiness and
 * are not.
 *
 * Cleanup in `finally` cannot fix this, because the case that produces the
 * debris is the one where `finally` does not run. Sweeping at startup is the
 * shape that self-heals — the same reason vitest's temp-home root is swept in
 * `globalSetup` rather than trusted to a per-worker exit handler.
 *
 * Age-based, so a concurrently running sibling suite is never touched: its
 * directories were created seconds ago, far inside the threshold.
 */
export function sweepInterruptedBuildDirs(
  root = process.cwd(),
  maxAgeMs = 6 * 60 * 60 * 1000,
  now = Date.now(),
) {
  let reclaimed = 0;
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!/^dist-(server|ui)-e2e-/.test(entry)) continue;
    const path = join(root, entry);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (now - info.mtimeMs < maxAgeMs) continue;
    // Legacy age-only sweeping could reclaim a directory belonging to a
    // paused sibling process (or another worktree copied into this root).
    // New runs publish an exact owner identity before `station start`; only
    // a dead, root-bound lease authorizes recovery of its named outputs.
    const instance = entry.replace(/^dist-(?:server|ui)-/, '');
    const lock = acquireE2ELeaseLock(root, instance, 'sweep');
    if (!lock) continue;
    try {
      const leasePath = e2eLeasePath(root, instance);
      const lease = readE2ELease(root, instance);
      if (
        !lockIsHeld(lock) ||
        !lease ||
        !validLease(root, leasePath, lease) ||
        !sameLease(lease, readE2ELease(root, instance)) ||
        !lease.outputDirs.includes(entry) ||
        !canReclaimE2ELease(lease)
      )
        continue;
      rmSync(path, { recursive: true, force: true });
      reclaimed += 1;
      if (
        lease.outputDirs.every((output) => !existsSync(join(root, output))) &&
        lockIsHeld(lock) &&
        sameLease(lease, readE2ELease(root, instance))
      ) {
        const leaseInfo = lstatSync(leasePath, { throwIfNoEntry: false });
        if (leaseInfo?.isFile() && !leaseInfo.isSymbolicLink())
          rmSync(leasePath);
      }
    } finally {
      releaseE2ELeaseLock(lock);
    }
  }
  return reclaimed;
}

async function main() {
  const argv = process.argv.slice(2);
  const suite = parseSuite(argv);
  const manifestResult = validateE2EManifest({
    rootDir: process.cwd(),
    readFile: (filePath) => readFileSync(filePath, 'utf8'),
  });
  if (!manifestResult.valid) {
    throw new Error(
      `E2E manifest is invalid:\n${manifestResult.errors.join('\n')}`,
    );
  }
  const suiteSpecs = getSpecsForSuite(suite);
  const { specs, grep, screens } = resolveE2ERunnerSelection(
    argv,
    suite,
    suiteSpecs,
  );
  const stationE2EEnv = suiteStationE2EEnv(suite);
  if (specs.length === 0) {
    throw new Error(`E2E suite '${suite}' has no specs.`);
  }
  if (shouldListSpecs(argv)) {
    console.log(
      JSON.stringify({ suite, specs, ...(grep ? { grep } : {}) }, null, 2),
    );
    return;
  }
  assertSupportedE2EPlatform();
  assertPlaywrightBrowsersInstalled(process.cwd());
  const prunedResults = sweepRetainedE2ETestResults(process.cwd());
  if (prunedResults > 0)
    console.log(
      `[e2e] pruned ${prunedResults} retained Playwright result root(s)`,
    );
  const recovered = await recoverInterruptedE2ERuns();
  const reclaimed = sweepInterruptedBuildDirs();
  const recoveredCount = recovered + reclaimed;
  if (recoveredCount > 0) {
    console.log(
      `[e2e] reclaimed ${recoveredCount} interrupted E2E run${recoveredCount === 1 ? '' : 's'}`,
    );
  }
  // CROSS-FILE COUPLE — three server-side containment gates transcribe this
  // exact `e2e-${suite}-${Date.now()}-${base36}` shape as a regex and treat a
  // match as evidence of a disposable runner-owned runtime; change them
  // together with any change here:
  //   - `src-server/providers/adapters/muse-adapter.ts`'s
  //     MUSE_E2E_SMOKE_LIVE_INSTANCE (#550)
  //   - `src-server/services/infra/resource-posture.ts`'s
  //     STARTER_CLEAN_INSTALL_INSTANCE
  //   - `src-server/runtime/bootstrap/native-engine-adoption.ts`'s
  //     SCREENSHOT_E2E_INSTANCE (#875)
  // Nothing fails if they drift; the affected suite simply stops getting the
  // behavior it asks for, which is safe but reads as a mystery.
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const instance = `e2e-${suite}-${suffix}`;
  const outputDirs = [`dist-server-${instance}`, `dist-ui-${instance}`];
  // Keep Playwright's managed artifacts and explicit testInfo.outputPath()
  // screenshots inside this exact runner instance. The shared test-results/
  // parent remains the coordinator's owned artifact root, while concurrent
  // product/extended/light buckets never write the same child directory.
  const testResultsRoot = e2eTestResultsRoot(process.cwd(), instance);
  mkdirSync(testResultsRoot, { recursive: true, mode: 0o700 });
  chmodSync(testResultsRoot, 0o700);
  let runLease = writeE2ERunLease(process.cwd(), instance, outputDirs);
  let lease = readE2ELease(process.cwd(), instance);
  let daemon = null;
  let operatorCredential = null;
  let browserSessionCredential = null;
  // The Station CLI rejects a shared/root-owned log directory such as `/tmp`.
  // Keep startup diagnostics in the instance-owned Playwright artifact root so
  // hosted CI is secure and failures remain uploadable.
  const serverLog = join(testResultsRoot, 'station.log');
  // External-session coverage reads only this isolated Claude config root. It
  // keeps every E2E instance away from a developer's real terminal history.
  const claudeConfigDir = mkdtempSync(join(tmpdir(), `${instance}-claude-`));
  const suitePorts = E2E_SUITE_PORTS[suite];
  // station#1177: de-herd concurrent sessions off the shared preferred block.
  const jitter = portBiasJitter();
  const preferredPorts = {
    server: suitePorts.server + jitter,
    ui: suitePorts.ui + jitter,
  };

  // Start with retry-on-overlap: pick an OS-free port block, try to start, and
  // if `./station start` rejects because the block overlaps a live sibling's
  // registry reservation, bump the preferred start and pick a fresh block.
  // This lets the full contract run even when a sibling instance (e.g.
  // agent-smoke on the default 3242/5274 product-bucket ports) is live.
  const MAX_START_ATTEMPTS = 8;
  let started;
  let runFailure = null;
  let cleanupFailure = null;
  try {
    started = await startWithPortRetry({
      label: instance,
      logPath: serverLog,
      preferredPorts,
      maxAttempts: MAX_START_ATTEMPTS,
      pickServerPort: (bias) => findPreferredPortBlock(bias, 3),
      pickUiPort: (bias, chosenServerPort) =>
        findPreferredPortOutside(bias, chosenServerPort, 3),
      startInstance: async (chosenServerPort, chosenUiPort) => {
        const start = {
          serverPort: chosenServerPort,
          uiPort: chosenUiPort,
          launcher: null,
          groupMembers: [],
        };
        runLease = writeE2ERunLease(
          process.cwd(),
          instance,
          outputDirs,
          null,
          start,
        );
        lease = readE2ELease(process.cwd(), instance);
        let groupSampler;
        let groupSamplingFailure = null;
        try {
          const result = await runCapturing(
            './station',
            [
              'start',
              `--instance=${instance}`,
              '--temp-home',
              '--clean',
              '--force',
              `--port=${chosenServerPort}`,
              `--ui-port=${chosenUiPort}`,
              `--log=${serverLog}`,
            ],
            {
              // The selected status mode must reach the SERVER, not just
              // Playwright: ordinary suites bypass setup, while the dedicated
              // first-run suite intentionally boots with no host-discovered
              // provider.
              env: {
                ...process.env,
                ...stationE2EEnv,
                CLAUDE_CONFIG_DIR: claudeConfigDir,
              },
              onSpawn: (child) => {
                const launcher = processIdentity(child.pid);
                if (!launcher)
                  throw new Error('cannot prove exact E2E starter identity');
                const persistGroupMembers = () => {
                  try {
                    runLease = writeE2ERunLease(
                      process.cwd(),
                      instance,
                      outputDirs,
                      null,
                      {
                        ...start,
                        launcher,
                        groupMembers: knownExactProcessGroupMembers(launcher),
                      },
                    );
                    lease = readE2ELease(process.cwd(), instance);
                  } catch (error) {
                    groupSamplingFailure = error;
                  }
                };
                persistGroupMembers();
                if (groupSamplingFailure) throw groupSamplingFailure;
                groupSampler = setInterval(persistGroupMembers, 25);
                groupSampler.unref?.();
              },
            },
          );
          if (groupSamplingFailure) throw groupSamplingFailure;
          if (result.code !== 0) return result;
          const bootstrapAuthority = readE2EBootstrapAuthority(
            process.cwd(),
            instance,
          );
          operatorCredential = bootstrapAuthority.operatorCredential;
          daemon = await discoverE2EDaemon({
            root: process.cwd(),
            instance,
            serverPort: chosenServerPort,
            uiPort: chosenUiPort,
            bootstrapAuthority,
          });
          browserSessionCredential = await issueE2EBrowserSession({
            uiPort: chosenUiPort,
            token: extractE2EUiBootstrapToken(result.output),
          });
          runLease = writeE2ERunLease(
            process.cwd(),
            instance,
            outputDirs,
            daemon,
          );
          lease = readE2ELease(process.cwd(), instance);
          return result;
        } finally {
          if (groupSampler) clearInterval(groupSampler);
        }
      },
      stopInstance: () => stopE2EInstance(instance),
      warn: (message) => console.warn(message),
      onStarted: ({ serverPort, uiPort, observedBytes, outputTruncated }) => {
        console.log(
          `[e2e] ${instance} started on ${serverPort}/${uiPort}; ` +
            `startup output suppressed (${observedBytes} byte(s) observed${outputTruncated ? ', bounded tail retained' : ''}).`,
        );
      },
    });
    if (!daemon)
      throw new Error('E2E starter returned without daemon identity');
  } catch (error) {
    const cleanup = await cleanupE2ERun({
      root: process.cwd(),
      leasePath: runLease,
      lease,
      stopInstance: () => stopE2EInstance(instance),
    });
    if (cleanup.errors.length) {
      throw new Error(
        `E2E startup failed and cleanup was not proven: ${cleanup.errors.join('; ')}`,
        { cause: error },
      );
    }
    runFailure = error;
  }
  if (runFailure) {
    rmSync(claudeConfigDir, { recursive: true, force: true });
    // The coordinator supplies a unique root only for the full coverage run.
    // Retain each failed bucket's screenshots, traces, and bounded logs before
    // its runner-local cleanup can reclaim the instance directory.
    if (
      (runFailure || cleanupFailure) &&
      process.env.STATION_E2E_EVIDENCE_ROOT
    ) {
      try {
        retainE2EBucketFailureEvidence({
          testResultsRoot,
          evidenceRoot: process.env.STATION_E2E_EVIDENCE_ROOT,
          suite,
        });
      } catch (error) {
        console.error(
          `[e2e] could not retain ${suite} failure evidence: ${error.message}`,
        );
      }
    }
    if (existsSync(serverLog))
      console.error(`[e2e] retained Station startup log: ${serverLog}`);
    throw runFailure;
  }
  const { serverPort, uiPort } = started;

  try {
    await waitForE2EBootstrapReady({
      serverPort,
      uiPort,
      operatorCredential,
    });
    // Ordinary suites exercise an established, ready Station. Persist the
    // explicit Station-engine choice in their throwaway home. Playwright also
    // receives an established-user browser profile below because many product
    // specs intentionally mock /config/app and therefore cannot observe this
    // real-server seed. Dedicated clean-install buckets keep both absent.
    if (!isCleanInstallE2ESuite(suite)) {
      await seedE2EEngineChoice(
        `http://localhost:${serverPort}`,
        operatorCredential,
      );
      await seedE2EFirstRunDecision(
        `http://localhost:${serverPort}`,
        operatorCredential,
      );
      await seedE2EUsageTelemetryDisclosure(
        `http://localhost:${serverPort}`,
        operatorCredential,
      );
    }

    const retries =
      suite === 'pr-smoke' ? PR_BROWSER_SMOKE_CONTRACT.retries : 0;
    const reporter = process.env.PW_REPORTER || 'line';
    const phases =
      suite === 'product'
        ? getProductE2EExecutionPhases(specs)
        : [
            {
              name: suite,
              workers:
                suite === 'pr-smoke' ? PR_BROWSER_SMOKE_CONTRACT.workers : 1,
              specs,
            },
          ];
    await runE2EExecutionPhases(phases, async (phase) => {
      const outputRoot = e2ePhaseOutputRoot(testResultsRoot, suite, phase.name);
      console.log(
        `[e2e] ${suite} phase ${phase.name}: ${phase.specs.length} spec(s), ${phase.workers} worker(s)`,
      );
      await run(
        'npx',
        [
          'playwright',
          'test',
          `--workers=${phase.workers}`,
          `--retries=${retries}`,
          `--reporter=${reporter}`,
          ...(grep ? [`--grep=${grep}`] : []),
          ...phase.specs,
        ],
        {
          env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS_PATH:
              process.env.PLAYWRIGHT_BROWSERS_PATH ?? '0',
            PW_BASE_URL: `http://localhost:${uiPort}`,
            PW_API_BASE_URL: `http://localhost:${serverPort}`,
            STATION_PORT: String(serverPort),
            STATION_E2E_RUNNER: '1',
            STATION_E2E_HOST_CREDENTIAL: operatorCredential,
            STATION_E2E_BROWSER_SESSION_CREDENTIAL: browserSessionCredential,
            // station#4464 arbiter fix: an explicit key (not a conditional
            // spread) so a stray `STATION_E2E_SCREENS` sitting in the
            // runner's own `process.env` (already inherited above via
            // `...process.env`) can never silently partial an unflagged run
            // — including a coordinated full-coverage evidence run.
            // `undefined` here is not stringified: Node's `spawn` env
            // omits any key whose value is `undefined`, so no `--screens`
            // flag means the child never sees the var at all.
            STATION_E2E_SCREENS: screens ? screens.join(',') : undefined,
            ...stationE2EEnv,
            ...establishedUserPlaywrightEnv(suite),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            STATION_E2E_UI_DIR: join(process.cwd(), `dist-ui-${instance}`),
            STATION_E2E_OUTPUT_DIR: outputRoot,
          },
        },
      );
    });
  } catch (error) {
    if (existsSync(serverLog)) {
      const contents = readFileSync(serverLog, 'utf8');
      console.error(
        `\n[e2e] Station server failure${renderE2EStartupFailureTail(
          contents,
          serverLog,
          E2E_STARTUP_CAPTURE_BYTES,
        )}`,
      );
    }
    runFailure = error;
  } finally {
    if (runFailure && process.env.STATION_E2E_EVIDENCE_ROOT)
      try {
        retainE2EBucketFailureEvidence({
          testResultsRoot,
          evidenceRoot: process.env.STATION_E2E_EVIDENCE_ROOT,
          suite,
        });
      } catch (error) {
        console.error(
          `[e2e] could not retain ${suite} failure evidence: ${error.message}`,
        );
      }
    const cleanup = await cleanupE2ERun({
      root: process.cwd(),
      leasePath: runLease,
      lease,
      stopInstance: () => stopE2EInstance(instance),
    });
    if (runFailure) {
      if (existsSync(serverLog))
        console.error(`[e2e] retained Station server log: ${serverLog}`);
    } else {
      rmSync(serverLog, { force: true });
    }
    rmSync(claudeConfigDir, { recursive: true, force: true });
    if (!runFailure && cleanup.errors.length === 0) {
      try {
        removeE2ETestResults(process.cwd(), instance);
      } catch (error) {
        cleanup.errors.push(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (cleanup.errors.length === 0) {
      const pruned = sweepRetainedE2ETestResults(process.cwd());
      if (pruned > 0) {
        console.log(
          `[e2e] pruned ${pruned} retained Playwright result root(s) after settlement`,
        );
      }
    }
    if (cleanup.errors.length > 0) {
      if (process.env.STATION_E2E_EVIDENCE_ROOT)
        try {
          retainE2EBucketFailureEvidence({
            testResultsRoot,
            evidenceRoot: process.env.STATION_E2E_EVIDENCE_ROOT,
            suite,
          });
        } catch (error) {
          console.error(
            `[e2e] could not retain ${suite} cleanup-failure evidence: ${error.message}`,
          );
        }
      cleanupFailure = new Error(
        `E2E cleanup failed; retained lease and outputs: ${cleanup.errors.join('; ')}`,
      );
    }
  }
  if (cleanupFailure) throw cleanupFailure;
  if (runFailure) throw runFailure;
}

// Only run the suite when this file is the process entrypoint. Unit tests
// import `sweepInterruptedBuildDirs` from here; without this guard that import
// launched the whole e2e runner inside Vitest, and its process.exit(1) surfaced
// as an unhandled rejection that failed verify:static with every test passing.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
