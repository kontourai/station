import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { invokedDirectly } from './lib/module-entry.mjs';
import { canonicalJson } from './release-cohort.mjs';

const ANDROID_PUBLISHER =
  'https://androidpublisher.googleapis.com/androidpublisher/v3';
// A healthy readback takes 1-2 s for all four requests; 15 s per request is
// the bound a stalled one waits before the read is retried from a new edit.
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
// The whole readback, retries included, stays under the protected verifier's
// 90 s bound on this adapter (verify-release-cohort.mjs). A cleanup started
// near the deadline still gets CLEANUP_FLOOR_MS, so the worst case is 75 s.
const TOTAL_BUDGET_MS = 70_000;
const CLEANUP_FLOOR_MS = 5_000;
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

/** A failed publisher request, named by request and attempt. */
class PublisherRequestError extends Error {
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
const timedOut = (error, signal) =>
  signal.aborted ||
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
 * any non-transport error fail at once.
 */
function classifyRequestFailure(error, label, timeoutMs, signal, context) {
  const suffix = `(attempt ${context.attempt} of ${context.maxAttempts})`;
  const status = httpStatus(error);
  if (status !== undefined)
    return new PublisherRequestError(
      `${label} failed with HTTP ${status}: ${error.message} ${suffix}`,
      {
        retryable: status === 408 || status === 429 || status >= 500,
        retryAfterMs:
          status === 429 ? retryAfterMs(error, context.now()) : undefined,
        cause: error,
      },
    );
  if (timedOut(error, signal))
    return new PublisherRequestError(
      `${label} timed out after ${timeoutMs} ms ${suffix}`,
      { retryable: true, cause: error },
    );
  return new PublisherRequestError(
    `${label} failed: ${error?.message ?? String(error)} ${suffix}`,
    { retryable: networkFailure(error), cause: error },
  );
}

async function publisherRequest(client, request, label, timeoutMs, context) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await client.request({
      ...request,
      signal,
      timeout: timeoutMs,
    });
  } catch (error) {
    throw classifyRequestFailure(error, label, timeoutMs, signal, context);
  }
}

/** Each request waits at most its own bound and never past the deadline. */
function requestTimeout(label, context) {
  const remaining = context.deadline - context.now();
  if (remaining <= 0)
    throw new PublisherRequestError(
      `${label} was not started: the ${context.totalBudgetMs} ms readback budget is spent (attempt ${context.attempt} of ${context.maxAttempts})`,
      { retryable: false },
    );
  return Math.min(context.requestTimeoutMs, remaining);
}

async function defaultAuthFactory() {
  const { GoogleAuth } = await import('google-auth-library');
  return new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
}

/**
 * One complete readback from its own temporary edit. The edit is never
 * committed; it is deleted in `finally`, and a failed cleanup fails closed.
 * Nothing read here outlives the attempt: an observation is parsed only from
 * the track and bundles this attempt's edit returned.
 */
async function observeOnce(client, identity, encodedPackage, context) {
  const request = (spec, label, timeoutMs = requestTimeout(label, context)) =>
    publisherRequest(client, spec, label, timeoutMs, context);
  let editId;
  let result;
  let operationError;
  let cleanupError;
  try {
    const created = await request(
      {
        url: `${ANDROID_PUBLISHER}/applications/${encodedPackage}/edits`,
        method: 'POST',
        data: {},
      },
      'create temporary edit',
    );
    editId = created?.data?.id;
    if (typeof editId !== 'string' || !editId)
      fail('temporary edit creation returned no id');
    const editPath = `${ANDROID_PUBLISHER}/applications/${encodedPackage}/edits/${encodeURIComponent(editId)}`;
    const track = await request(
      { url: `${editPath}/tracks/internal`, method: 'GET' },
      'read internal track',
    );
    const bundles = await request(
      { url: `${editPath}/bundles`, method: 'GET' },
      'read bundles',
    );
    result = parseGooglePlayObservation(
      identity,
      { track: track?.data, bundles: bundles?.data },
      context.clock().toISOString(),
    );
  } catch (error) {
    operationError = error;
  } finally {
    if (editId) {
      try {
        await request(
          {
            url: `${ANDROID_PUBLISHER}/applications/${encodedPackage}/edits/${encodeURIComponent(editId)}`,
            method: 'DELETE',
          },
          'delete temporary edit',
          Math.min(
            context.requestTimeoutMs,
            Math.max(context.deadline - context.now(), CLEANUP_FLOOR_MS),
          ),
        );
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (cleanupError) {
    const detail = (error) => error.detail ?? error.message;
    const cleanup = new Error(
      `Google Play cohort verification failed: temporary edit cleanup failed: ${detail(cleanupError)}${operationError ? `; operation also failed: ${detail(operationError)}` : ''}`,
    );
    if (operationError) cleanup.cause = operationError;
    throw cleanup;
  }
  if (operationError) throw operationError;
  return result;
}

const positiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} is invalid`);
  return value;
};

/**
 * Google exposes track state only through an edit. The readback is
 * read-only (no edit is committed), so a transient failure is retried from a
 * fresh edit, within MAX_ATTEMPTS and TOTAL_BUDGET_MS. A cleanup failure, an
 * observation the parser rejects, and any non-transient error are final.
 */
/** @param {any} options */
export async function queryGooglePlayInternal(identity, options = {}) {
  const authFactory = options.authFactory ?? defaultAuthFactory;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const context = {
    clock: options.clock ?? (() => new Date()),
    now,
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
    attempt: 0,
    deadline: 0,
  };
  exactKeys(
    identity,
    ['packageName', 'versionCode', 'versionName'],
    'identity',
  );
  if (identity.packageName !== 'io.kontourai.station.nightly')
    fail('package name is not the Nightly listing');
  const encodedPackage = encodeURIComponent(identity.packageName);
  const auth = await authFactory();
  if (!auth || typeof auth.getClient !== 'function')
    fail('ADC auth is unavailable');
  const client = await auth.getClient();
  if (!client || typeof client.request !== 'function')
    fail('ADC client is unavailable');
  context.deadline = now() + context.totalBudgetMs;
  for (context.attempt = 1; ; context.attempt += 1) {
    try {
      return await observeOnce(client, identity, encodedPackage, context);
    } catch (error) {
      if (
        !(error instanceof PublisherRequestError) ||
        !error.retryable ||
        context.attempt >= context.maxAttempts
      )
        throw error;
      const delayMs = Math.max(
        RETRY_DELAYS_MS[context.attempt - 1] ?? RETRY_DELAYS_MS.at(-1),
        error.retryAfterMs ?? 0,
      );
      if (now() + delayMs >= context.deadline)
        throw new Error(
          `${error.message}; no retry: waiting ${delayMs} ms would pass the ${context.totalBudgetMs} ms readback budget`,
          { cause: error },
        );
      log(`${error.message}; retrying in ${delayMs} ms from a new edit`);
      await sleep(delayMs);
    }
  }
}

const json = (value) => JSON.parse(value);
async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== 'query-json')
    fail('usage: query-google-play-release.mjs query-json <identity-json>');
  const observation = await queryGooglePlayInternal(json(argv[1]));
  process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
}
if (invokedDirectly(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
