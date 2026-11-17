import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { invokedDirectly } from './lib/module-entry.mjs';
import { canonicalJson } from './release-cohort.mjs';

const ANDROID_PUBLISHER =
  'https://androidpublisher.googleapis.com/androidpublisher/v3';
// A healthy readback takes 1-2 s for its token and four requests; 15 s per
// step is the bound a stalled one waits before the read is retried.
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
// Worst case for the whole CLI. Every step but the edit cleanup is clipped to
// the deadline (TOTAL_BUDGET_MS after the start), and no attempt starts with
// less than MIN_ATTEMPT_BUDGET_MS left. A cleanup that starts at the deadline
// still gets CLEANUP_FLOOR_MS, so the readback ends by
// TOTAL_BUDGET_MS + CLEANUP_FLOOR_MS = 65 s, leaving 25 s of the protected
// verifier's 90 s bound on this adapter (verify-release-cohort.mjs) for node
// start-up and module loading.
const TOTAL_BUDGET_MS = 60_000;
const CLEANUP_FLOOR_MS = 5_000;
const MIN_ATTEMPT_BUDGET_MS = 10_000;
export const READBACK_WORST_CASE_MS = TOTAL_BUDGET_MS + CLEANUP_FLOOR_MS;
const RETRY_DELAYS_MS = [2_000, 5_000];
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const require = createRequire(import.meta.url);
export const googleAuthLibraryVersion =
  require('google-auth-library/package.json').version;

/** A verification failure of this module's own: never retried. */
class VerificationFailure extends Error {
  constructor(message, options) {
    super(`Google Play cohort verification failed: ${message}`, options);
    this.detail = message;
  }
}
const fail = (message) => {
  throw new VerificationFailure(message);
};
const plain = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const digest = (value) =>
  `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const exactKeys = (value, keys, label) => {
  if (
    !plain(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys)
  )
    fail(`${label} is malformed`);
  return value;
};
const integer = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} is invalid`);
  return value;
};

export function parseGooglePlayObservation(
  identity,
  responses,
  observedAt = new Date().toISOString(),
) {
  exactKeys(
    identity,
    ['packageName', 'versionCode', 'versionName'],
    'identity',
  );
  if (identity.packageName !== 'io.kontourai.station.nightly')
    fail('package name is not the Nightly listing');
  integer(identity.versionCode, 'identity.versionCode');
  if (typeof identity.versionName !== 'string' || !identity.versionName)
    fail('identity.versionName is invalid');
  if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt)))
    fail('observation timestamp is invalid');
  if (!plain(responses) || !plain(responses.track) || !plain(responses.bundles))
    fail('publisher response is malformed');
  if (
    !Array.isArray(responses.track.releases) ||
    !Array.isArray(responses.bundles.bundles)
  )
    fail('publisher response is incomplete');

  const matches = responses.track.releases.filter(
    (release) =>
      plain(release) &&
      release.name === identity.versionName &&
      Array.isArray(release.versionCodes) &&
      release.versionCodes.some(
        (code) => Number(code) === identity.versionCode,
      ),
  );
  if (matches.length !== 1)
    fail(
      matches.length
        ? 'target release is duplicated'
        : 'target release is missing or does not expose the requested version name',
    );
  const release = matches[0];
  if (release.status !== 'completed')
    fail(`target release status is ${String(release.status)}, not completed`);
  const bundleMatches = responses.bundles.bundles.filter(
    (bundle) =>
      plain(bundle) && Number(bundle.versionCode) === identity.versionCode,
  );
  if (bundleMatches.length !== 1)
    fail(
      bundleMatches.length
        ? 'target bundle is duplicated'
        : 'target bundle is missing',
    );
  if (!/^[a-f0-9]{64}$/.test(bundleMatches[0].sha256 ?? ''))
    fail('target bundle does not expose a SHA-256 digest');
  const raw = { track: responses.track, bundles: responses.bundles };
  return {
    provider: 'google-play',
    observedAt,
    adapterVersion: `google-auth-library/${googleAuthLibraryVersion}`,
    immutableReference: `play:internal:${identity.packageName}:${identity.versionCode}`,
    requested: {
      packageName: identity.packageName,
      track: 'internal',
      versionCode: identity.versionCode,
      versionName: identity.versionName,
      status: 'completed',
    },
    observed: {
      packageName: identity.packageName,
      track: 'internal',
      versionCode: identity.versionCode,
      versionName: release.name,
      status: release.status,
      bundleSha256: bundleMatches[0].sha256,
    },
    rawResponseDigest: digest(raw),
  };
}

/** A failed step of one attempt, named by step and attempt. */
class ReadbackStepError extends Error {
  constructor(message, { retryable, retryAfterMs, cause }) {
    super(`Google Play cohort verification failed: ${message}`, { cause });
    this.detail = message;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

const httpStatus = (error) => {
  const status = error?.response?.status ?? error?.status;
  return Number.isSafeInteger(status) ? status : undefined;
};
const abortError = (error) =>
  [error?.name, error?.cause?.name].some(
    (name) => name === 'AbortError' || name === 'TimeoutError',
  );
const networkFailure = (error) =>
  [error?.code, error?.cause?.code, error?.cause?.cause?.code].some((code) =>
    NETWORK_ERROR_CODES.has(code),
  );

/** Retry-After as delta-seconds or an HTTP date; undefined when absent. */
function retryAfterMs(error, nowMs) {
  const headers = error?.response?.headers;
  const value =
    typeof headers?.get === 'function'
      ? headers.get('retry-after')
      : headers?.['retry-after'];
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

/**
 * Only a timeout, a network failure, 408, 429 and 5xx are retryable. Any
 * other HTTP status (a 403 or 404 means the identity or grant is wrong) and
 * any non-transport error fail at once. This module's own verification
 * failures pass through unchanged.
 */
function classifyStepFailure(error, label, timeoutMs, timedOut, context) {
  if (error instanceof VerificationFailure) return error;
  const suffix = `(attempt ${context.attempt} of ${context.maxAttempts})`;
  const status = httpStatus(error);
  if (status !== undefined)
    return new ReadbackStepError(
      `${label} failed with HTTP ${status}: ${error.message} ${suffix}`,
      {
        retryable: status === 408 || status === 429 || status >= 500,
        retryAfterMs:
          status === 429 ? retryAfterMs(error, context.now()) : undefined,
        cause: error,
      },
    );
  if (timedOut || abortError(error))
    return new ReadbackStepError(
      `${label} timed out after ${timeoutMs} ms ${suffix}`,
      { retryable: true, cause: error },
    );
  return new ReadbackStepError(
    `${label} failed: ${error?.message ?? String(error)} ${suffix}`,
    { retryable: networkFailure(error), cause: error },
  );
}

/**
 * Runs one named step under a hard time limit. The limit does not depend on
 * the step honouring a signal: google-auth-library's STS token exchange
 * takes none, so a stalled exchange is abandoned here, not cancelled (the
 * CLI exits explicitly so an abandoned socket cannot hold it open).
 */
async function timeLimitedStep(label, timeoutMs, context, run) {
  const signal = AbortSignal.timeout(timeoutMs);
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(TIME_LIMIT_EXPIRED), timeoutMs);
  });
  try {
    return await Promise.race([run(signal, timeoutMs), expired]);
  } catch (error) {
    throw classifyStepFailure(
      error,
      label,
      timeoutMs,
      error === TIME_LIMIT_EXPIRED || signal.aborted,
      context,
    );
  } finally {
    clearTimeout(timer);
  }
}
const TIME_LIMIT_EXPIRED = Symbol('time limit expired');

/** Each step waits at most its own bound and never past the deadline. */
function stepTimeout(label, context) {
  const remaining = context.deadline - context.now();
  if (remaining <= 0)
    throw new ReadbackStepError(
      `${label} was not started: the ${context.totalBudgetMs} ms readback budget is spent (attempt ${context.attempt} of ${context.maxAttempts})`,
      { retryable: false },
    );
  return Math.min(context.requestTimeoutMs, remaining);
}

function defaultAuthFactory() {
  return import('google-auth-library').then(
    ({ GoogleAuth }) =>
      new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
        // Bounds the subject-token and impersonation requests, which share
        // the client's transporter; the STS exchange has its own transporter
        // and is bounded only by timeLimitedStep.
        clientOptions: { transporterOptions: { timeout: REQUEST_TIMEOUT_MS } },
      }),
  );
}

/**
 * A new ADC client and access token for every attempt: the client
 * de-duplicates token refreshes, so a retry on the same client would wait on
 * the same stalled exchange.
 */
function acquireClient(context) {
  const label = 'acquire access token';
  return timeLimitedStep(
    label,
    stepTimeout(label, context),
    context,
    async () => {
      const auth = await context.authFactory();
      if (!auth || typeof auth.getClient !== 'function')
        fail('ADC auth is unavailable');
      const client = await auth.getClient();
      if (
        !client ||
        typeof client.request !== 'function' ||
        typeof client.getAccessToken !== 'function'
      )
        fail('ADC client is unavailable');
      const token = await client.getAccessToken();
      if (typeof token?.token !== 'string' || !token.token)
        fail('ADC returned no access token');
      return client;
    },
  );
}

function publisherRequest(client, spec, label, context, timeoutMs) {
  return timeLimitedStep(
    label,
    timeoutMs ?? stepTimeout(label, context),
    context,
    (signal, timeoutMs) =>
      client.request({ ...spec, signal, timeout: timeoutMs }),
  );
}

/**
 * Deletes this attempt's edit. After a good observation a failed delete is
 * only a warning: the edit is uncommitted, so it never changes the app, and
 * Google invalidates it when this account next creates an edit. Returns the
 * failure for the caller to decide.
 */
async function deleteEdit(client, editUrl, context) {
  try {
    await publisherRequest(
      client,
      { url: editUrl, method: 'DELETE' },
      'delete temporary edit',
      context,
      Math.min(
        context.requestTimeoutMs,
        Math.max(context.deadline - context.now(), CLEANUP_FLOOR_MS),
      ),
    );
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * One complete readback: a fresh token, its own temporary edit, the track
 * and bundles read from that edit, and the edit's deletion. Nothing read
 * here outlives the attempt: an observation is parsed only from the track
 * and bundles this attempt's edit returned.
 */
async function observeOnce(identity, encodedPackage, context) {
  const client = await acquireClient(context);
  const created = await publisherRequest(
    client,
    {
      url: `${ANDROID_PUBLISHER}/applications/${encodedPackage}/edits`,
      method: 'POST',
      data: {},
    },
    'create temporary edit',
    context,
  );
  const editId = created?.data?.id;
  if (typeof editId !== 'string' || !editId)
    fail('temporary edit creation returned no id');
  const editUrl = `${ANDROID_PUBLISHER}/applications/${encodedPackage}/edits/${encodeURIComponent(editId)}`;
  let result;
  let operationError;
  try {
    const track = await publisherRequest(
      client,
      { url: `${editUrl}/tracks/internal`, method: 'GET' },
      'read internal track',
      context,
    );
    const bundles = await publisherRequest(
      client,
      { url: `${editUrl}/bundles`, method: 'GET' },
      'read bundles',
      context,
    );
    result = parseGooglePlayObservation(
      identity,
      { track: track?.data, bundles: bundles?.data },
      context.clock().toISOString(),
    );
  } catch (error) {
    operationError = error;
  }
  const cleanupError = await deleteEdit(client, editUrl, context);
  return settleAttempt(result, operationError, cleanupError, editId, context);
}

/**
 * A failed read whose cleanup also failed is final. A good read whose
 * cleanup failed returns the observation with a warning naming the edit.
 */
function settleAttempt(result, operationError, cleanupError, editId, context) {
  const detail = (error) => error.detail ?? error.message;
  if (cleanupError && operationError) {
    const cleanup = new VerificationFailure(
      `temporary edit cleanup failed: ${detail(cleanupError)}; operation also failed: ${detail(operationError)}`,
    );
    cleanup.cause = operationError;
    throw cleanup;
  }
  if (operationError) throw operationError;
  if (cleanupError)
    context.log(
      `Google Play readback warning: temporary edit ${editId} was not deleted: ${detail(cleanupError)}; it was never committed and Play invalidates it at this account's next edit`,
    );
  return result;
}

/** The wait before the next attempt, or a final error when none fits. */
function nextAttemptDelay(error, context) {
  if (
    !(error instanceof ReadbackStepError) ||
    !error.retryable ||
    context.attempt >= context.maxAttempts
  )
    throw error;
  const delayMs = Math.max(
    RETRY_DELAYS_MS[context.attempt - 1] ?? RETRY_DELAYS_MS.at(-1),
    error.retryAfterMs ?? 0,
  );
  const remainingAfterDelay = context.deadline - context.now() - delayMs;
  if (remainingAfterDelay < context.minAttemptBudgetMs)
    throw new VerificationFailure(
      `readback budget spent: ${remainingAfterDelay} ms of the ${context.totalBudgetMs} ms budget would remain after a ${delayMs} ms wait, below the ${context.minAttemptBudgetMs} ms an attempt needs; last failure: ${error.detail}`,
      { cause: error },
    );
  return delayMs;
}

const positiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} is invalid`);
  return value;
};

function readbackContext(options) {
  return {
    authFactory: options.authFactory ?? defaultAuthFactory,
    clock: options.clock ?? (() => new Date()),
    now: options.now ?? (() => Date.now()),
    sleep:
      options.sleep ??
      ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
    log: options.log ?? ((line) => process.stderr.write(`${line}\n`)),
    requestTimeoutMs: positiveInteger(
      options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      'request timeout',
    ),
    maxAttempts: positiveInteger(
      options.maxAttempts ?? MAX_ATTEMPTS,
      'attempt limit',
    ),
    totalBudgetMs: positiveInteger(
      options.totalBudgetMs ?? TOTAL_BUDGET_MS,
      'readback budget',
    ),
    minAttemptBudgetMs: positiveInteger(
      options.minAttemptBudgetMs ?? MIN_ATTEMPT_BUDGET_MS,
      'minimum attempt budget',
    ),
    attempt: 0,
    deadline: 0,
  };
}

/**
 * Google exposes track state only through an edit. The readback is
 * read-only (no edit is committed), so a transient failure (token, request
 * or network) is retried from a new client and a new edit, within
 * MAX_ATTEMPTS and TOTAL_BUDGET_MS. Still final: a non-transient HTTP status,
 * an observation the parser rejects, and a cleanup failure after a failed
 * read.
 */
/** @param {any} options */
export async function queryGooglePlayInternal(identity, options = {}) {
  const context = readbackContext(options);
  exactKeys(
    identity,
    ['packageName', 'versionCode', 'versionName'],
    'identity',
  );
  if (identity.packageName !== 'io.kontourai.station.nightly')
    fail('package name is not the Nightly listing');
  const encodedPackage = encodeURIComponent(identity.packageName);
  context.deadline = context.now() + context.totalBudgetMs;
  for (context.attempt = 1; ; context.attempt += 1) {
    try {
      return await observeOnce(identity, encodedPackage, context);
    } catch (error) {
      const delayMs = nextAttemptDelay(error, context);
      context.log(
        `${error.message}; retrying in ${delayMs} ms from a new edit`,
      );
      await context.sleep(delayMs);
    }
  }
}

const json = (value) => JSON.parse(value);
async function main(argv, options) {
  if (argv.length !== 2 || argv[0] !== 'query-json')
    fail('usage: query-google-play-release.mjs query-json <identity-json>');
  const observation = await queryGooglePlayInternal(json(argv[1]), options);
  process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
}

/**
 * The CLI entry: the observation JSON is the only stdout; retries, warnings
 * and the final error go to stderr. It exits explicitly once both streams
 * drain, because a token exchange abandoned at its time limit can leave a
 * socket that would otherwise keep the process alive.
 */
export function runCli(argv = process.argv.slice(2), options = {}) {
  return main(argv, options).then(
    () => exitAfterDrain(0),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      return exitAfterDrain(1);
    },
  );
}
function exitAfterDrain(code) {
  process.exitCode = code;
  process.stderr.write('', () =>
    process.stdout.write('', () => process.exit(code)),
  );
}
if (invokedDirectly(import.meta.url)) runCli();
