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
  const matches = Array.isArray(payload?.data)
    ? payload.data.filter(
        (entry) =>
          entry?.type === 'builds' &&
          entry?.attributes?.version === bundleVersion,
      )
    : [];
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

async function appPreflight(argv, env) {
  const bundleId = requiredOption(argv, '--bundle-id');
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
  if (!SHA_PATTERN.test(sourceSha)) {
    throw new Error('--source-sha must be exactly 40 lowercase hex characters');
  }
  const query = new URLSearchParams({
    'filter[app]': appId,
    'filter[version]': bundleVersion,
    limit: '2',
  });
  const payload = await appStoreConnectRequest(
    `/v1/builds?${query}`,
    credentialsFromEnvironment(env),
  );
  const build = selectProcessedBuildResource(payload, bundleVersion);
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
    ipaSha256,
    workflowRunUrl,
    observedAt: new Date().toISOString(),
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const command = argv[0];
  if (command === 'app-preflight') return appPreflight(argv.slice(1), env);
  if (command === 'build-receipt') return buildReceipt(argv.slice(1), env);
  throw new Error(
    'usage: app-store-connect-receipt.mjs <app-preflight|build-receipt> [options]',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
