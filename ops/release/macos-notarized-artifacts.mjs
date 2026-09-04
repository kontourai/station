import { spawn as defaultSpawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  EMBEDDED_MACHO_SEALING_DEADLINE_MS,
  sealEmbeddedMacosMachOBounded,
} from '../nightly/macos-embedded-signing.mjs';

const MAX_CODESIGN_REQUIREMENT_STREAM_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_RELEASE_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
export const SIGNING_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
// Hosted inventory showed thousands of dependencies but only a handful of
// embedded Mach-O candidates. Inspection commands normally complete quickly;
// this keeps a stuck per-file probe from exhausting the release budget.
export const EMBEDDED_MACHO_COMMAND_TIMEOUT_MS = 30 * 1000;
// Embedded dependencies are individually small. Keep a stalled timestamp
// request from consuming the former aggregate five-minute sealing window for
// every candidate, while still allowing one bounded transport retry.
export const EMBEDDED_TIMESTAMP_SIGNING_TIMEOUT_MS = 90 * 1000;
export const NOTARY_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
// These operations either copy or compress the complete staged application.
// Their duration scales with payload size and host I/O contention, unlike
// probes, validation, signing inspection, and network operations. Keep them
// bounded by one explicit authority so every complete-payload operation gets
// the same release budget without widening the short command default.
export const LARGE_ARTIFACT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
// Retain the named export for downstream release checks while making the
// common large-artifact policy the single timeout authority.
export const DMG_CREATION_COMMAND_TIMEOUT_MS =
  LARGE_ARTIFACT_COMMAND_TIMEOUT_MS;
export const COMMAND_TERMINATION_GRACE_MS = 10 * 1000;
export const MAX_RETRY_ATTEMPTS = 2;
// Standalone callers retain a bounded relative deadline. Hosted release passes
// an absolute epoch recorded at the start of its 120-minute job instead.
export const MACOS_NOTARIZED_ARTIFACTS_DEADLINE_MS = 100 * 60 * 1000;

export function parseReleaseDeadlineEpoch(epoch) {
  if (typeof epoch !== 'string' || !/^[1-9][0-9]{9,10}$/.test(epoch))
    throw new Error(
      'macOS release deadline epoch must be an integer Unix timestamp.',
    );
  const seconds = Number(epoch);
  if (!Number.isSafeInteger(seconds))
    throw new Error(
      'macOS release deadline epoch must be an integer Unix timestamp.',
    );
  return seconds * 1000;
}

// The wrapper deliberately remains the process-group leader after the tool
// receives TERM. A direct tool can exit and emit `close` while a descendant in
// its group ignores TERM; using the direct PID as a later kill target would
// either orphan that descendant or risk addressing a reused process-group ID.
// The still-live wrapper owns its own PGID through the grace period, then
// kills that exact group before it exits and lets the release retry continue.
const POSIX_RELEASE_TOOL_WRAPPER = `
const { spawn, spawnSync } = require('node:child_process');
const [program, encodedArgs, graceRaw] = process.argv.slice(1);
const graceMs = Number.parseInt(graceRaw, 10);
let args;
try {
  args = JSON.parse(encodedArgs);
} catch {
  args = null;
}
if (!Array.isArray(args) || !Number.isSafeInteger(graceMs) || graceMs < 0) {
  process.exitCode = 64;
} else {
  const child = spawn(program, args, { stdio: 'inherit', windowsHide: true });
  let terminating = false;
  let childStatus = 1;
  let drainTimer;
  function groupHasOtherMembers() {
    // Probe from a separate session so the probe process cannot see itself as
    // a member of this release group. If ps cannot prove the group drained,
    // retain the wrapper until the parent's deadline kills the owned group.
    const probe = spawnSync('/bin/ps', ['-o', 'pid=', '-g', String(process.pid)], {
      detached: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (probe.status !== 0) return true;
    return probe.stdout
      .split(/\\s+/)
      .filter(Boolean)
      .some((pid) => Number.parseInt(pid, 10) !== process.pid);
  }
  function finishAfterGroupDrains() {
    if (terminating || groupHasOtherMembers()) return;
    clearInterval(drainTimer);
    process.exitCode = childStatus;
  }
  function finishGroup() {
    // This wrapper is still the group leader, so -process.pid cannot name a
    // reused process group. SIGKILL terminates the wrapper and every survivor.
    process.kill(-process.pid, 'SIGKILL');
  }
  function beginTermination() {
    if (terminating) return;
    terminating = true;
    // Keep this leader alive until it kills its group. An unref'ed timer would
    // let it exit as soon as the direct child closes, recreating the orphan.
    setTimeout(finishGroup, graceMs);
  }
  process.on('SIGTERM', beginTermination);
  process.on('SIGINT', beginTermination);
  child.once('error', () => {
    if (!terminating) {
      childStatus = 127;
      drainTimer = setInterval(finishAfterGroupDrains, 25);
      finishAfterGroupDrains();
    }
  });
  child.once('close', (status) => {
    if (!terminating) {
      childStatus = status ?? 1;
      drainTimer = setInterval(finishAfterGroupDrains, 25);
      finishAfterGroupDrains();
    }
  });
}
`;

export class ReleaseCommandError extends Error {
  constructor({
    phase,
    program,
    status,
    signal,
    timedOut,
    outputTruncated,
    stdout,
    stderr,
  }) {
    const detail = timedOut
      ? `timed out during ${phase}`
      : `failed during ${phase}`;
    super(`${program} ${detail}.`);
    this.name = 'ReleaseCommandError';
    this.phase = phase;
    this.program = program;
    this.status = status;
    this.signal = signal;
    this.timedOut = timedOut;
    this.outputTruncated = outputTruncated;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function loggerMethod(logger, method) {
  return typeof logger?.[method] === 'function'
    ? logger[method].bind(logger)
    : (logger?.log?.bind(logger) ?? (() => {}));
}

function terminateProcessGroup(child, signal) {
  if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  child.kill(signal);
}

function spawnReleaseTool(program, args, terminationGraceMs, spawn) {
  const options = {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };
  if (process.platform === 'win32') return spawn(program, args, options);
  return spawn(
    process.execPath,
    [
      '-e',
      POSIX_RELEASE_TOOL_WRAPPER,
      program,
      JSON.stringify(args),
      String(terminationGraceMs),
    ],
    options,
  );
}

function collectStream(stream, maxBytes, mode = 'capture') {
  if (mode === 'discard') {
    // Keep flowing so a verbose inspection command cannot block on its pipe,
    // but retain no pathname-bearing output. This is intentionally narrow:
    // callers must opt in per stream and stderr remains bounded/captured.
    stream.on('data', () => {});
    return { exceeded: () => false, value: () => '' };
  }
  const chunks = [];
  let bytes = 0;
  let exceeded = false;
  stream.on('data', (chunk) => {
    const value = Buffer.from(chunk);
    if (bytes + value.length > maxBytes) {
      const remaining = Math.max(0, maxBytes - bytes);
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      bytes = maxBytes;
      exceeded = true;
      return;
    }
    chunks.push(value);
    bytes += value.length;
  });
  return {
    value: () => Buffer.concat(chunks).toString('utf8'),
    exceeded: () => exceeded,
  };
}

/**
 * Runs one release tool without exposing its arguments or output. On POSIX,
 * a process-group wrapper retains ownership until TERM's grace period ends;
 * `spawnSync` cannot provide that cleanup or phase-visible progress.
 */
export function runBoundedCommand(
  program,
  args,
  {
    phase,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    terminationGraceMs = COMMAND_TERMINATION_GRACE_MS,
    maxOutputBytes = MAX_COMMAND_OUTPUT_BYTES,
    stdoutMode = 'capture',
    allowNonzero = false,
    logger = console,
    spawn = defaultSpawn,
  } = {},
) {
  if (!phase) throw new Error('A release command phase is required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Release command timeout must be a positive integer.');
  }
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    maxOutputBytes > MAX_RELEASE_COMMAND_OUTPUT_BYTES
  )
    throw new Error(
      'Release command output limit must be a positive safe bound.',
    );
  if (!['capture', 'discard'].includes(stdoutMode))
    throw new Error('Release command stdout mode must be capture or discard.');
  const log = loggerMethod(logger, 'log');
  const error = loggerMethod(logger, 'error');
  log(`[macOS release] ${phase}: ${program} started.`);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnReleaseTool(program, args, terminationGraceMs, spawn);
    } catch {
      reject(new ReleaseCommandError({ phase, program }));
      return;
    }
    const stdout = collectStream(child.stdout, maxOutputBytes, stdoutMode);
    const stderr = collectStream(child.stderr, maxOutputBytes);
    let timedOut = false;
    let settled = false;
    let timeout;
    let killTimer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // POSIX owns escalation in the still-live wrapper. Windows has no PGID
      // wrapper, so never retain a post-close PID kill that could be reused.
      if (!timedOut || process.platform === 'win32') clearTimeout(killTimer);
      callback();
    };
    const fail = ({ status, signal } = {}) => {
      const outputTooLarge = stdout.exceeded() || stderr.exceeded();
      const commandError = new ReleaseCommandError({
        phase,
        program,
        status,
        signal,
        timedOut,
        outputTruncated: outputTooLarge,
        stdout: stdout.value(),
        stderr: stderr.value(),
      });
      finish(() => reject(commandError));
    };
    timeout = setTimeout(() => {
      timedOut = true;
      error(
        `[macOS release] ${phase}: ${program} timed out after ${timeoutMs}ms; terminating process group.`,
      );
      try {
        terminateProcessGroup(child, 'SIGTERM');
      } catch {
        // The close event provides the bounded, phase-labelled failure.
      }
      if (process.platform === 'win32') {
        // Windows has no POSIX PGID wrapper; this only bounds a still-live
        // direct child and is cancelled as soon as that child closes.
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // The owned child may have exited between TERM and KILL.
          }
        }, terminationGraceMs);
      }
    }, timeoutMs);
    child.once('error', () => fail());
    child.once('close', (status, signal) => {
      if (
        !timedOut &&
        !stdout.exceeded() &&
        !stderr.exceeded() &&
        (status === 0 || allowNonzero)
      ) {
        finish(() => {
          log(`[macOS release] ${phase}: ${program} completed.`);
          resolve({ status, stdout: stdout.value(), stderr: stderr.value() });
        });
        return;
      }
      fail({ status, signal });
    });
  });
}

export function isRetryableTimestampOrNotaryTransportFailure(error, args = []) {
  if (!(error instanceof ReleaseCommandError)) return false;
  const diagnostics = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  const transportFailure =
    /\b(?:timed?\s*out|timeout|network|connection|transport|temporar(?:y|ily)|service unavailable|try again|HTTP\s*5\d\d|[ []5(?:02|03|04)[\].,:; ]?)/i.test(
      diagnostics,
    );
  if (
    error.program === 'codesign' &&
    args.includes('--timestamp') &&
    (error.timedOut || (transportFailure && /timestamp/i.test(diagnostics)))
  ) {
    return true;
  }
  return (
    error.program === 'xcrun' &&
    args[0] === 'notarytool' &&
    args[1] === 'submit' &&
    (error.timedOut || transportFailure)
  );
}

export async function retryRetryableTransportFailure(
  phase,
  args,
  operation,
  logger,
) {
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt === MAX_RETRY_ATTEMPTS ||
        !isRetryableTimestampOrNotaryTransportFailure(error, args)
      ) {
        throw error;
      }
      loggerMethod(
        logger,
        'warn',
      )(
        `[macOS release] ${phase}: retrying once after a retryable timestamp/notary transport failure.`,
      );
    }
  }
  throw new Error('Release retry loop exhausted unexpectedly.');
}

function captured(value) {
  return typeof value === 'string'
    ? { status: 0, stdout: value, stderr: '' }
    : value;
}
function need(value, name) {
  if (!value) throw new Error(`Expected ${name}.`);
  return value;
}
const DEVELOPER_ID_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.6';
const DEVELOPER_ID_APPLICATION_OID = '1.2.840.113635.100.6.1.13';
const KONTOUR_TEAM_ID = 'U7KHF2QAC4';

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function existsClause(certificateSelector) {
  return new RegExp(
    `\\b${certificateSelector}\\s*(?:/\\*\\s*)?exists\\b(?:\\s*\\*/)?`,
  );
}

export function admitMacosAppBundle(app, fs, path = { resolve }) {
  if (typeof app !== 'string' || app.length === 0 || /[\0\r\n]/.test(app)) {
    throw new Error('Expected an unambiguous staged application bundle path.');
  }
  const requested = path.resolve(app);
  if (!fs.existsSync(requested)) throw new Error('Staged app does not exist.');
  const metadata = fs.lstatSync(requested);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !basename(requested).endsWith('.app')
  ) {
    throw new Error('Expected a non-symlink staged application bundle.');
  }
  const canonical = fs.realpathSync(requested);
  if (canonical !== requested || !basename(canonical).endsWith('.app')) {
    throw new Error(
      'Staged app path must not traverse a symlink or escape its requested bundle.',
    );
  }
  return canonical;
}

/**
 * `codesign -d -r-` has emitted both of these complete, line-oriented forms:
 *
 *   designated => <requirement>
 *   Designated Requirement=<requirement>
 *
 * Treat diagnostics as untrusted input. A release must observe exactly one
 * complete form across the separately-captured output streams, rather than
 * selecting a convenient line from mixed output.
 */
export function outerAppDesignatedRequirement(output) {
  const streams =
    typeof output === 'string'
      ? [{ name: 'output', value: output }]
      : [
          { name: 'stdout', value: output?.stdout },
          { name: 'stderr', value: output?.stderr },
        ];
  const records = [];
  let malformed = false;
  let diagnostics = 0;
  for (const { name, value } of streams) {
    if (typeof value !== 'string')
      throw new Error(`Outer app designated requirement ${name} must be text.`);
    if (
      Buffer.byteLength(value, 'utf8') > MAX_CODESIGN_REQUIREMENT_STREAM_BYTES
    )
      throw new Error(
        `Outer app designated requirement ${name} exceeds the capture limit.`,
      );
    for (const line of value.split(/\r?\n/)) {
      if (line === '') continue;
      const canonical = line.match(
        /^\s*designated =>\s+(identifier\b.*\S)\s*$/,
      );
      const legacy = line.match(
        /^\s*Designated Requirement\s*=\s*(identifier\b.*\S)\s*$/,
      );
      if (canonical || legacy) records.push((canonical ?? legacy)[1]);
      else if (/^Executable=.+\S$/.test(line)) diagnostics += 1;
      else malformed = true;
    }
  }
  if (malformed || diagnostics > 1 || records.length !== 1) {
    throw new Error(
      'Outer app designated requirement must be reported exactly once in one supported codesign form.',
    );
  }
  return records[0];
}

export function assertOuterAppCertificateBackedRequirement(output, bundleId) {
  return assertKontourDeveloperIdRequirement(output, bundleId);
}

/**
 * Require the signed object's designated requirement to bind it to Kontour's
 * Developer ID chain. App bundles additionally bind the identifier to their
 * release-channel bundle id; disk images have a distinct codesign identifier
 * and therefore intentionally omit that app-specific constraint.
 */
export function assertKontourDeveloperIdRequirement(output, bundleId) {
  const requirement = outerAppDesignatedRequirement(output);
  const requiredClauses = [
    /\banchor\s+apple\s+generic\b/,
    existsClause(
      `certificate\\s+1\\s*\\[\\s*field\\.${escapedRegExp(DEVELOPER_ID_INTERMEDIATE_OID)}\\s*\\]`,
    ),
    existsClause(
      `certificate\\s+leaf\\s*\\[\\s*field\\.${escapedRegExp(DEVELOPER_ID_APPLICATION_OID)}\\s*\\]`,
    ),
    new RegExp(
      `\\bcertificate\\s+leaf\\s*\\[\\s*subject\\.OU\\s*\\]\\s*=\\s*"?${KONTOUR_TEAM_ID}"?(?=\\s|$)`,
    ),
  ];
  if (bundleId !== undefined)
    requiredClauses.unshift(
      new RegExp(`\\bidentifier\\s+"${escapedRegExp(bundleId)}"(?=\\s|$)`),
    );
  const combinedOutput =
    typeof output === 'string'
      ? output
      : `${output?.stdout}\n${output?.stderr}`;
  if (
    /\bcdhash\b/i.test(combinedOutput) ||
    /\b(?:or|not)\b/i.test(requirement) ||
    requiredClauses.some((clause) => !clause.test(requirement))
  ) {
    throw new Error(
      'Outer app designated requirement must be certificate-backed for the expected bundle identifier and Kontour Developer ID team.',
    );
  }
  return requirement;
}

export function assertKontourDeveloperIdSigningMetadata(metadata) {
  if (typeof metadata !== 'string')
    throw new Error('Signing metadata must be text.');
  for (const field of [
    'Authority=Developer ID Application: Kontour AI LLC (U7KHF2QAC4)',
    'TeamIdentifier=U7KHF2QAC4',
    'Timestamp=',
  ])
    if (!metadata.includes(field))
      throw new Error(`Signing metadata lacks ${field}.`);
}

export function assertAcceptedNotaryReceipt(stdout, file) {
  let receipt;
  try {
    receipt = JSON.parse(stdout);
  } catch {
    throw new Error('notarytool did not return JSON.');
  }
  if (receipt.status !== 'Accepted') {
    throw new Error(`notarytool rejected ${basename(file)}.`);
  }
}

async function submit(command, file, key, keyId, issuer, logger) {
  const args = [
    'notarytool',
    'submit',
    file,
    '--key',
    key,
    '--key-id',
    keyId,
    '--issuer',
    issuer,
    '--wait',
    '--output-format',
    'json',
  ];
  const out = captured(
    await retryRetryableTransportFailure(
      `notarize ${basename(file)}`,
      args,
      () =>
        command(
          `notarize ${basename(file)}`,
          'xcrun',
          args,
          NOTARY_COMMAND_TIMEOUT_MS,
        ),
      logger,
    ),
  );
  assertAcceptedNotaryReceipt(out.stdout, file);
}

export async function createMacosNotarizedArtifacts(options, injected = {}) {
  const logger = injected.logger ?? console;
  const now = injected.now ?? Date.now;
  const relativeDeadlineMs =
    injected.deadlineMs ?? MACOS_NOTARIZED_ARTIFACTS_DEADLINE_MS;
  if (
    options.deadlineEpoch === undefined &&
    (!Number.isSafeInteger(relativeDeadlineMs) || relativeDeadlineMs <= 0)
  )
    throw new Error(
      'macOS notarized artifact deadline must be a positive bound.',
    );
  const deadlineAt =
    options.deadlineEpoch === undefined
      ? now() + relativeDeadlineMs
      : parseReleaseDeadlineEpoch(options.deadlineEpoch);
  if (
    !Number.isSafeInteger(deadlineAt) ||
    deadlineAt - now() <= COMMAND_TERMINATION_GRACE_MS
  )
    throw new Error(
      'macOS notarized artifact creation lacks cleanup grace before its deadline.',
    );
  const run =
    injected.run ??
    ((program, args, commandOptions) =>
      runBoundedCommand(program, args, {
        ...commandOptions,
        logger,
        spawn: injected.spawn ?? defaultSpawn,
      }));
  const command = async (
    phase,
    program,
    args,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    commandOptions = {},
  ) => {
    const remainingMs = deadlineAt - now();
    if (
      !Number.isFinite(remainingMs) ||
      remainingMs <= COMMAND_TERMINATION_GRACE_MS
    )
      throw new Error(
        'macOS notarized artifact creation lacks cleanup grace before its deadline.',
      );
    return captured(
      await run(program, args, {
        ...commandOptions,
        phase,
        timeoutMs: Math.min(
          timeoutMs,
          remainingMs - COMMAND_TERMINATION_GRACE_MS,
        ),
      }),
    );
  };
  const fs = injected.fs ?? {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    realpathSync,
    rmSync,
  };
  const app = admitMacosAppBundle(need(options.app, 'app'), fs, injected.path);
  if (options.dmgOnly !== undefined && options.dmgOnly !== true)
    throw new Error('DMG-only mode must be explicitly enabled.');
  const dmgOnly = options.dmgOnly === true;
  if (
    options.overlapNotarization !== undefined &&
    options.overlapNotarization !== true
  )
    throw new Error('Overlapped notarization must be explicitly enabled.');
  const overlapNotarization = options.overlapNotarization === true;
  const identity = need(options.identity, 'identity');
  const key = need(options.notaryKey, 'notaryKey');
  const keyId = need(options.notaryKeyId, 'notaryKeyId');
  const issuer = need(options.notaryIssuer, 'notaryIssuer');
  const assets = need(options.assetsDir, 'assetsDir');
  const tag = need(options.releaseTag, 'releaseTag');
  const arch = need(options.architecture, 'architecture');
  const bundleId = need(options.bundleId, 'bundleId');
  if (!['aarch64', 'x86_64'].includes(arch))
    throw new Error('Expected a canonical macOS architecture.');
  if (!fs.existsSync(key))
    throw new Error('Notary API key file does not exist.');
  const appName = basename(app);
  fs.mkdirSync(assets, { recursive: true });
  const root = fs.mkdtempSync(join(tmpdir(), 'station-macos-release-'));
  const mount = join(root, 'mounted');
  const dmgRoot = join(root, 'dmg-root');
  const zip = join(root, 'notarization-input.zip');
  const prefix = `station-${tag}-macos-${arch}`;
  const dmg = join(assets, `${prefix}.dmg`);
  const updater = join(assets, `${prefix}.app.tar.gz`);
  let detachNeeded = false;
  const pendingNotarizations = [];
  try {
    const embeddedCommand = (
      phase,
      program,
      args,
      { timeoutMs, ...commandOptions } = {},
    ) =>
      command(
        phase,
        program,
        args,
        Math.min(
          timeoutMs ?? EMBEDDED_MACHO_COMMAND_TIMEOUT_MS,
          EMBEDDED_MACHO_COMMAND_TIMEOUT_MS,
        ),
        commandOptions,
      );
    const embeddedSign = (
      phase,
      program,
      args,
      { timeoutMs, ...commandOptions } = {},
    ) =>
      command(
        phase,
        program,
        args,
        Math.min(
          timeoutMs ?? EMBEDDED_TIMESTAMP_SIGNING_TIMEOUT_MS,
          EMBEDDED_TIMESTAMP_SIGNING_TIMEOUT_MS,
        ),
        commandOptions,
      );
    if (!dmgOnly) {
      const retryEmbeddedSign = (phase, args, operation) =>
        retryRetryableTransportFailure(phase, args, operation, logger);
      await sealEmbeddedMacosMachOBounded(app, identity, {
        ...injected.embeddedMacos,
        command: embeddedCommand,
        deadlineMs: Math.min(
          EMBEDDED_MACHO_SEALING_DEADLINE_MS,
          deadlineAt - now() - COMMAND_TERMINATION_GRACE_MS,
        ),
        retrySign: retryEmbeddedSign,
        sign: embeddedSign,
      });
      const outerSigningArgs = [
        '--force',
        '--sign',
        identity,
        '--options',
        'runtime',
        '--timestamp',
        app,
      ];
      await retryRetryableTransportFailure(
        'outer app signing',
        outerSigningArgs,
        () =>
          command(
            'outer app signing',
            'codesign',
            outerSigningArgs,
            SIGNING_COMMAND_TIMEOUT_MS,
          ),
        logger,
      );
    }
    await command(
      'outer app signature verification',
      'codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', app],
      SIGNING_COMMAND_TIMEOUT_MS,
    );
    const actualBundleId = (
      await command('outer app bundle identity', '/usr/libexec/PlistBuddy', [
        '-c',
        'Print :CFBundleIdentifier',
        join(app, 'Contents/Info.plist'),
      ])
    ).stdout.trim();
    if (actualBundleId !== bundleId)
      throw new Error(
        'Staged app bundle identifier does not match the release channel.',
      );
    const metadata = (
      await command(
        'outer app signing metadata',
        'codesign',
        ['-dvv', app],
        SIGNING_COMMAND_TIMEOUT_MS,
      )
    ).stderr;
    assertKontourDeveloperIdSigningMetadata(metadata);
    if (!metadata.includes('runtime'))
      throw new Error('Outer app signing metadata lacks runtime.');
    const dr = await command(
      'outer app designated requirement',
      'codesign',
      ['-d', '-r-', app],
      SIGNING_COMMAND_TIMEOUT_MS,
    );
    if (dr.status !== 0)
      throw new Error(
        `codesign designated requirement query failed with status ${dr.status}.`,
      );
    assertOuterAppCertificateBackedRequirement(dr, bundleId);
    const entitlementOutput = await command(
      'outer app entitlements',
      'codesign',
      ['-d', '--entitlements', '-', '--xml', app],
      SIGNING_COMMAND_TIMEOUT_MS,
    );
    const entitlementDiagnostic = `Executable=${join(app, 'Contents', 'MacOS', 'station')}`;
    if (
      entitlementOutput.status !== 0 ||
      entitlementOutput.stdout !== '' ||
      /[\r\n]/.test(app) ||
      (entitlementOutput.stderr !== entitlementDiagnostic &&
        entitlementOutput.stderr !== `${entitlementDiagnostic}\n`)
    )
      throw new Error('Outer app has unexpected entitlements.');
    const validateAndAssessApp = async () => {
      await command('application staple validation', 'xcrun', [
        'stapler',
        'validate',
        app,
      ]);
      await command('application Gatekeeper assessment', 'spctl', [
        '--assess',
        '--type',
        'execute',
        '--verbose=4',
        app,
      ]);
    };
    const stapleAndAdmitApp = async () => {
      await command('application stapling', 'xcrun', [
        'stapler',
        'staple',
        app,
      ]);
      await validateAndAssessApp();
    };
    // Each `notarytool submit --wait` costs the release five to six minutes,
    // and the two submissions are independent of one another. By default the
    // application submission is joined and stapled here, before the disk image
    // is staged, so the image encloses an application carrying its own local
    // ticket and an offline user who copies it out of the image is unaffected.
    // `overlapNotarization` trades that away for wall-clock time: the
    // application submission stays in flight while the disk image is staged,
    // created, signed, and admitted, so the two service waits overlap, and the
    // image then encloses a signed but not-yet-stapled application whose own
    // ticket Gatekeeper resolves online. Only the Nightly channel accepts that
    // trade; nothing is stapled until every submission is accepted either way.
    let pendingAppNotarization;
    if (dmgOnly) {
      // A DMG-only run receives an application another run already notarized
      // and stapled; its ticket must be present before this run images it.
      await validateAndAssessApp();
    } else {
      await command(
        'application notarization archive',
        'ditto',
        ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip],
        LARGE_ARTIFACT_COMMAND_TIMEOUT_MS,
      );
      const appNotarization = submit(command, zip, key, keyId, issuer, logger);
      pendingNotarizations.push(appNotarization);
      // The join below is the only consumer of this outcome. Retain a no-op
      // handler so a rejection arriving while the disk image is still being
      // prepared cannot surface as an unhandled rejection.
      appNotarization.catch(() => {});
      if (overlapNotarization) pendingAppNotarization = appNotarization;
      else {
        await appNotarization;
        await stapleAndAdmitApp();
      }
    }
    fs.mkdirSync(dmgRoot, { recursive: true });
    await command(
      'DMG staging',
      'ditto',
      [app, join(dmgRoot, appName)],
      LARGE_ARTIFACT_COMMAND_TIMEOUT_MS,
    );
    await command(
      'DMG creation',
      'hdiutil',
      [
        'create',
        '-volname',
        'Station',
        '-srcfolder',
        dmgRoot,
        '-ov',
        '-format',
        'UDZO',
        dmg,
      ],
      LARGE_ARTIFACT_COMMAND_TIMEOUT_MS,
    );
    const dmgSigningArgs = ['--force', '--sign', identity, '--timestamp', dmg];
    await retryRetryableTransportFailure(
      'DMG signing',
      dmgSigningArgs,
      () =>
        command(
          'DMG signing',
          'codesign',
          dmgSigningArgs,
          SIGNING_COMMAND_TIMEOUT_MS,
        ),
      logger,
    );
    await command(
      'DMG signature verification',
      'codesign',
      ['--verify', '--strict', '--verbose=2', dmg],
      SIGNING_COMMAND_TIMEOUT_MS,
    );
    const dmgMetadata = (
      await command(
        'DMG signing metadata',
        'codesign',
        ['-dvv', dmg],
        SIGNING_COMMAND_TIMEOUT_MS,
      )
    ).stderr;
    assertKontourDeveloperIdSigningMetadata(dmgMetadata);
    const dmgRequirement = await command(
      'DMG designated requirement',
      'codesign',
      ['-d', '-r-', dmg],
      SIGNING_COMMAND_TIMEOUT_MS,
    );
    if (dmgRequirement.status !== 0)
      throw new Error(
        `DMG designated requirement query failed with status ${dmgRequirement.status}.`,
      );
    assertKontourDeveloperIdRequirement(dmgRequirement);
    const dmgNotarization = submit(command, dmg, key, keyId, issuer, logger);
    pendingNotarizations.push(dmgNotarization);
    dmgNotarization.catch(() => {});
    // Every outstanding submission must be accepted. Settling them all first
    // keeps a rejection of either one terminal without abandoning the other
    // mid-upload, and the first rejection is rethrown unchanged.
    for (const outcome of await Promise.allSettled(
      pendingAppNotarization === undefined
        ? [dmgNotarization]
        : [pendingAppNotarization, dmgNotarization],
    ))
      if (outcome.status === 'rejected') throw outcome.reason;
    // Only an overlapped run still owes the application its staple; the
    // default already joined and stapled it before the disk image was staged.
    if (pendingAppNotarization !== undefined) await stapleAndAdmitApp();
    await command('DMG stapling', 'xcrun', ['stapler', 'staple', dmg]);
    await command('DMG staple validation', 'xcrun', [
      'stapler',
      'validate',
      dmg,
    ]);
    await command('DMG Gatekeeper assessment', 'spctl', [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      dmg,
    ]);
    fs.mkdirSync(mount, { recursive: true });
    detachNeeded = true;
    await command('DMG mount', 'hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mount,
      dmg,
    ]);
    const files = fs.readdirSync(mount);
    if (files.length !== 1 || files[0] !== appName)
      throw new Error(
        'DMG must contain exactly the staged application bundle.',
      );
    const mounted = join(mount, appName);
    await command(
      'mounted app signature verification',
      'codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', mounted],
      SIGNING_COMMAND_TIMEOUT_MS,
    );
    if (
      (
        await command(
          'mounted app bundle identity',
          '/usr/libexec/PlistBuddy',
          [
            '-c',
            'Print :CFBundleIdentifier',
            join(mounted, 'Contents/Info.plist'),
          ],
        )
      ).stdout.trim() !== bundleId
    )
      throw new Error(
        'Mounted app bundle identifier does not match the release channel.',
      );
    await command('mounted app Gatekeeper assessment', 'spctl', [
      '--assess',
      '--type',
      'execute',
      '--verbose=4',
      mounted,
    ]);
    await command('DMG detach', 'hdiutil', ['detach', mount]);
    detachNeeded = false;
    await command(
      'updater archive derivation',
      'tar',
      ['-C', join(app, '..'), '-czf', updater, '--', appName],
      LARGE_ARTIFACT_COMMAND_TIMEOUT_MS,
    );
    await command(
      'updater archive validation',
      'tar',
      ['-tzf', updater],
      DEFAULT_COMMAND_TIMEOUT_MS,
      { stdoutMode: 'discard' },
    );
    await command('updater signature derivation', 'npx', [
      'tauri',
      'signer',
      'sign',
      updater,
    ]);
    if (!fs.existsSync(`${updater}.sig`))
      throw new Error('Tauri updater signer did not produce a signature.');
    return { dmg, updater, signature: `${updater}.sig` };
  } finally {
    if (detachNeeded) {
      try {
        await command('DMG detach cleanup', 'hdiutil', ['detach', mount]);
      } catch {
        // Preserve the primary failure; cleanup is only best-effort here.
      }
    }
    // A failure between starting a submission and the join above would leave
    // that submission uploading a scratch archive this cleanup is about to
    // delete. Both promises already carry handlers, so settling them only
    // bounds the surviving child processes; each remains bounded by the
    // notary command timeout and the release deadline.
    await Promise.allSettled(pendingNotarizations);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function parseMacosNotarizedArtifactsCli(argv) {
  const valueFlags = new Set([
    '--app',
    '--identity',
    '--notary-key',
    '--notary-key-id',
    '--notary-issuer',
    '--assets-dir',
    '--release-tag',
    '--architecture',
    '--bundle-id',
    '--deadline-epoch',
  ]);
  // Bare switches take no value: a following token is read as the next flag
  // name, so `--dmg-only true` still fails the unique --name value check.
  const booleanFlags = new Set(['--dmg-only', '--overlap-notarization']);
  const raw = {};
  for (let index = 0; index < argv.length; ) {
    const name = argv[index];
    if (booleanFlags.has(name)) {
      if (raw[name]) throw new Error('Expected unique --name value arguments.');
      raw[name] = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (
      !valueFlags.has(name) ||
      typeof value !== 'string' ||
      value.length === 0 ||
      value.startsWith('-') ||
      raw[name]
    )
      throw new Error('Expected unique --name value arguments.');
    raw[name] = value;
    index += 2;
  }
  return {
    app: raw['--app'],
    identity: raw['--identity'],
    notaryKey: raw['--notary-key'],
    notaryKeyId: raw['--notary-key-id'],
    notaryIssuer: raw['--notary-issuer'],
    assetsDir: raw['--assets-dir'],
    releaseTag: raw['--release-tag'],
    architecture: raw['--architecture'],
    bundleId: raw['--bundle-id'],
    deadlineEpoch: raw['--deadline-epoch'],
    dmgOnly: raw['--dmg-only'] === true ? true : undefined,
    overlapNotarization:
      raw['--overlap-notarization'] === true ? true : undefined,
  };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  createMacosNotarizedArtifacts(
    parseMacosNotarizedArtifactsCli(process.argv.slice(2)),
  ).catch((error) => {
    console.error(`::error::macOS release failed: ${error.message}`);
    process.exitCode = 1;
  });
}
