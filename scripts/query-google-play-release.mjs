import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { invokedDirectly } from './lib/module-entry.mjs';
import { canonicalJson } from './release-cohort.mjs';

const ANDROID_PUBLISHER =
  'https://androidpublisher.googleapis.com/androidpublisher/v3';
// A healthy readback takes 1-2 s for its token and four requests; 15 s is the
// most any one phase (the token, or one request) waits.
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2_000, 5_000];
// Worst case for the whole command, measured from the first attempt:
// - every phase's limit is min(REQUEST_TIMEOUT_MS, time left before the
//   deadline), so no phase except the edit cleanup runs past
//   TOTAL_BUDGET_MS;
// - a retry wait happens only when MIN_ATTEMPT_BUDGET_MS would still be left
//   after it, so waits end before the deadline;
// - a cleanup that starts at or near the deadline still gets
//   CLEANUP_FLOOR_MS.
// The readback therefore ends by TOTAL_BUDGET_MS + CLEANUP_FLOOR_MS = 65 s
// (plus one timer turn per abandoned phase). The protected verifier gives this
// command 90 s (spawnSync in verify-release-cohort.mjs), leaving 25 s for node
// start-up and loading google-auth-library.
const TOTAL_BUDGET_MS = 60_000;
const CLEANUP_FLOOR_MS = 5_000;
const MIN_ATTEMPT_BUDGET_MS = 10_000;
export const READBACK_WORST_CASE_MS = TOTAL_BUDGET_MS + CLEANUP_FLOOR_MS;
// Transport failures worth a new attempt: Node socket and DNS errors, and
// undici's socket and timeout codes.
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

const fail = (message) => {
  throw new Error(`Google Play cohort verification failed: ${message}`);
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

/**
 * A failed readback phase. The message names the phase, the attempt and a
 * safe outcome (an HTTP status at most); the provider's own error stays in
 * `cause`, in-process.
 */
class ReadbackFailure extends Error {
  constructor(detail, options = {}) {
    super(`Google Play cohort verification failed: ${detail}`, {
      cause: options.cause,
    });
    this.detail = detail;
    this.retryable = options.retryable === true;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Rejection of a phase abandoned at its time limit. */
const LOCAL_DEADLINE = Symbol('local deadline elapsed');

const errorCodes = (cause) => [
  cause?.name,
  cause?.code,
  cause?.cause?.name,
  cause?.cause?.code,
  cause?.cause?.cause?.code,
];
const httpStatus = (cause) => {
  const status = cause?.response?.status ?? cause?.status;
  return Number.isSafeInteger(status) ? status : undefined;
};

/** Retry-After as delta-seconds or an HTTP date; undefined when absent. */
function retryAfterMs(cause, nowMs) {
  const headers = cause?.response?.headers;
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
 * Classifies a phase failure. Only a timeout or abort, a network failure,
 * 408, 429 and 5xx are retryable. Any other HTTP status (a 403 or 404 means
 * the identity or grant is wrong) and any non-transport error, including this
 * module's own checks, are final.
 */
const retryableStatus = (status) =>
  status === 408 || status === 429 || (status >= 500 && status <= 599);
const ABORT_NAMES = new Set(['AbortError', 'ABORT_ERR', 'TimeoutError']);

function outcomeOf(cause, signal) {
  const codes = errorCodes(cause);
  const aborted = codes.some((code) => ABORT_NAMES.has(code));
  if (cause === LOCAL_DEADLINE || (signal?.aborted && aborted))
    return { outcome: 'local deadline elapsed', retryable: true };
  const status = httpStatus(cause);
  if (status !== undefined)
    return {
      outcome: `failed with HTTP ${status}`,
      retryable: retryableStatus(status),
      status,
    };
  if (aborted) return { outcome: 'aborted', retryable: true };
  return {
    outcome: 'failed',
    retryable: codes.some((code) => NETWORK_ERROR_CODES.has(code)),
  };
}

function readbackFailure(phase, cause, context, signal) {
  if (cause instanceof ReadbackFailure) return cause;
  const { outcome, retryable, status } = outcomeOf(cause, signal);
  return new ReadbackFailure(
    `${phase} ${outcome} (attempt ${context.attempt} of ${context.maxAttempts})`,
    {
      cause,
      retryable,
      retryAfterMs:
        status === 429 ? retryAfterMs(cause, context.now()) : undefined,
    },
  );
}

/** The limit for a phase: its own bound, never past the deadline. */
function phaseLimit(phase, context) {
  const remaining = context.deadline - context.now();
  if (remaining <= 0)
    throw new ReadbackFailure(
      `${phase} not started: the ${context.totalBudgetMs} ms readback budget is spent (attempt ${context.attempt} of ${context.maxAttempts})`,
    );
  return Math.min(context.requestTimeoutMs, remaining);
}

/**
 * Runs one phase under a hard time limit that does not depend on the phase
 * honouring its signal. At the limit the signal aborts; a request that honours
 * it rejects with its own error first, and one that ignores it (the STS token
 * exchange) is abandoned one timer turn later. `step.phase` may advance while
 * `run` works, so a failure names the phase it stopped in.
 */
async function withinLimit(step, timeoutMs, context, run) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('local deadline', 'TimeoutError'));
      timer = setTimeout(() => reject(LOCAL_DEADLINE), 0);
    }, timeoutMs);
  });
  expired.catch(() => {});
  try {
    return await Promise.race([run(controller.signal, timeoutMs), expired]);
  } catch (cause) {
    throw readbackFailure(step.phase, cause, context, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function publisherRequest(client, phase, request, context, timeoutMs) {
  return withinLimit(
    { phase },
    timeoutMs ?? phaseLimit(phase, context),
    context,
    (signal, limitMs) =>
      client.request({ ...request, signal, timeout: limitMs }),
  );
}

async function defaultAuthFactory() {
  const { GoogleAuth } = await import('google-auth-library');
  return new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    // Cancels a stalled subject-token or impersonation request, which use the
    // client's transporter. The STS exchange builds its own transporter
    // without these defaults (google-auth-library 11), so only withinLimit
    // bounds it.
    clientOptions: { transporterOptions: { timeout: REQUEST_TIMEOUT_MS } },
  });
}

/**
 * A new ADC client and access token for every attempt, as one time-limited
 * stage: google-auth-library fetches the subject token, exchanges it at STS
 * and impersonates inside the first token request, with no signal of its
 * own (GoogleAuth#getClient does the same when it has to look up a project
 * id, which is why the limit covers all three phases). A fresh client per
 * attempt matters because a client de-duplicates
 * token refreshes, so a retry on the same client would wait on the same
 * stalled exchange.
 */
function acquireClient(context) {
  const step = { phase: 'authenticate' };
  return withinLimit(
    step,
    phaseLimit(step.phase, context),
    context,
    async () => {
      const auth = await context.authFactory();
      if (!auth || typeof auth.getClient !== 'function')
        fail('ADC auth is unavailable');
      step.phase = 'acquire-client';
      const client = await auth.getClient();
      if (
        !client ||
        typeof client.request !== 'function' ||
        typeof client.getAccessToken !== 'function'
      )
        fail('ADC client is unavailable');
      step.phase = 'acquire-token';
      const token = await client.getAccessToken();
      if (typeof token?.token !== 'string' || !token.token)
        fail('ADC returned no access token');
      return client;
    },
  );
}

/** Deletes this attempt's edit and returns the failure, if any. */
async function deleteEdit(client, editUrl, context) {
  const remaining = context.deadline - context.now();
  try {
    await publisherRequest(
      client,
      'delete-edit',
      { url: editUrl, method: 'DELETE' },
      context,
      Math.min(context.requestTimeoutMs, Math.max(remaining, CLEANUP_FLOOR_MS)),
    );
    return undefined;
  } catch (cause) {
    return cause;
  }
}

/** Reads track and bundles from an edit and validates the observation. */
async function readEdit(client, identity, editUrl, context) {
  const track = await publisherRequest(
    client,
    'read-track',
    { url: `${editUrl}/tracks/internal`, method: 'GET' },
    context,
  );
  const bundles = await publisherRequest(
    client,
    'read-bundles',
    { url: `${editUrl}/bundles`, method: 'GET' },
    context,
  );
  try {
    return parseGooglePlayObservation(
      identity,
      { track: track?.data, bundles: bundles?.data },
      context.clock().toISOString(),
    );
  } catch (cause) {
    throw readbackFailure('validate-observation', cause, context);
  }
}

/**
 * One complete readback: a fresh token, its own temporary edit, the track and
 * bundles read from that edit, and the edit's deletion. Nothing read here
 * outlives the attempt.
 */
async function observeOnce(identity, encodedPackage, context) {
  const client = await acquireClient(context);
  const created = await publisherRequest(
    client,
    'create-edit',
    {
      url: `${ANDROID_PUBLISHER}/applications/${encodedPackage}/edits`,
      method: 'POST',
      data: {},
    },
    context,
  );
  const editId = created?.data?.id;
  if (typeof editId !== 'string' || !editId)
    throw readbackFailure(
      'create-edit',
      new Error('temporary edit creation returned no id'),
      context,
    );
  const editUrl = `${ANDROID_PUBLISHER}/applications/${encodedPackage}/edits/${encodeURIComponent(editId)}`;
  let result;
  let operationError;
  try {
    result = await readEdit(client, identity, editUrl, context);
  } catch (cause) {
    operationError = cause;
  }
  const cleanupError = await deleteEdit(client, editUrl, context);
  return settleAttempt(result, operationError, cleanupError, editId, context);
}

/**
 * A failed read whose cleanup also failed carries both details and is retried
 * only when both failures are retryable: one network stall is likely to cover
 * the read and its cleanup, and nothing depends on the delete. A cleanup
 * failure of any other kind after a failed read is final. A good read whose
 * cleanup failed returns the observation with a stderr warning naming the
 * edit: the edit is never committed, never changes the live app, and Play
 * invalidates it at this account's next edit.
 */
function settleAttempt(result, operationError, cleanupError, editId, context) {
  if (cleanupError && operationError)
    throw new ReadbackFailure(
      `${cleanupError.detail} after ${operationError.detail}`,
      {
        cause: new AggregateError([cleanupError, operationError]),
        retryable:
          operationError.retryable === true && cleanupError.retryable === true,
        retryAfterMs: operationError.retryAfterMs,
      },
    );
  if (operationError) throw operationError;
  if (cleanupError)
    context.log(
      `Google Play readback warning: ${cleanupError.detail} for temporary edit ${editId}; the edit was never committed and Play invalidates it at this account's next edit`,
    );
  return result;
}

/** The wait before the next attempt, or the final error when none fits. */
function nextAttemptDelay(error, context) {
  if (
    !(error instanceof ReadbackFailure) ||
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
    throw new ReadbackFailure(
      `readback budget spent: ${Math.max(0, remainingAfterDelay)} ms of the ${context.totalBudgetMs} ms budget would remain after a ${delayMs} ms wait, below the ${context.minAttemptBudgetMs} ms an attempt needs; last failure: ${error.detail}`,
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
    attempt: 1,
    deadline: 0,
  };
}

/**
 * Google exposes track state only through an edit, which this readback never
 * commits. A transient failure (a timeout, a network failure, 408, 429 or
 * 5xx, in the token stage or any request) is retried from a new client and a
 * new edit, within MAX_ATTEMPTS and TOTAL_BUDGET_MS. Still fail-closed: any
 * other HTTP status, an observation the parser rejects, a spent budget, and
 * a cleanup failure after a failed read unless both failures are retryable. A
 * cleanup failure after a good read is a warning (see settleAttempt).
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
  for (; ; context.attempt += 1) {
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
 * drain, because a token exchange abandoned at its time limit leaves a
 * socket that would otherwise keep the process alive.
 */
export function runCli(argv = process.argv.slice(2), options = {}) {
  return main(argv, options).then(
    () => exitAfterDrain(0),
    (error) => {
      const message =
        error instanceof ReadbackFailure
          ? error.message
          : 'Google Play cohort verification failed: invalid invocation';
      process.stderr.write(`${message}\n`);
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
