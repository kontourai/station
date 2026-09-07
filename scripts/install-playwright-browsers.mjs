#!/usr/bin/env node
/**
 * Bounded, classified Playwright browser install for CI lanes (station#1648).
 *
 * Replaces the inline three-attempt bash loop that wrapped
 * `npx playwright install chromium --with-deps` in ci-extended.yml. That loop
 * was inert against the only failure it ever hit: `--with-deps` apt-installs
 * system libraries as root, the self-hosted fleet's runner account has no
 * passwordless sudo, and so all three attempts failed identically in about
 * half a second each while the warning called the condition retryable.
 *
 * Two rules follow, and both live here rather than in a workflow string so
 * that every call site inherits them:
 *
 * 1. `--with-deps` is refused outright, before anything is spawned. No
 *    argument starting with `-` is accepted at all — this script takes
 *    browser names and nothing else, so no flag can be smuggled through a
 *    call site.
 * 2. A failure is classified before it is retried. A permanent cause fails
 *    fast on the first attempt and names both the cause and the PLACE that
 *    has to change; only a transient or unrecognised cause is retried, and
 *    the log line says which of the two it was rather than asserting
 *    transience it has not derived.
 *
 * The classify-then-retry contract mirrors `play-upload-retry.mjs`, which
 * solves the same problem for Play Store uploads. The bounded-spawn helper
 * below is deliberately a local, smaller copy of that script's: extracting a
 * shared one would edit the release-upload path, which this change has no
 * business touching. If a third caller wants it, extract then.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redactVerificationOutput } from './lib/verification-redaction.mjs';

export const DEFAULT_INSTALL_ATTEMPTS = 3;
/** Matches the `sleep 15` of the retired bash loop. */
export const DEFAULT_INSTALL_RETRY_DELAY_MS = 15_000;
/** Matches the `timeout 360` of the retired bash loop. */
export const DEFAULT_INSTALL_ATTEMPT_TIMEOUT_MS = 360_000;
export const DEFAULT_INSTALL_TERMINATION_GRACE_MS = 5_000;
export const MAX_INSTALL_OUTPUT_BYTES = 128 * 1024;
const MAX_DIAGNOSTIC_CHARACTERS = 4_000;

export const WITH_DEPS_FLAG = '--with-deps';
export const DEFAULT_INSTALL_BROWSERS = Object.freeze(['chromium']);

/**
 * Browser names only: lowercase, digits and hyphens, never a leading `-`.
 * `chromium`, `chrome`, `msedge`, `firefox`, `webkit`, `chromium-headless-shell`.
 */
const BROWSER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export const WITH_DEPS_REFUSAL = [
  `${WITH_DEPS_FLAG} is refused: it apt-installs system libraries as root, and`,
  "the self-hosted fleet's runner account has no passwordless sudo, so the flag",
  'can only fail there (station#1648). Downloading the browser itself needs no',
  'root. If a system library is genuinely missing, install it on the RUNNER',
  'IMAGE of the self-hosted host, once and out of band — that is a host',
  'provisioning change, and no edit to this repository can substitute for it.',
].join(' ');

/**
 * Causes a retry cannot clear. Each names the place that has to change, so a
 * reader is not sent to repair the tree they happen to be standing in.
 *
 * `Switching to root user to install dependencies` is deliberately NOT here:
 * it is also printed on the happy path where sudo does work, so an apt
 * failure that is genuinely transient must not be classified by it.
 */
const PERMANENT_INSTALL_FAILURES = Object.freeze([
  {
    cause: 'the installer needed root and this runner has no passwordless sudo',
    pattern:
      /sudo:\s*a (?:password|terminal) is required|\baskpass\b|\bmust be run as root\b|\broot privileges are required\b/i,
    place:
      'the RUNNER IMAGE of the self-hosted host — install the system libraries there, out of band',
  },
  {
    cause: 'the Playwright CLI is not resolvable on this runner',
    // Scoped to the three shapes that actually mean "the CLI is not there":
    // `npx --no` refusing to fetch, a shell that cannot find it, and a failed
    // spawn of the launcher itself. A bare /ENOENT/ would also match a
    // mid-download filesystem error, and calling that permanent would throw
    // away a retry that could well have cleared it.
    pattern:
      /could not determine executable to run|\bplaywright: (?:command )?not found\b|\bcommand not found\b|\bspawn \S+ ENOENT\b/i,
    place:
      'the calling job — it must run `npm run dependencies:ci` before this step',
  },
  {
    cause: 'the browser cache path is not writable',
    pattern: /\bEACCES\b|\bpermission denied\b|\bEROFS\b/i,
    place:
      "the runner host's filesystem permissions on PLAYWRIGHT_BROWSERS_PATH",
  },
  {
    cause: 'the runner host is out of disk space',
    pattern: /\bENOSPC\b|\bno space left on device\b/i,
    place: "the runner host's disk",
  },
  {
    cause: 'the requested browser or platform is not supported',
    pattern:
      /\bunknown browser\b|\bunsupported (?:browser|platform|operating system)\b/i,
    place: 'the browser argument at the call site',
  },
]);

/** Causes a retry can plausibly clear: CDN and download flakes. */
const TRANSIENT_INSTALL_FAILURES = Object.freeze([
  /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE)\b/,
  /\bsocket hang up\b/i,
  /\b(?:download failed|failed to download|download failure)\b/i,
  /\bsize mismatch\b/i,
  /\btimed out\b/i,
  /\b(?:status(?: code)?|http)\s*[:=]?\s*(?:408|425|429|500|502|503|504)\b/i,
]);

/**
 * @param {string} output
 * @param {{ timedOut?: boolean }} [options]
 * @returns {{ classification: 'permanent' | 'transient' | 'unclassified',
 *            cause?: string, place?: string }}
 */
export function classifyPlaywrightInstallFailure(
  output,
  { timedOut = false } = {},
) {
  const text = String(output);
  // Permanent wins over `timedOut`: when the bound kills an attempt that had
  // already printed a permanent cause, that cause is still the truth.
  for (const { cause, pattern, place } of PERMANENT_INSTALL_FAILURES)
    if (pattern.test(text))
      return { classification: 'permanent', cause, place };
  if (timedOut) return { classification: 'transient' };
  return TRANSIENT_INSTALL_FAILURES.some((pattern) => pattern.test(text))
    ? { classification: 'transient' }
    : // An unrecognised cause is still retried — a wedged download is exactly
      // what the bound and the retry were added for — but it is reported as
      // unrecognised, never as transient, because nothing here derived that.
      { classification: 'unclassified' };
}

export function redactedInstallDiagnostic(output) {
  const redacted = redactVerificationOutput(String(output))
    .replace(/[\r\n]+/g, ' | ')
    .trim();
  if (!redacted) return '<no installer diagnostic>';
  return redacted.length <= MAX_DIAGNOSTIC_CHARACTERS
    ? redacted
    : `${redacted.slice(0, MAX_DIAGNOSTIC_CHARACTERS)}…`;
}

/**
 * Rejects anything that is not a bare browser name, so no call site can pass
 * a flag through this script — `--with-deps` least of all.
 *
 * @param {string[]} browsers
 * @returns {{ ok: true, browsers: string[] } | { ok: false, message: string }}
 */
export function validateInstallBrowsers(browsers) {
  const requested =
    browsers.length > 0 ? browsers : [...DEFAULT_INSTALL_BROWSERS];
  for (const browser of requested) {
    if (browser === WITH_DEPS_FLAG || browser.startsWith(`${WITH_DEPS_FLAG}=`))
      return { ok: false, message: WITH_DEPS_REFUSAL };
    if (browser.startsWith('-'))
      return {
        ok: false,
        message: `refusing the argument '${browser}': this script accepts browser names only, never flags, so that no call site can reintroduce ${WITH_DEPS_FLAG} (station#1648).`,
      };
    if (!BROWSER_NAME_PATTERN.test(browser))
      return {
        ok: false,
        message: `refusing the argument '${browser}': expected a browser name matching ${BROWSER_NAME_PATTERN}.`,
      };
  }
  return { ok: true, browsers: requested };
}

/**
 * @param {{
 *   command: string,
 *   args?: string[],
 *   env?: Record<string, string | undefined>,
 *   attemptTimeoutMs?: number,
 *   terminationGraceMs?: number,
 * }} options
 */
export async function executeInstallCommand({
  command,
  args = /** @type {string[]} */ ([]),
  env = process.env,
  attemptTimeoutMs = DEFAULT_INSTALL_ATTEMPT_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_INSTALL_TERMINATION_GRACE_MS,
}) {
  return await new Promise((resolve) => {
    /** @type {Buffer[]} */
    const retained = [];
    let retainedBytes = 0;
    let sourceBytes = 0;
    let outputOverflow = false;
    let spawnError;
    let timedOut = false;
    let settled = false;
    let escalationTimer;
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const attemptTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGTERM');
      escalationTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, terminationGraceMs);
      escalationTimer.unref?.();
    }, attemptTimeoutMs);
    attemptTimer.unref?.();
    // Retain a bounded PREFIX and keep draining, rather than replacing the
    // capture with a placeholder once the cap is crossed. Discarding it would
    // erase the very text classification reads, so a chatty install that then
    // failed permanently would come back unclassified — and be retried three
    // times, which is the defect this script exists to remove.
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sourceBytes += buffer.length;
        if (retainedBytes >= MAX_INSTALL_OUTPUT_BYTES) {
          outputOverflow = true;
          return;
        }
        const slice = buffer.subarray(
          0,
          MAX_INSTALL_OUTPUT_BYTES - retainedBytes,
        );
        if (slice.length < buffer.length) outputOverflow = true;
        retained.push(Buffer.from(slice));
        retainedBytes += slice.length;
      });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (exitCode, signal) => {
      settled = true;
      clearTimeout(attemptTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      const completion = spawnError
        ? `installer process error: ${spawnError.message}`
        : signal
          ? `installer process terminated by signal ${signal}`
          : '';
      const diagnostic = [
        Buffer.concat(retained).toString('utf8'),
        completion,
        timedOut ? 'wrapper-owned install attempt timeout' : '',
      ]
        .filter(Boolean)
        .join('\n');
      resolve({
        exitCode: timedOut ? 1 : (exitCode ?? 2),
        output: diagnostic,
        timedOut,
        // Reported as its own field rather than appended to `output`: the
        // diagnostic is capped at MAX_DIAGNOSTIC_CHARACTERS from the front,
        // so a note appended to a capture large enough to have been truncated
        // is precisely the text that gets cut. Every source byte is counted
        // even past the cap, so a truncated capture cannot be mistaken for a
        // complete one.
        truncated: outputOverflow,
        retainedBytes,
        sourceBytes,
      });
    });
  });
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * @param {{
 *   browsers?: string[],
 *   command?: string,
 *   env?: Record<string, string | undefined>,
 *   execute?: (input: any) => Promise<any>,
 *   sleep?: (milliseconds: number) => Promise<unknown>,
 *   log?: (line: string) => void,
 *   maxAttempts?: number,
 *   retryDelayMs?: number,
 *   attemptTimeoutMs?: number,
 *   terminationGraceMs?: number,
 * }} [options]
 *   Annotated for the same reason `runPlayUploadWithRetry` is: under
 *   tsconfig.scripts.json's checkJs:false, tsc infers this parameter's type
 *   from the defaulted destructured properties alone, so `browsers = []`
 *   would infer `never[]` and reject every real `string[]` call site.
 */
export async function runPlaywrightInstallWithRetry({
  browsers = /** @type {string[]} */ ([]),
  // `npx --no` resolves the repo-local Playwright CLI and refuses to fetch
  // anything from the registry, so this step cannot execute a package the
  // lockfile did not already admit.
  command = 'npx',
  env = process.env,
  execute = executeInstallCommand,
  sleep = defaultSleep,
  log = (line) => process.stdout.write(`${line}\n`),
  maxAttempts = DEFAULT_INSTALL_ATTEMPTS,
  retryDelayMs = DEFAULT_INSTALL_RETRY_DELAY_MS,
  attemptTimeoutMs = DEFAULT_INSTALL_ATTEMPT_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_INSTALL_TERMINATION_GRACE_MS,
} = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5)
    throw new Error(
      'Playwright install attempts must be an integer from 1 through 5',
    );
  const validated = validateInstallBrowsers(browsers);
  if (!validated.ok) {
    log(`::error::${validated.message}`);
    return { ok: false, attempts: 0, classification: 'refused', exitCode: 1 };
  }
  const args = ['--no', 'playwright', 'install', ...validated.browsers];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    log(
      `::notice::Playwright install attempt ${attempt}/${maxAttempts}: ${validated.browsers.join(', ')}.`,
    );
    const result = await execute({
      command,
      args,
      env,
      attemptTimeoutMs,
      terminationGraceMs,
    });
    if (result.exitCode === 0 && !result.timedOut) {
      log(
        `::notice::Playwright install completed on attempt ${attempt}/${maxAttempts}.`,
      );
      return { ok: true, attempts: attempt, classification: 'success' };
    }

    const { classification, cause, place } = classifyPlaywrightInstallFailure(
      result.output,
      { timedOut: result.timedOut },
    );
    // Placed BEFORE `diagnostic=` in every line below, so the capped
    // diagnostic can never truncate away the fact that it was capped.
    const capture = result.truncated
      ? ` capture=truncated(retained ${result.retainedBytes} of ${result.sourceBytes} bytes)`
      : '';
    const diagnostic = redactedInstallDiagnostic(result.output);
    if (classification === 'permanent') {
      log(
        `::error::Playwright install failed permanently on attempt ${attempt}/${maxAttempts}: ${cause}. Retrying cannot clear this. Fix it in ${place}.${capture} diagnostic=${diagnostic}`,
      );
      return {
        ok: false,
        attempts: attempt,
        classification,
        cause,
        place,
        exitCode: result.exitCode || 1,
      };
    }
    if (attempt === maxAttempts) {
      log(
        `::error::Playwright install failed after ${attempt}/${maxAttempts} attempts; last cause was ${classification === 'transient' ? 'transient' : 'unrecognised'};${capture} diagnostic=${diagnostic}`,
      );
      return {
        ok: false,
        attempts: attempt,
        classification:
          classification === 'transient'
            ? 'transient-exhausted'
            : 'unclassified-exhausted',
        exitCode: result.exitCode || 1,
      };
    }
    log(
      classification === 'transient'
        ? `::warning::Playwright install attempt ${attempt}/${maxAttempts} hit a transient failure; retrying in ${retryDelayMs}ms;${capture} diagnostic=${diagnostic}`
        : `::warning::Playwright install attempt ${attempt}/${maxAttempts} failed for an unrecognised reason; retrying in ${retryDelayMs}ms in case it is transient;${capture} diagnostic=${diagnostic}`,
    );
    await sleep(retryDelayMs);
  }
  throw new Error('unreachable Playwright install retry state');
}

async function main() {
  const result = await runPlaywrightInstallWithRetry({
    browsers: process.argv.slice(2),
  });
  // `process.exitCode`, not `process.exit()`: the `::error::` line above is
  // written to a pipe, and exiting immediately can truncate the one message
  // that says what went wrong and where. The child-process tests assert the
  // real exit status so that this indirection stays proven, not assumed.
  if (!result.ok) process.exitCode = result.exitCode || 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await main();
