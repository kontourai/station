#!/usr/bin/env node
/**
 * Promote a frozen RC store build without rebuilding it (#4929).
 * The protected caller must authenticate the authority file's producer
 * attestation and compare its artifact hashes before invoking this command.
 * This parser does not turn a JSON kind or an upload assertion into authority.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  createAppStoreConnectJwt,
  resolveAppStoreConnectUrl,
} from './app-store-connect-receipt.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { taggedStoreIdentity } from './lib/native-release-config.mjs';
import { parseReleaseTag } from './lib/release-tag.mjs';
import { canonicalJson } from './release-cohort.mjs';

const PLAY = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const KIND = 'station.release-store-authority/v1';
const RECEIPT_KIND = 'station.store-promotion-result/v1';
const LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TRACK = /^[a-z][a-z0-9._-]{0,79}$/;
const RELEASE_STATES = new Set(['draft', 'completed', 'inProgress', 'halted']);
const SUBMITTED = new Set([
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'PENDING_APPLE_RELEASE',
  'PENDING_DEVELOPER_RELEASE',
  'PROCESSING_FOR_APP_STORE',
  'READY_FOR_SALE',
  'PROCESSING_FOR_DISTRIBUTION',
  'READY_FOR_DISTRIBUTION',
]);
const EDITABLE = new Set([
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
]);

function fail(message) {
  throw new Error(`Store promotion refused: ${message}`);
}

function exact(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('authority record is malformed');
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail('authority record has missing or unexpected fields');
}

function id(value, label) {
  if (typeof value !== 'string' || !RESOURCE_ID.test(value))
    fail(`${label} is malformed`);
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value))
    fail(`${label} is malformed`);
}

function checksum(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Structural/identity validation only; the caller authenticates the producer.
 * @param {unknown} value
 * @param {'android' | 'ios'} [platform]
 */
export function validateStoreAuthority(value, platform) {
  exact(
    value,
    ['kind', 'producerTag', 'sourceSha', 'version'],
    ['android', 'ios'],
  );
  const tag = parseReleaseTag(value.producerTag);
  const store = taggedStoreIdentity(value.producerTag);
  if (
    value.kind !== KIND ||
    tag.kind !== 'rc' ||
    value.version !== tag.baseVersion ||
    typeof value.sourceSha !== 'string' ||
    !SHA.test(value.sourceSha)
  )
    fail('authority is not an exact RC source');
  if (value.android) {
    const android = value.android;
    exact(android, [
      'packageName',
      'versionCode',
      'aabSha256',
      'providerBundleSha256',
      'sourceTrack',
    ]);
    if (
      android.packageName !== 'io.kontourai.station' ||
      android.versionCode !== store.versionCode ||
      typeof android.sourceTrack !== 'string' ||
      !TRACK.test(android.sourceTrack) ||
      android.sourceTrack === 'production'
    )
      fail('Android identity differs from the RC');
    hash(android.aabSha256, 'AAB digest');
    hash(android.providerBundleSha256, 'provider bundle digest');
    if (android.providerBundleSha256 !== android.aabSha256)
      fail('provider bundle digest differs from the staged AAB');
  }
  if (value.ios) {
    const ios = value.ios;
    exact(ios, [
      'bundleId',
      'appId',
      'buildId',
      'buildNumber',
      'ipaSha256',
      'upload',
    ]);
    if (
      ios.bundleId !== 'io.kontourai.station' ||
      ios.buildNumber !== store.bundleVersion
    )
      fail('Apple identity differs from the RC');
    id(ios.appId, 'App Store app ID');
    id(ios.buildId, 'App Store build ID');
    hash(ios.ipaSha256, 'IPA digest');
    exact(ios.upload, [
      'deliveryMode',
      'sourceSha',
      'ipaSha256',
      'buildId',
      'acknowledged',
    ]);
    if (
      ios.upload.deliveryMode !== 'uploaded' ||
      ios.upload.acknowledged !== true ||
      ios.upload.sourceSha !== value.sourceSha ||
      ios.upload.buildId !== ios.buildId ||
      ios.upload.ipaSha256 !== ios.ipaSha256
    )
      fail('Apple build has no definitive matching upload-lineage receipt');
  }
  if (platform !== undefined && !['android', 'ios'].includes(platform))
    fail('unsupported authority platform');
  if (platform !== undefined && !value[platform])
    fail(`authority has no ${platform} build`);
  if (!value.android && !value.ios) fail('authority has no store build');
  return value;
}

function readJson(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > LIMIT)
    fail('input file is not a bounded regular file');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function options(argv) {
  const platform = argv[0];
  if (!['android', 'ios'].includes(platform))
    fail('platform must be android or ios');
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    if (
      !['--authority', '--output', '--mode', '--track', '--fraction'].includes(
        flag,
      ) ||
      Object.hasOwn(values, flag) ||
      !argv[index + 1] ||
      argv[index + 1].startsWith('--')
    )
      fail('unknown, duplicate or incomplete option');
    values[flag] = argv[index + 1];
  }
  if (!values['--authority'] || !values['--output'])
    fail('--authority and --output are required');
  const mode = values['--mode'] ?? 'plan';
  if (!['plan', 'apply', 'reconcile'].includes(mode))
    fail('mode must be plan, apply or reconcile');
  if (platform === 'ios' && (values['--track'] || values['--fraction']))
    fail('track and fraction are Android options');
  const track = values['--track'] ?? 'production';
  const fraction =
    values['--fraction'] === undefined ? 0.1 : Number(values['--fraction']);
  if (
    !TRACK.test(track) ||
    !Number.isFinite(fraction) ||
    fraction <= 0 ||
    fraction > 1 ||
    (track !== 'production' && fraction !== 1)
  )
    fail('track or rollout fraction is invalid');
  return {
    platform,
    mode,
    track,
    fraction,
    authority: resolve(values['--authority']),
    output: resolve(values['--output']),
  };
}

function atomicReceipt(path, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > LIMIT)
    fail('result receipt exceeded its byte bound');
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function journal(path, authority, request, mode) {
  const lock = `${path}.lock`;
  const token = randomBytes(16).toString('hex');
  const fd = openSync(lock, 'wx', 0o600);
  try {
    writeFileSync(fd, token);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let value;
  try {
    if (mode === 'reconcile') {
      value = readJson(path);
      if (
        value.kind !== RECEIPT_KIND ||
        value.authoritySha256 !== checksum(authority) ||
        canonicalJson(value.request) !== canonicalJson(request) ||
        !['ATTEMPTED', 'UNKNOWN', 'ACKNOWLEDGED'].includes(value.state) ||
        !Array.isArray(value.operations) ||
        value.operations.length > 24 ||
        value.operations.some(
          (operation) =>
            !operation ||
            !['ATTEMPTED', 'UNKNOWN', 'ACKNOWLEDGED'].includes(
              operation.state,
            ) ||
            typeof operation.operation !== 'string' ||
            !HASH.test(operation.requestSha256 ?? ''),
        )
      )
        fail('existing result is not a matching unsettled operation');
    } else {
      if (existsSync(path))
        fail(
          'result already exists; reconcile unsettled effects before any retry',
        );
      value = {
        kind: RECEIPT_KIND,
        producerTag: authority.producerTag,
        sourceSha: authority.sourceSha,
        version: authority.version,
        authoritySha256: checksum(authority),
        request,
        state: 'PLANNED',
        operations: [],
        publication: 'NOT_VERIFIED',
      };
    }
    atomicReceipt(path, value);
  } catch (error) {
    if (readFileSync(lock, 'utf8') === token) unlinkSync(lock);
    throw error;
  }
  return {
    value,
    save() {
      atomicReceipt(path, value);
    },
    close() {
      if (readFileSync(lock, 'utf8') === token) unlinkSync(lock);
    },
  };
}

async function responseJson(response) {
  if (!response?.body) {
    if (response?.ok && response.status === 204) return null;
    fail('provider returned no response body');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > RESPONSE_LIMIT) {
      await reader.cancel();
      fail('provider response exceeded its byte bound');
    }
    chunks.push(Buffer.from(next.value));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!response.ok) fail(`provider returned HTTP ${response.status}`);
  return text ? JSON.parse(text) : null;
}

function client(platform, env, fetchImpl, receipt) {
  let bearer;
  const apple = {
    issuerId: env.APPLE_API_ISSUER_ID,
    keyId: env.APPLE_API_KEY_ID,
    privateKey: env.APPLE_API_PRIVATE_KEY,
  };
  try {
    bearer =
      platform === 'android'
        ? env.GOOGLE_PLAY_ACCESS_TOKEN
        : createAppStoreConnectJwt(apple);
    if (typeof bearer !== 'string' || !bearer.trim() || /[\r\n]/.test(bearer))
      throw new Error();
  } catch {
    fail('protected provider credentials are missing or invalid');
  }
  return async (path, method = 'GET', body, operation) => {
    const url =
      platform === 'android'
        ? new URL(`${PLAY}${path}`)
        : resolveAppStoreConnectUrl(path);
    if (platform === 'android' && url.origin !== new URL(PLAY).origin)
      fail('provider origin differs');
    let effect;
    if (method !== 'GET') {
      if (!operation || receipt.value.operations.length >= 24)
        fail('operation journal is incomplete or full');
      effect = {
        operation,
        method,
        state: 'ATTEMPTED',
        requestSha256: checksum({ path, body: body ?? null }),
      };
      receipt.value.operations.push(effect);
      receipt.value.state = 'ATTEMPTED';
      receipt.save();
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${platform === 'ios' ? createAppStoreConnectJwt(apple) : bearer}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      const result = await responseJson(response);
      if (effect) {
        effect.state = 'ACKNOWLEDGED';
        receipt.save();
      }
      return result;
    } catch {
      if (effect) {
        effect.state = 'UNKNOWN';
        if (Number.isInteger(response?.status))
          effect.httpStatus = response.status;
        receipt.value.state = 'UNKNOWN';
        receipt.save();
      }
      fail(
        operation
          ? `${operation} outcome is unknown; reconcile before retry`
          : 'provider read failed',
      );
    }
  };
}

function trackRelease(track, versionCode) {
  if (!Array.isArray(track?.releases))
    fail('Play track response is incomplete');
  for (const release of track.releases) {
    if (
      !Array.isArray(release.versionCodes) ||
      !release.versionCodes.length ||
      release.versionCodes.some(
        (code) => typeof code !== 'string' || !/^[1-9][0-9]*$/.test(code),
      ) ||
      !RELEASE_STATES.has(release.status)
    )
      fail('Play release response is malformed');
  }
  const matches = track.releases.filter((release) =>
    release.versionCodes.includes(String(versionCode)),
  );
  if (matches.length > 1) fail('Play candidate appears in multiple releases');
  if (matches[0] && matches[0].versionCodes.length !== 1)
    fail('Play candidate shares a release with unrelated version codes');
  return matches[0];
}

function bundleMatches(bundles, android) {
  const matches = Array.isArray(bundles?.bundles)
    ? bundles.bundles.filter(
        (entry) => entry.versionCode === android.versionCode,
      )
    : [];
  if (matches.length !== 1 || matches[0].sha256 !== android.aabSha256)
    fail('Play bundle version or digest differs from the acknowledged RC');
}

function desiredTrack(source, target, request, android) {
  const candidate = trackRelease(source, android.versionCode);
  const existing = trackRelease(target, android.versionCode);
  if (!candidate || candidate.status !== 'completed')
    fail('Play source candidate is not completed');
  for (const release of target.releases) {
    if (
      release !== existing &&
      (release.status === 'inProgress' ||
        release.versionCodes.some(
          (code) => Number(code) >= android.versionCode,
        ))
    )
      fail('Play target has an unrelated rollout or newer version');
  }
  if (existing?.status === 'completed') return target;
  const activeRollout =
    existing && ['inProgress', 'halted'].includes(existing.status);
  if (
    activeRollout &&
    (typeof existing.userFraction !== 'number' ||
      existing.userFraction <= 0 ||
      existing.userFraction >= 1)
  )
    fail('Play existing rollout fraction is malformed');
  if (activeRollout && request.fraction < existing.userFraction)
    fail('Play rollout fraction cannot be reduced');
  if (
    request.track === 'production' &&
    request.fraction < 1 &&
    !activeRollout &&
    !target.releases.some((release) => release.status === 'completed')
  )
    fail(
      'The first production publication requires explicit full launch fraction 1',
    );
  if (
    request.fraction === 1 &&
    Object.hasOwn(existing ?? candidate, 'countryTargeting')
  )
    fail(
      'Country-targeted rollout completion requires a separate reviewed geography disposition',
    );
  const selected = {
    ...(existing ?? candidate),
    status: request.fraction === 1 ? 'completed' : 'inProgress',
  };
  if (request.fraction === 1) delete selected.userFraction;
  else selected.userFraction = request.fraction;
  const releases = target.releases.map((release) =>
    release === existing ? selected : release,
  );
  if (!existing) releases.push(selected);
  return { track: request.track, releases };
}

async function playSnapshot(api, android, track, receipt, operation) {
  const packagePath = `/applications/${android.packageName}`;
  let editId;
  try {
    const edit = await api(
      `${packagePath}/edits`,
      'POST',
      {},
      `${operation}-edit`,
    );
    editId = id(edit?.id, 'Play edit ID');
    receipt.value.lastObservationEditId = editId;
    receipt.save();
    const base = `${packagePath}/edits/${encodeURIComponent(editId)}`;
    const target = await api(`${base}/tracks/${encodeURIComponent(track)}`);
    const bundles = await api(`${base}/bundles`);
    bundleMatches(bundles, android);
    return { target, base, editId };
  } finally {
    if (editId)
      await api(
        `${packagePath}/edits/${encodeURIComponent(editId)}`,
        'DELETE',
        undefined,
        `${operation}-cleanup`,
      );
  }
}

async function promoteAndroid(authority, request, mode, api, receipt) {
  const android = authority.android;
  if (mode === 'reconcile') {
    const planned = receipt.value.plan?.track;
    if (planned?.track !== request.track)
      fail('Recovery plan names another target track');
    const frozen = trackRelease(planned, android.versionCode);
    if (
      !frozen ||
      (request.fraction === 1
        ? frozen.status !== 'completed'
        : frozen.status !== 'completed' &&
          !(
            frozen.status === 'inProgress' &&
            typeof frozen.userFraction === 'number' &&
            frozen.userFraction >= request.fraction &&
            frozen.userFraction < 1
          ))
    )
      fail(
        'Recovery plan does not contain the frozen RC and requested rollout',
      );
    const observed = await playSnapshot(
      api,
      android,
      request.track,
      receipt,
      'reconcile',
    );
    const selected = trackRelease(observed.target, android.versionCode);
    receipt.value.state =
      selected && canonicalJson(observed.target) === canonicalJson(planned)
        ? 'VERIFIED'
        : 'UNKNOWN';
    return;
  }
  const packagePath = `/applications/${android.packageName}`;
  let editId;
  let committed = false;
  try {
    const edit = await api(`${packagePath}/edits`, 'POST', {}, 'prepare-edit');
    editId = id(edit?.id, 'Play edit ID');
    receipt.value.editId = editId;
    receipt.save();
    const base = `${packagePath}/edits/${encodeURIComponent(editId)}`;
    const source = await api(
      `${base}/tracks/${encodeURIComponent(android.sourceTrack)}`,
    );
    const target = await api(
      `${base}/tracks/${encodeURIComponent(request.track)}`,
    );
    if (source.track !== android.sourceTrack || target.track !== request.track)
      fail('Play track response names another track');
    bundleMatches(await api(`${base}/bundles`), android);
    const track = desiredTrack(source, target, request, android);
    if (Buffer.byteLength(JSON.stringify(track)) > LIMIT / 2)
      fail('Play track plan exceeded its byte bound');
    receipt.value.plan = { track };
    receipt.save();
    if (canonicalJson(track) === canonicalJson(target)) {
      receipt.value.state = 'NOOP';
      return;
    }
    if (mode === 'plan') {
      receipt.value.state = 'PLANNED';
      return;
    }
    const updated = await api(
      `${base}/tracks/${encodeURIComponent(request.track)}`,
      'PUT',
      track,
      'update-track',
    );
    if (canonicalJson(updated) !== canonicalJson(track))
      fail('Play did not acknowledge the requested track');
    const commit = await api(`${base}:commit`, 'POST', {}, 'commit-edit');
    if (commit?.id !== editId) fail('Play commit returned another edit ID');
    committed = true;
    receipt.value.committedEditId = editId;
    receipt.value.commitAcknowledged = true;
    receipt.value.state = 'ACKNOWLEDGED';
    receipt.save();
  } finally {
    if (editId && !committed) {
      const outcome = receipt.value.state;
      await api(
        `${packagePath}/edits/${encodeURIComponent(editId)}`,
        'DELETE',
        undefined,
        'prepare-cleanup',
      );
      receipt.value.state = outcome;
    }
  }
  const observed = await playSnapshot(
    api,
    android,
    request.track,
    receipt,
    'verify',
  );
  receipt.value.state =
    canonicalJson(observed.target) === canonicalJson(receipt.value.plan.track)
      ? 'VERIFIED'
      : 'UNKNOWN';
}

function parseObservation(argv) {
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    if (
      ![
        '--producer-tag',
        '--source-sha',
        '--aab',
        '--source-track',
        '--output',
      ].includes(flag) ||
      Object.hasOwn(values, flag) ||
      !argv[index + 1] ||
      argv[index + 1].startsWith('--')
    )
      fail('unknown, duplicate or incomplete observation option');
    values[flag] = argv[index + 1];
  }
  for (const flag of ['--producer-tag', '--source-sha', '--aab', '--output'])
    if (!values[flag]) fail(`${flag} is required`);
  const parsed = parseReleaseTag(values['--producer-tag']);
  const identity = taggedStoreIdentity(parsed.tag);
  const sourceTrack = values['--source-track'] ?? 'internal';
  if (
    parsed.kind !== 'rc' ||
    !SHA.test(values['--source-sha']) ||
    !TRACK.test(sourceTrack) ||
    sourceTrack === 'production'
  )
    fail('observation must name an exact RC and testing track');
  return {
    producerTag: parsed.tag,
    sourceSha: values['--source-sha'],
    version: parsed.baseVersion,
    versionCode: identity.versionCode,
    sourceTrack,
    aab: resolve(values['--aab']),
    output: resolve(values['--output']),
  };
}

async function artifactHash(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.size < 1 || before.size > 512 * 1024 * 1024)
    fail('AAB is not a regular artifact within the 512 MiB observation bound');
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > before.size) fail('AAB grew during hashing');
    digest.update(chunk);
  }
  const after = lstatSync(path);
  if (
    bytes !== before.size ||
    after.size !== before.size ||
    after.ino !== before.ino ||
    after.dev !== before.dev ||
    after.mtimeMs !== before.mtimeMs
  )
    fail('AAB changed during hashing');
  return digest.digest('hex');
}

function unsettled(receipt) {
  const operations = receipt.value.operations;
  return (
    operations.some((operation) => operation.state === 'UNKNOWN') ||
    operations.some(
      (operation) =>
        !operation.operation.endsWith('-edit') &&
        !operation.operation.endsWith('-cleanup'),
    ) ||
    operations.some(
      (operation) =>
        operation.operation.endsWith('-edit') &&
        !operations.some(
          (cleanup) =>
            cleanup.operation ===
              operation.operation.replace(/-edit$/, '-cleanup') &&
            cleanup.state === 'ACKNOWLEDGED',
        ),
    )
  );
}

async function observeAndroid(argv, env, fetchImpl) {
  const parsed = parseObservation(argv);
  if (existsSync(parsed.output))
    fail('observation authority output already exists');
  const aabSha256 = await artifactHash(parsed.aab);
  const authority = {
    kind: KIND,
    producerTag: parsed.producerTag,
    sourceSha: parsed.sourceSha,
    version: parsed.version,
    android: {
      packageName: 'io.kontourai.station',
      versionCode: parsed.versionCode,
      aabSha256,
      providerBundleSha256: aabSha256,
      sourceTrack: parsed.sourceTrack,
    },
  };
  validateStoreAuthority(authority, 'android');
  const receipt = journal(
    `${parsed.output}.observation.json`,
    authority,
    {
      platform: 'android',
      operation: 'observe',
      sourceTrack: parsed.sourceTrack,
    },
    'plan',
  );
  try {
    const api = client('android', env, fetchImpl, receipt);
    const snapshot = await playSnapshot(
      api,
      authority.android,
      parsed.sourceTrack,
      receipt,
      'observe',
    );
    const release = trackRelease(snapshot.target, parsed.versionCode);
    if (
      snapshot.target.track !== parsed.sourceTrack ||
      !release ||
      release.status !== 'completed'
    )
      fail(
        'Play source candidate is not completed on the selected testing track',
      );
    receipt.value.state = 'VERIFIED';
    receipt.save();
    atomicReceipt(parsed.output, authority);
    return receipt.value;
  } catch {
    receipt.value.state = unsettled(receipt) ? 'UNKNOWN' : 'REFUSED';
    receipt.value.failure =
      'Store promotion refused: Play observation or cleanup did not establish authority';
    receipt.save();
    return receipt.value;
  } finally {
    receipt.close();
  }
}

function collection(value, label) {
  if (!Array.isArray(value?.data) || value.links?.next)
    fail(`${label} is incomplete or ambiguous`);
  return value.data;
}

function resource(value, type, expectedId) {
  if (value?.data?.type !== type || value.data.id !== expectedId)
    fail(`App Store ${type} response differs from the selected identity`);
  return value.data;
}

async function appleState(authority, api) {
  const ios = authority.ios;
  const app = resource(
    await api(`/v1/apps/${encodeURIComponent(ios.appId)}`),
    'apps',
    ios.appId,
  );
  if (app.attributes?.bundleId !== ios.bundleId)
    fail('App Store app has another bundle ID');
  const buildPayload = await api(
    `/v1/builds/${encodeURIComponent(ios.buildId)}?include=app,preReleaseVersion`,
  );
  const build = resource(buildPayload, 'builds', ios.buildId);
  const preReleaseId = build.relationships?.preReleaseVersion?.data?.id;
  const train = buildPayload.included?.filter(
    (entry) => entry.type === 'preReleaseVersions' && entry.id === preReleaseId,
  );
  if (
    build.attributes?.version !== ios.buildNumber ||
    build.attributes?.processingState !== 'VALID' ||
    build.relationships?.app?.data?.id !== ios.appId ||
    train?.length !== 1 ||
    train[0].attributes?.version !== authority.version ||
    train[0].attributes?.platform !== 'IOS'
  )
    fail('App Store build differs from the selected processed RC');
  const query = new URLSearchParams({
    'filter[platform]': 'IOS',
    'filter[versionString]': authority.version,
    include: 'build',
    limit: '2',
  });
  const matches = collection(
    await api(
      `/v1/apps/${encodeURIComponent(ios.appId)}/appStoreVersions?${query}`,
    ),
    'App Store version list',
  ).filter(
    (entry) =>
      entry.type === 'appStoreVersions' &&
      entry.attributes?.versionString === authority.version &&
      entry.attributes?.platform === 'IOS',
  );
  if (matches.length !== 1)
    fail('exact App Store version metadata must already exist');
  const version = matches[0];
  id(version.id, 'App Store version ID');
  if (version.attributes.releaseType !== 'MANUAL')
    fail('App Store version must use manual release authority');
  const linked = version.relationships?.build?.data?.id ?? null;
  if (linked !== null && linked !== ios.buildId)
    fail('App Store version already selects another build');
  return {
    version,
    linked,
    state:
      version.attributes.appVersionState ?? version.attributes.appStoreState,
  };
}

function appleReleaseAvailabilityState(value) {
  if (
    typeof value !== 'string' ||
    (!SUBMITTED.has(value) && !EDITABLE.has(value))
  )
    fail('App Store availability state is not recognized');
  return value === 'READY_FOR_SALE' || value === 'READY_FOR_DISTRIBUTION'
    ? 'RELEASED'
    : 'PENDING';
}

/** Fresh provider readback; the caller still authenticates the RC upload authority. */
export async function observeAppleReleaseAvailability(
  authority,
  env = process.env,
  fetchImpl = fetch,
) {
  validateStoreAuthority(authority, 'ios');
  const api = client('ios', env, fetchImpl);
  const observed = await appleState(authority, (path, method = 'GET') => {
    if (method !== 'GET') fail('availability observation must be read-only');
    return api(path);
  });
  const ios = authority.ios;
  if (observed.linked !== ios.buildId)
    fail('App Store availability has no selected candidate build');
  const state = appleReleaseAvailabilityState(observed.state);
  for (const field of ['appVersionState', 'appStoreState']) {
    if (
      Object.hasOwn(observed.version.attributes, field) &&
      appleReleaseAvailabilityState(observed.version.attributes[field]) !==
        state
    )
      fail('App Store availability state is ambiguous');
  }
  return {
    state,
    providerState: observed.state,
    version: authority.version,
    appId: ios.appId,
    bundleId: ios.bundleId,
    buildId: ios.buildId,
    buildNumber: ios.buildNumber,
    producerTag: authority.producerTag,
    sourceSha: authority.sourceSha,
    appStoreVersionId: observed.version.id,
  };
}

async function submissionState(ios, versionId, api) {
  const query = new URLSearchParams({ limit: '200' });
  const active = collection(
    await api(
      `/v1/apps/${encodeURIComponent(ios.appId)}/reviewSubmissions?${query}`,
    ),
    'App Store submissions',
  ).filter(
    (entry) =>
      entry.type === 'reviewSubmissions' &&
      entry.attributes?.state !== 'COMPLETE',
  );
  if (active.length > 1)
    fail('App Store has ambiguous active review submissions');
  if (!active.length) return null;
  const submission = active[0];
  id(submission.id, 'App Store submission ID');
  const items = collection(
    await api(
      `/v1/reviewSubmissions/${encodeURIComponent(submission.id)}/items?include=appStoreVersion`,
    ),
    'App Store submission items',
  );
  if (
    items.length !== 1 ||
    items[0].type !== 'reviewSubmissionItems' ||
    items[0].relationships?.appStoreVersion?.data?.id !== versionId
  )
    fail('App Store active submission contains unrelated review items');
  return submission;
}

async function promoteApple(authority, mode, api, receipt) {
  const ios = authority.ios;
  const observed = await appleState(authority, api);
  receipt.value.versionId = observed.version.id;
  if (observed.linked === ios.buildId && SUBMITTED.has(observed.state)) {
    receipt.value.state = mode === 'reconcile' ? 'VERIFIED' : 'NOOP';
    receipt.value.providerState = observed.state;
    return;
  }
  if (mode === 'reconcile') {
    receipt.value.state = 'UNKNOWN';
    return;
  }
  if (!EDITABLE.has(observed.state))
    fail('App Store version is not editable for review');
  let submission = await submissionState(ios, observed.version.id, api);
  if (submission && submission.attributes?.state !== 'READY_FOR_REVIEW')
    fail('App Store submission is not an editable draft');
  receipt.value.plan = {
    versionId: observed.version.id,
    buildId: ios.buildId,
    review: 'submit',
    releaseType: 'MANUAL',
  };
  receipt.save();
  if (mode === 'plan') {
    receipt.value.state = 'PLANNED';
    return;
  }
  if (observed.linked === null) {
    await api(
      `/v1/appStoreVersions/${encodeURIComponent(observed.version.id)}/relationships/build`,
      'PATCH',
      {
        data: { type: 'builds', id: ios.buildId },
      },
      'select-build',
    );
  }
  if (!submission) {
    const response = await api(
      '/v1/reviewSubmissions',
      'POST',
      {
        data: {
          type: 'reviewSubmissions',
          attributes: { platform: 'IOS' },
          relationships: { app: { data: { type: 'apps', id: ios.appId } } },
        },
      },
      'create-review',
    );
    submission = response?.data;
    if (submission?.type !== 'reviewSubmissions')
      fail('App Store returned no review submission');
    id(submission.id, 'App Store submission ID');
    receipt.value.submissionId = submission.id;
    receipt.save();
    await api(
      '/v1/reviewSubmissionItems',
      'POST',
      {
        data: {
          type: 'reviewSubmissionItems',
          relationships: {
            reviewSubmission: {
              data: { type: 'reviewSubmissions', id: submission.id },
            },
            appStoreVersion: {
              data: { type: 'appStoreVersions', id: observed.version.id },
            },
          },
        },
      },
      'attach-review-version',
    );
  }
  receipt.value.submissionId = submission.id;
  receipt.save();
  await api(
    `/v1/reviewSubmissions/${encodeURIComponent(submission.id)}`,
    'PATCH',
    {
      data: {
        type: 'reviewSubmissions',
        id: submission.id,
        attributes: { submitted: true },
      },
    },
    'submit-review',
  );
  const after = await appleState(authority, api);
  const review = await submissionState(ios, after.version.id, api);
  receipt.value.state =
    after.linked === ios.buildId &&
    review?.id === submission.id &&
    ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'COMPLETING'].includes(
      review.attributes?.state,
    )
      ? 'VERIFIED'
      : 'UNKNOWN';
  receipt.value.providerState = review?.attributes?.state ?? 'UNOBSERVED';
}

/** The caller owns durable storage of this result across workflow runs. */
export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
) {
  if (argv[0] === 'observe-android')
    return observeAndroid(argv, env, fetchImpl);
  const parsed = options(argv);
  const authority = validateStoreAuthority(
    readJson(parsed.authority),
    parsed.platform,
  );
  const request =
    parsed.platform === 'android'
      ? { platform: 'android', track: parsed.track, fraction: parsed.fraction }
      : { platform: 'ios', releaseType: 'MANUAL' };
  const receipt = journal(parsed.output, authority, request, parsed.mode);
  try {
    const api = client(parsed.platform, env, fetchImpl, receipt);
    if (parsed.platform === 'android')
      await promoteAndroid(authority, request, parsed.mode, api, receipt);
    else await promoteApple(authority, parsed.mode, api, receipt);
    receipt.save();
    return receipt.value;
  } catch (error) {
    receipt.value.state = unsettled(receipt) ? 'UNKNOWN' : 'REFUSED';
    receipt.value.failure =
      error instanceof Error &&
      error.message.startsWith('Store promotion refused:')
        ? error.message
        : 'Store promotion refused: operation failed; inspect the durable receipt before retry';
    receipt.save();
    return receipt.value;
  } finally {
    receipt.close();
  }
}

if (invokedDirectly(import.meta.url)) {
  main()
    .then((receipt) => {
      process.stdout.write(
        `${JSON.stringify({ state: receipt.state, output: process.argv[process.argv.indexOf('--output') + 1] })}\n`,
      );
      if (!['VERIFIED', 'NOOP', 'PLANNED'].includes(receipt.state))
        process.exitCode = 1;
    })
    .catch(() => {
      process.stderr.write(
        'Store promotion refused: invalid input, unavailable journal or protected credentials.\n',
      );
      process.exitCode = 1;
    });
}
