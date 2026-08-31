#!/usr/bin/env node
import { createHash, createPrivateKey, sign as signBytes } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API_ORIGIN = 'https://api.appstoreconnect.apple.com';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function createAppStoreConnectJwt({
  issuerId,
  keyId,
  privateKey,
  now = Date.now(),
}) {
  for (const [name, value] of Object.entries({ issuerId, keyId, privateKey })) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${name} is required`);
    }
  }
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(
    JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }),
  );
  const claims = base64url(
    JSON.stringify({
      iss: issuerId,
      iat: issuedAt,
      exp: issuedAt + 10 * 60,
      aud: 'appstoreconnect-v1',
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = signBytes('SHA256', Buffer.from(signingInput), {
    key: createPrivateKey(privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

export async function appStoreConnectRequest(
  path,
  credentials,
  fetchImpl = fetch,
) {
  const token = createAppStoreConnectJwt(credentials);
  const response = await fetchImpl(new URL(path, API_ORIGIN), {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error('App Store Connect response exceeded the 1 MiB limit');
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `App Store Connect returned non-JSON HTTP ${response.status}`,
    );
  }
  if (!response.ok) {
    const detail = Array.isArray(payload?.errors)
      ? payload.errors
          .slice(0, 3)
          .map((entry) => entry?.detail || entry?.title || entry?.code)
          .filter(Boolean)
          .join('; ')
      : '';
    throw new Error(
      `App Store Connect returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  return payload;
}

async function appStoreConnectMutation(path, credentials, method, body) {
  const response = await fetch(new URL(path, API_ORIGIN), {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${createAppStoreConnectJwt(credentials)}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
    throw new Error(
      'App Store Connect mutation response exceeded the 1 MiB limit',
    );
  if (!response.ok)
    throw new Error(
      `App Store Connect ${method} ${path} returned HTTP ${response.status}`,
    );
  return text ? JSON.parse(text) : null;
}

export function selectAppResource(payload, bundleId) {
  const matches = Array.isArray(payload?.data)
    ? payload.data.filter(
        (entry) =>
          entry?.type === 'apps' && entry?.attributes?.bundleId === bundleId,
      )
    : [];
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one App Store Connect app for ${bundleId}; found ${matches.length}`,
    );
  }
  return matches[0];
}

export function selectProcessedBuildResource(payload, bundleVersion) {
  const matches = selectBuildResources(payload, bundleVersion);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one App Store Connect build ${bundleVersion}; found ${matches.length}`,
    );
  }
  const build = matches[0];
  if (build.attributes?.processingState !== 'VALID') {
    throw new Error(
      `App Store Connect build ${bundleVersion} is ${String(build.attributes?.processingState ?? 'missing')}, not VALID`,
    );
  }
  return build;
}

export function selectBuildResources(payload, bundleVersion) {
  const matches = Array.isArray(payload?.data)
    ? payload.data.filter(
        (entry) =>
          entry?.type === 'builds' &&
          entry?.attributes?.version === bundleVersion,
      )
    : [];
  if (matches.length > 1) {
    throw new Error(
      `expected at most one App Store Connect build ${bundleVersion}; found ${matches.length}`,
    );
  }
  return matches;
}

function valueAfter(argv, flag) {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

function requiredOption(argv, flag) {
  const value = valueAfter(argv, flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function credentialsFromEnvironment(env) {
  return {
    issuerId: env.APPLE_API_ISSUER_ID,
    keyId: env.APPLE_API_KEY_ID,
    privateKey: env.APPLE_API_PRIVATE_KEY,
  };
}

function writeReceipt(path, receipt) {
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

async function queryBuild({ appId, bundleVersion }, env) {
  const query = new URLSearchParams({
    'filter[app]': appId,
    'filter[version]': bundleVersion,
    limit: '2',
  });
  const payload = await appStoreConnectRequest(
    `/v1/builds?${query}`,
    credentialsFromEnvironment(env),
  );
  return selectBuildResources(payload, bundleVersion)[0] ?? null;
}

async function appPreflight(argv, env) {
  const bundleId = requiredOption(argv, '--bundle-id');
  const expectedName = requiredOption(argv, '--expected-name');
  const output = requiredOption(argv, '--output');
  const query = new URLSearchParams({
    'filter[bundleId]': bundleId,
    limit: '2',
  });
  const payload = await appStoreConnectRequest(
    `/v1/apps?${query}`,
    credentialsFromEnvironment(env),
  );
  const app = selectAppResource(payload, bundleId);
  if (app.attributes?.name !== expectedName) {
    throw new Error(
      `App Store Connect app ${bundleId} has name ${JSON.stringify(app.attributes?.name ?? null)}, not ${JSON.stringify(expectedName)}`,
    );
  }
  writeReceipt(output, {
    schemaVersion: 1,
    kind: 'app-store-connect-app-preflight',
    appId: app.id,
    bundleId,
    name: app.attributes?.name ?? null,
    sku: app.attributes?.sku ?? null,
    primaryLocale: app.attributes?.primaryLocale ?? null,
    observedAt: new Date().toISOString(),
  });
  const githubOutput = valueAfter(argv, '--github-output');
  if (githubOutput) {
    writeFileSync(githubOutput, `app_id=${app.id}\n`, { flag: 'a' });
  }
  const githubSummary = valueAfter(argv, '--github-summary');
  if (githubSummary) {
    appendFileSync(
      githubSummary,
      `App Store Connect app: **${app.attributes?.name ?? 'Unknown'}** (\`${bundleId}\`, app \`${app.id}\`)\n`,
    );
  }
  process.stdout.write(
    `App Store Connect app: ${app.attributes?.name ?? 'Unknown'} (${bundleId}, ${app.id})\n`,
  );
}

async function buildReceipt(argv, env) {
  const appId = requiredOption(argv, '--app-id');
  const bundleId = requiredOption(argv, '--bundle-id');
  const bundleVersion = requiredOption(argv, '--bundle-version');
  const sourceSha = requiredOption(argv, '--source-sha');
  const ipa = requiredOption(argv, '--ipa');
  const workflowRunUrl = requiredOption(argv, '--workflow-run-url');
  const output = requiredOption(argv, '--output');
  const deliveryMode = requiredOption(argv, '--delivery-mode');
  if (!['uploaded', 'reconciled'].includes(deliveryMode))
    throw new Error('--delivery-mode must be uploaded or reconciled');
  if (!SHA_PATTERN.test(sourceSha)) {
    throw new Error('--source-sha must be exactly 40 lowercase hex characters');
  }
  const build = await queryBuild({ appId, bundleVersion }, env);
  if (build?.attributes?.processingState !== 'VALID') {
    throw new Error(
      `App Store Connect build ${bundleVersion} is ${String(build?.attributes?.processingState ?? 'missing')}, not VALID`,
    );
  }
  const ipaSha256 = createHash('sha256')
    .update(readFileSync(ipa))
    .digest('hex');
  writeReceipt(output, {
    schemaVersion: 1,
    kind: 'testflight-build-receipt',
    provider: 'app-store-connect',
    appId,
    buildId: build.id,
    bundleId,
    bundleVersion,
    processingState: build.attributes.processingState,
    uploadedDate: build.attributes.uploadedDate ?? null,
    expirationDate: build.attributes.expirationDate ?? null,
    minOsVersion: build.attributes.minOsVersion ?? null,
    sourceSha,
    // An existing VALID build was uploaded by another run. Its provider bytes
    // are not downloadable through this API, so never label a newly rebuilt
    // local IPA as its digest or source provenance.
    ...(deliveryMode === 'uploaded'
      ? { ipaSha256, providerSourceSha: sourceSha }
      : {
          candidateIpaSha256: ipaSha256,
          providerIpaSha256: null,
          providerSourceSha: 'NOT_VERIFIED',
        }),
    deliveryMode,
    workflowRunUrl,
    observedAt: new Date().toISOString(),
  });
}

async function reconcileBuild(argv, env) {
  const appId = requiredOption(argv, '--app-id');
  const bundleVersion = requiredOption(argv, '--bundle-version');
  const output = requiredOption(argv, '--output');
  const authorityRef = requiredOption(argv, '--authority-ref');
  const authoritySha = requiredOption(argv, '--authority-sha');
  if (!SHA_PATTERN.test(authoritySha))
    throw new Error(
      '--authority-sha must be exactly 40 lowercase hex characters',
    );
  const build = await queryBuild({ appId, bundleVersion }, env);
  const processingState = build?.attributes?.processingState ?? 'ABSENT';
  if (!['ABSENT', 'PROCESSING', 'VALID'].includes(processingState)) {
    throw new Error(
      `App Store Connect build ${bundleVersion} is ${processingState}; refusing duplicate upload`,
    );
  }
  writeReceipt(output, {
    schemaVersion: 1,
    kind: 'testflight-build-reconciliation',
    appId,
    bundleVersion,
    buildId: build?.id ?? null,
    authorityRef,
    authoritySha,
    processingState,
    observedAt: new Date().toISOString(),
  });
  const githubOutput = valueAfter(argv, '--github-output');
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      `upload=${processingState === 'ABSENT'}\nprocessing_state=${processingState}\n`,
    );
  }
}

async function waitForValidBuild(argv, env) {
  const appId = requiredOption(argv, '--app-id');
  const bundleVersion = requiredOption(argv, '--bundle-version');
  const deadlineSeconds = Number(
    valueAfter(argv, '--deadline-seconds') ?? '1800',
  );
  if (
    !Number.isInteger(deadlineSeconds) ||
    deadlineSeconds < 30 ||
    deadlineSeconds > 3600
  )
    throw new Error('--deadline-seconds must be an integer from 30 to 3600');
  const deadline = Date.now() + deadlineSeconds * 1000;
  for (;;) {
    const build = await queryBuild({ appId, bundleVersion }, env);
    const state = build?.attributes?.processingState;
    if (state === 'VALID') return;
    if (state && state !== 'PROCESSING')
      throw new Error(
        `App Store Connect build ${bundleVersion} is ${state}, not VALID`,
      );
    if (Date.now() >= deadline)
      throw new Error(
        `App Store Connect build ${bundleVersion} did not become VALID before the deadline`,
      );
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

export function selectInternalGroup(payload, { appId, groupId, groupName }) {
  const groups = Array.isArray(payload?.data) ? payload.data : [];
  const group = groups.find((entry) => entry?.id === groupId);
  if (
    group?.type !== 'betaGroups' ||
    group?.attributes?.name !== groupName ||
    group?.attributes?.isInternalGroup !== true
  ) {
    throw new Error(
      `App Store Connect beta group ${groupId} is not the exact internal group for app ${appId}`,
    );
  }
  return group;
}

async function attachInternalGroup(argv, env) {
  const appId = requiredOption(argv, '--app-id');
  const buildId = requiredOption(argv, '--build-id');
  const groupId = requiredOption(argv, '--group-id');
  const groupName = requiredOption(argv, '--group-name');
  const output = requiredOption(argv, '--output');
  if (!/^[A-Za-z0-9-]+$/.test(groupId))
    throw new Error('--group-id must be an App Store Connect resource id');
  const groupQuery = new URLSearchParams({
    'filter[app]': appId,
    'filter[name]': groupName,
    limit: '2',
  });
  const payload = await appStoreConnectRequest(
    `/v1/betaGroups?${groupQuery}`,
    credentialsFromEnvironment(env),
  );
  selectInternalGroup(payload, { appId, groupId, groupName });
  const token = createAppStoreConnectJwt(credentialsFromEnvironment(env));
  const response = await fetch(
    new URL(
      `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`,
      API_ORIGIN,
    ),
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ data: [{ type: 'builds', id: buildId }] }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const text = await response.text();
  if (!response.ok && response.status !== 409)
    throw new Error(
      `App Store Connect beta-group assignment returned HTTP ${response.status}`,
    );
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
    throw new Error(
      'App Store Connect beta-group response exceeded the 1 MiB limit',
    );
  const relationships = await appStoreConnectRequest(
    `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds?limit=200`,
    credentialsFromEnvironment(env),
  );
  const attached = Array.isArray(relationships?.data)
    ? relationships.data.filter(
        (entry) => entry?.type === 'builds' && entry?.id === buildId,
      )
    : [];
  if (attached.length !== 1)
    throw new Error(
      `App Store Connect beta group ${groupId} does not contain build ${buildId} exactly once`,
    );
  writeReceipt(output, {
    schemaVersion: 1,
    kind: 'testflight-internal-group-assignment',
    appId,
    buildId,
    groupId,
    groupName,
    assignmentResponseStatus: response.status,
    observedAt: new Date().toISOString(),
  });
}

async function upsertWhatToTest(argv, env) {
  const buildId = requiredOption(argv, '--build-id');
  const whatsNew = requiredOption(argv, '--whats-new');
  const output = requiredOption(argv, '--output');
  const locale = valueAfter(argv, '--locale') ?? 'en-US';
  const credentials = credentialsFromEnvironment(env);
  const payload = await appStoreConnectRequest(
    `/v1/builds/${encodeURIComponent(buildId)}/betaBuildLocalizations?limit=200`,
    credentials,
  );
  const matches = Array.isArray(payload?.data)
    ? payload.data.filter(
        (entry) =>
          entry?.type === 'betaBuildLocalizations' &&
          entry?.attributes?.locale === locale,
      )
    : [];
  if (matches.length > 1)
    throw new Error(
      `App Store Connect build ${buildId} has ambiguous ${locale} What-to-Test localizations`,
    );
  let operation = 'unchanged';
  if (matches.length === 0) {
    await appStoreConnectMutation(
      '/v1/betaBuildLocalizations',
      credentials,
      'POST',
      {
        data: {
          type: 'betaBuildLocalizations',
          attributes: { locale, whatsNew },
          relationships: { build: { data: { type: 'builds', id: buildId } } },
        },
      },
    );
    operation = 'created';
  } else if (matches[0].attributes?.whatsNew !== whatsNew) {
    await appStoreConnectMutation(
      `/v1/betaBuildLocalizations/${encodeURIComponent(matches[0].id)}`,
      credentials,
      'PATCH',
      {
        data: {
          type: 'betaBuildLocalizations',
          id: matches[0].id,
          attributes: { whatsNew },
        },
      },
    );
    operation = 'updated';
  }
  writeReceipt(output, {
    schemaVersion: 1,
    kind: 'testflight-what-to-test',
    buildId,
    locale,
    whatsNew,
    operation,
    observedAt: new Date().toISOString(),
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const command = argv[0];
  if (command === 'app-preflight') return appPreflight(argv.slice(1), env);
  if (command === 'build-receipt') return buildReceipt(argv.slice(1), env);
  if (command === 'reconcile-build') return reconcileBuild(argv.slice(1), env);
  if (command === 'wait-for-valid-build')
    return waitForValidBuild(argv.slice(1), env);
  if (command === 'attach-internal-group')
    return attachInternalGroup(argv.slice(1), env);
  if (command === 'upsert-what-to-test')
    return upsertWhatToTest(argv.slice(1), env);
  throw new Error(
    'usage: app-store-connect-receipt.mjs <app-preflight|build-receipt|reconcile-build|wait-for-valid-build|attach-internal-group> [options]',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
