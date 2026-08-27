#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redactVerificationOutput } from './lib/verification-redaction.mjs';

export const DEFAULT_PLAY_UPLOAD_ATTEMPTS = 3;
export const DEFAULT_PLAY_UPLOAD_BASE_DELAY_MS = 10_000;
export const DEFAULT_PLAY_UPLOAD_MAX_DELAY_MS = 30_000;
export const DEFAULT_PLAY_UPLOAD_ATTEMPT_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_PLAY_UPLOAD_TERMINATION_GRACE_MS = 5_000;
export const MAX_PLAY_UPLOAD_OUTPUT_BYTES = 128 * 1024;
const MAX_DIAGNOSTIC_CHARACTERS = 4_000;

const PERMANENT_FAILURES = [
  /\b(?:http|status(?: code)?)\s*[:=]?\s*(?:400|401|403|404|409|422)\b/i,
  /\b(?:unauthori[sz]ed|forbidden|permission denied|insufficient permissions?|access denied)\b/i,
  /\binvalid[_ -]?grant\b/i,
  /\bservice account\b.*\b(?:disabled|invalid|not found)\b/i,
  /\bvalidation failed\b/i,
  /\bbad request\b/i,
  /\bpolicy\b/i,
  /\bversion code\b.*\b(?:already|lower|used|upgrade)\b/i,
  /\bdoes not allow any existing users to upgrade\b/i,
  /\binvalid\b.*\b(?:aab|apk|bundle|package|release|request|track)\b/i,
];

const TRANSIENT_FAILURES = [
  /\bthe service is currently unavailable\.?\b/i,
  /\b(?:backendError|rateLimitExceeded)\b/i,
  /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/i,
  /\bsocket hang up\b/i,
  /\b(?:http|status(?: code)?)\s*[:=]?\s*(?:429|500|502|503|504)\b/i,
  /\bcode\s*[:=]\s*(?:429|500|502|503|504)\b/i,
];

export function classifyPlayUploadFailure(output, { timedOut = false } = {}) {
  const text = String(output);
  if (PERMANENT_FAILURES.some((pattern) => pattern.test(text)))
    return 'permanent';
  if (timedOut) return 'transient';
  return TRANSIENT_FAILURES.some((pattern) => pattern.test(text))
    ? 'transient'
    : 'permanent';
}

export function redactedPlayUploadDiagnostic(output) {
  const redacted = redactVerificationOutput(String(output))
    .replace(/[\r\n]+/g, ' | ')
    .trim();
  if (!redacted) return '<no provider diagnostic>';
  return redacted.length <= MAX_DIAGNOSTIC_CHARACTERS
    ? redacted
    : `${redacted.slice(0, MAX_DIAGNOSTIC_CHARACTERS)}…`;
}

function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : 143;
}

export async function executePlayUploadCommand({
  command,
  args,
  env,
  attemptTimeoutMs = DEFAULT_PLAY_UPLOAD_ATTEMPT_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_PLAY_UPLOAD_TERMINATION_GRACE_MS,
  signalSource = process,
}) {
  return await new Promise((resolve) => {
    let output = '';
    let outputOverflow = false;
    let spawnError;
    let timedOut = false;
    let interruptedSignal;
    let escalated = false;
    let settled = false;
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let escalationTimer;
    const requestTermination = (signal) => {
      if (settled) return;
      child.kill(signal);
      if (escalationTimer) return;
      escalationTimer = setTimeout(() => {
        if (settled) return;
        escalated = true;
        child.kill('SIGKILL');
      }, terminationGraceMs);
      escalationTimer.unref?.();
    };
    const onSigint = () => {
      interruptedSignal = 'SIGINT';
      requestTermination('SIGINT');
    };
    const onSigterm = () => {
      interruptedSignal = 'SIGTERM';
      requestTermination('SIGTERM');
    };
    signalSource.on('SIGINT', onSigint);
    signalSource.on('SIGTERM', onSigterm);
    const attemptTimer = setTimeout(() => {
      timedOut = true;
      requestTermination('SIGTERM');
    }, attemptTimeoutMs);
    attemptTimer.unref?.();
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk) => {
        if (outputOverflow) return;
        const next = Buffer.concat([Buffer.from(output), Buffer.from(chunk)]);
        if (next.byteLength > MAX_PLAY_UPLOAD_OUTPUT_BYTES) {
          output = '[provider output exceeded capture limit; refusing retry]';
          outputOverflow = true;
        } else output = next.toString('utf8');
      });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (exitCode, signal) => {
      settled = true;
      clearTimeout(attemptTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      signalSource.off('SIGINT', onSigint);
      signalSource.off('SIGTERM', onSigterm);
      const completionDiagnostic = spawnError
        ? `upload process error: ${spawnError.message}`
        : signal
          ? `upload process terminated by signal ${signal}`
          : '';
      const diagnostic = [output, completionDiagnostic]
        .filter(Boolean)
        .join('\n');
      const wrapperDiagnostic = timedOut
        ? `${diagnostic}\nwrapper-owned Play upload attempt timeout`
        : diagnostic;
      resolve({
        exitCode: interruptedSignal
          ? signalExitCode(interruptedSignal)
          : timedOut
            ? 1
            : (exitCode ?? 2),
        output: wrapperDiagnostic,
        timedOut,
        interruptedSignal,
        escalated,
      });
    });
  });
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(attempt, { baseDelayMs, maxDelayMs, random }) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitterCeiling = Math.min(1_000, Math.floor(exponential / 4));
  return exponential + Math.floor(random() * (jitterCeiling + 1));
}

/**
 * @param {{
 *   command: string,
 *   args?: string[],
 *   env?: Record<string, string | undefined>,
 *   execute?: (input: any) => Promise<any>,
 *   sleep?: (milliseconds: number) => Promise<unknown>,
 *   random?: () => number,
 *   log?: (line: string) => void,
 *   maxAttempts?: number,
 *   baseDelayMs?: number,
 *   maxDelayMs?: number,
 *   attemptTimeoutMs?: number,
 *   terminationGraceMs?: number,
 * }} options
 *   `command` is required at runtime (the function throws without it) even
 *   though the destructuring gives it no default. This annotation exists
 *   because tsconfig.scripts.json runs with checkJs:false, where tsc
 *   otherwise infers the parameter type from defaulted destructured
 *   properties only: `command` silently vanishes from the inferred shape,
 *   and `args = []` infers as `never[]`, so a correct .ts call site passing
 *   a command and real args fails TS2322/TS2353 (same class as
 *   `submitVerification`'s annotation in verification-submission.mjs).
 */
export async function runPlayUploadWithRetry({
  command,
  // Annotated because an empty-array default infers `never[]` under checkJs,
  // which makes every real `string[]` argument a type error at the call site.
  args = /** @type {string[]} */ ([]),
  env = process.env,
  execute = executePlayUploadCommand,
  sleep = defaultSleep,
  random = Math.random,
  log = (line) => process.stdout.write(`${line}\n`),
  maxAttempts = DEFAULT_PLAY_UPLOAD_ATTEMPTS,
  baseDelayMs = DEFAULT_PLAY_UPLOAD_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_PLAY_UPLOAD_MAX_DELAY_MS,
  attemptTimeoutMs = DEFAULT_PLAY_UPLOAD_ATTEMPT_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_PLAY_UPLOAD_TERMINATION_GRACE_MS,
}) {
  if (!command) throw new Error('Play upload command is required');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5)
    throw new Error('Play upload attempts must be an integer from 1 through 5');
  if (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 1)
    throw new Error('Play upload attempt timeout must be a positive integer');
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1)
    throw new Error('Play upload termination grace must be a positive integer');

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    log(`::notice::Play upload attempt ${attempt}/${maxAttempts}.`);
    const result = await execute({
      command,
      args,
      env,
      attemptTimeoutMs,
      terminationGraceMs,
    });
    if (result.interruptedSignal) {
      log(
        `::error::Play upload interrupted by ${result.interruptedSignal}; child teardown completed.`,
      );
      return {
        ok: false,
        attempts: attempt,
        classification: 'interrupted',
        exitCode: result.exitCode,
      };
    }
    if (result.exitCode === 0 && !result.timedOut) {
      log(
        `::notice::Play upload committed on attempt ${attempt}/${maxAttempts}.`,
      );
      return { ok: true, attempts: attempt, classification: 'success' };
    }

    const classification = classifyPlayUploadFailure(result.output, {
      timedOut: result.timedOut,
    });
    const diagnostic = redactedPlayUploadDiagnostic(result.output);
    if (classification === 'permanent') {
      log(
        `::error::Play upload failed on attempt ${attempt}/${maxAttempts}; classification=permanent; diagnostic=${diagnostic}`,
      );
      return {
        ok: false,
        attempts: attempt,
        classification,
        exitCode: result.exitCode,
      };
    }
    if (attempt === maxAttempts) {
      log(
        `::error::Play upload failed after ${attempt}/${maxAttempts} attempts; classification=transient-exhausted; diagnostic=${diagnostic}`,
      );
      return {
        ok: false,
        attempts: attempt,
        classification: 'transient-exhausted',
        exitCode: result.exitCode,
      };
    }

    const delayMs = retryDelay(attempt, {
      baseDelayMs,
      maxDelayMs,
      random,
    });
    log(
      `::warning::Play upload transient failure on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms; diagnostic=${diagnostic}`,
    );
    await sleep(delayMs);
  }
  throw new Error('unreachable Play upload retry state');
}

async function main() {
  const actionPath = process.env.PLAY_UPLOAD_ACTION_PATH;
  if (!actionPath) throw new Error('PLAY_UPLOAD_ACTION_PATH is required');
  const result = await runPlayUploadWithRetry({
    command: process.execPath,
    args: [actionPath],
  });
  if (!result.ok) process.exitCode = result.exitCode || 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await main();
