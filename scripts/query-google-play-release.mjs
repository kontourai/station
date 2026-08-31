import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './release-cohort.mjs';

const ANDROID_PUBLISHER =
  'https://androidpublisher.googleapis.com/androidpublisher/v3';
const REQUEST_TIMEOUT_MS = 15_000;
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

async function publisherRequest(client, request, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  return client.request({
    ...request,
    signal,
    timeout: timeoutMs,
  });
}

async function defaultAuthFactory() {
  const { GoogleAuth } = await import('google-auth-library');
  return new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
}

/**
 * Google exposes track state only through an edit. The edit is never
 * committed; it is deleted in `finally`, and a failed cleanup fails closed.
 */
/** @param {any} options */
export async function queryGooglePlayInternal(identity, options = {}) {
  const authFactory = options.authFactory ?? defaultAuthFactory;
  const clock = options.clock ?? (() => new Date());
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1)
    fail('request timeout is invalid');
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
  let editId;
  let result;
  let operationError;
  let cleanupError;
  try {
    const created = await publisherRequest(
      client,
      {
        url: `${ANDROID_PUBLISHER}/applications/${encodedPackage}/edits`,
        method: 'POST',
        data: {},
      },
      requestTimeoutMs,
    );
    editId = created?.data?.id;
    if (typeof editId !== 'string' || !editId)
      fail('temporary edit creation returned no id');
    const encodedEdit = encodeURIComponent(editId);
    const track = await publisherRequest(
      client,
      {
        url: `${ANDROID_PUBLISHER}/applications/${encodedPackage}/edits/${encodedEdit}/tracks/internal`,
        method: 'GET',
      },
      requestTimeoutMs,
    );
    const bundles = await publisherRequest(
      client,
      {
        url: `${ANDROID_PUBLISHER}/applications/${encodedPackage}/edits/${encodedEdit}/bundles`,
        method: 'GET',
      },
      requestTimeoutMs,
    );
    result = parseGooglePlayObservation(
      identity,
      { track: track?.data, bundles: bundles?.data },
      clock().toISOString(),
    );
  } catch (error) {
    operationError = error;
  } finally {
    if (editId) {
      try {
        await publisherRequest(
          client,
          {
            url: `${ANDROID_PUBLISHER}/applications/${encodedPackage}/edits/${encodeURIComponent(editId)}`,
            method: 'DELETE',
          },
          requestTimeoutMs,
        );
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (cleanupError) {
    const cleanup = new Error(
      `Google Play cohort verification failed: temporary edit cleanup failed: ${cleanupError.message}${operationError ? `; operation also failed: ${operationError.message}` : ''}`,
    );
    if (operationError) cleanup.cause = operationError;
    throw cleanup;
  }
  if (operationError) throw operationError;
  return result;
}

const json = (value) => JSON.parse(value);
async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== 'query-json')
    fail('usage: query-google-play-release.mjs query-json <identity-json>');
  const observation = await queryGooglePlayInternal(json(argv[1]));
  process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
