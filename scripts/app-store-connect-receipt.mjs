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

/** The first few provider error details, never the request or a credential. */
export function appStoreConnectErrorDetail(payload) {
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return '';
    }
  }
  return Array.isArray(payload?.errors)
    ? payload.errors
        .slice(0, 3)
        .map((entry) => entry?.detail || entry?.title || entry?.code)
        .filter((entry) => typeof entry === 'string' && entry.length > 0)
        .map((entry) => entry.slice(0, 300))
        .join('; ')
    : '';
}

/**
 * Resolves a request path, or an absolute URL such as a collection's
 * `links.next`, against the provider origin and refuses anything else. A
 * URL parsed with a base keeps its own origin when it is absolute, so the
 * check is what stops a response body from redirecting the bearer token.
 */
export function resolveAppStoreConnectUrl(pathOrUrl) {
  let url;
  try {
    url = new URL(pathOrUrl, API_ORIGIN);
  } catch {
    throw new Error('App Store Connect request URL is malformed');
  }
  if (url.origin !== API_ORIGIN || url.username || url.password) {
    throw new Error(`App Store Connect request must stay on ${API_ORIGIN}`);
  }
  return url;
}

export async function appStoreConnectRequest(
  path,
  credentials,
  fetchImpl = fetch,
) {
  const url = resolveAppStoreConnectUrl(path);
  const token = createAppStoreConnectJwt(credentials);
  const response = await fetchImpl(url, {
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
    const detail = appStoreConnectErrorDetail(payload);
    throw new Error(
      `App Store Connect returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  return payload;
}

async function appStoreConnectMutation(path, credentials, method, body) {
  const response = await fetch(resolveAppStoreConnectUrl(path), {
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
  const artifactManifestPath = requiredOption(argv, '--artifact-manifest');
  const deliveryMode = requiredOption(argv, '--delivery-mode');
  if (!['uploaded', 'reconciled'].includes(deliveryMode))
    throw new Error('--delivery-mode must be uploaded or reconciled');
  if (!SHA_PATTERN.test(sourceSha)) {
    throw new Error('--source-sha must be exactly 40 lowercase hex characters');
  }
  const artifactManifest = readArtifactManifest(artifactManifestPath);
  if (artifactManifest.sha !== sourceSha)
    throw new Error('--artifact-manifest sha must equal --source-sha');
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
      ? {
          ipaSha256,
          providerSourceSha: sourceSha,
          ...receiptArtifactProvenance(deliveryMode, artifactManifest.builtAt),
        }
      : {
          candidateIpaSha256: ipaSha256,
          providerIpaSha256: null,
          providerSourceSha: 'NOT_VERIFIED',
          ...receiptArtifactProvenance(deliveryMode, artifactManifest.builtAt),
        }),
    deliveryMode,
    workflowRunUrl,
    observedAt: new Date().toISOString(),
  });
}

/** Never attribute a rebuilt candidate's time to an existing provider build. */
export function receiptArtifactProvenance(
  deliveryMode,
  candidateArtifactBuiltAt,
) {
  assertCanonicalArtifactBuiltAt(candidateArtifactBuiltAt);
  if (deliveryMode === 'uploaded') {
    return {
      candidateArtifactBuiltAt,
      providerArtifactBuiltAt: candidateArtifactBuiltAt,
    };
  }
  if (deliveryMode === 'reconciled') {
    return {
      candidateArtifactBuiltAt,
      providerArtifactBuiltAt: null,
    };
  }
  throw new Error('delivery mode must be uploaded or reconciled');
}

export function readArtifactManifest(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('--artifact-manifest must be a readable JSON file');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof parsed.sha !== 'string' ||
    !SHA_PATTERN.test(parsed.sha) ||
    !validArtifactBuiltAt(parsed.builtAt)
  )
    throw new Error(
      '--artifact-manifest must contain canonical sha and builtAt',
    );
  return { sha: parsed.sha, builtAt: parsed.builtAt };
}

function validArtifactBuiltAt(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  return new Date(parsed).toISOString() === canonical;
}

/** Publicly testable validation for immutable artifact timestamps. */
export function assertCanonicalArtifactBuiltAt(value) {
  if (!validArtifactBuiltAt(value)) {
    throw new Error(
      '--artifact-built-at must be a canonical ISO 8601 UTC timestamp',
    );
  }
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
  // hasAccessToAllBuilds decides whether membership is automatic (the
  // provider refuses a manual POST with HTTP 422) or must be assigned. A
  // missing or non-boolean value is not a default; it is an unknown shape.
  if (typeof group.attributes.hasAccessToAllBuilds !== 'boolean') {
    throw new Error(
      `App Store Connect beta group ${groupId} does not report hasAccessToAllBuilds as a boolean`,
    );
  }
  return group;
}

const MEMBERSHIP_POLL_MS = 10_000;
const MEMBERSHIP_PAGE_LIMIT = 200;
const MEMBERSHIP_MAX_PAGES = 10;

function membershipRelationshipPath(groupId) {
  return `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`;
}

/** The identity of a page for loop detection: path and query, never the hash. */
function membershipPageKey(url) {
  return `${url.pathname}${url.search}`;
}

/**
 * The next page of a group's build relationship, or null on the last page.
 * A collection response carries `links: { self, next? }`; `next` is data
 * from the provider body, so it is followed only when it is an absolute URL
 * on the provider origin for this same group's relationship. A link to a
 * page this walk has already read (compared without its fragment) is a
 * loop, refused with its own text so it is never misread as a group larger
 * than the cap. Anything else fails closed (#1782).
 */
export function selectMembershipNextPage(payload, { groupId, visited }) {
  const next = payload?.links?.next;
  if (next === undefined || next === null) return null;
  const expectedPath = membershipRelationshipPath(groupId);
  let url = null;
  if (typeof next === 'string') {
    try {
      url = new URL(next);
    } catch {
      url = null;
    }
  }
  if (
    !url ||
    url.origin !== API_ORIGIN ||
    url.username ||
    url.password ||
    url.pathname !== expectedPath
  ) {
    throw new Error(
      `App Store Connect beta group ${groupId} returned a next-page link that is not ${API_ORIGIN}${expectedPath}; refusing to follow it`,
    );
  }
  if (visited.has(membershipPageKey(url))) {
    throw new Error(
      `App Store Connect beta group ${groupId} links.next repeats a page already read; refusing to follow it`,
    );
  }
  return url.href;
}

/**
 * One walk of the group's build list: page by page until the build is
 * listed, the pages run out, or the page cap is reached. Stopping at the
 * first page that lists the build keeps a group larger than the cap working
 * whenever the build is inside the walked prefix; the cap fails closed with
 * its own text, since another poll cannot reveal pages this reader will not
 * read. The cap assumes a build that has not yet propagated to a group of
 * more than MEMBERSHIP_MAX_PAGES pages is absent from the walked prefix, so
 * it trips the cap before its bounded wait; the provider's ordering is
 * unspecified, and the failure is loud either way. The duplicate refusal can
 * only observe a build listed twice on one page: the walk returns at the
 * first page that lists the build, so no later page is read.
 */
async function readGroupMembership(
  { appId, buildId, groupId, groupName },
  env,
) {
  const credentials = credentialsFromEnvironment(env);
  let url = `${API_ORIGIN}${membershipRelationshipPath(groupId)}?limit=${MEMBERSHIP_PAGE_LIMIT}`;
  const visited = new Set();
  let pagesRead = 0;
  let buildsListed = 0;
  let attached = 0;
  for (;;) {
    visited.add(membershipPageKey(new URL(url)));
    const page = await appStoreConnectRequest(url, credentials);
    pagesRead += 1;
    const entries = Array.isArray(page?.data) ? page.data : [];
    buildsListed += entries.length;
    attached += entries.filter(
      (entry) => entry?.type === 'builds' && entry?.id === buildId,
    ).length;
    if (attached > 1)
      throw new Error(
        `App Store Connect beta group ${groupId} lists build ${buildId} ${attached} times`,
      );
    if (attached === 1) return { found: true, pagesRead, buildsListed };
    const next = selectMembershipNextPage(page, { groupId, visited });
    if (next === null) return { found: false, pagesRead, buildsListed };
    if (pagesRead >= MEMBERSHIP_MAX_PAGES)
      throw new Error(
        `build ${buildId} was not found in the first ${buildsListed} builds (${pagesRead} pages) of App Store Connect beta group ${groupName} (${groupId}) for app ${appId}; the group lists more pages than this reader walks`,
      );
    url = next;
  }
}

/**
 * Reads the group's build list until it lists the build exactly once or the
 * deadline passes. A freshly processed build can take a moment to appear in
 * a group that receives every build automatically. Each poll re-walks the
 * pages; the result reports what the successful walk read.
 */
async function waitForGroupMembership(membership, env, { sleep, now }) {
  const { appId, buildId, groupId, groupName, deadline } = membership;
  for (;;) {
    const read = await readGroupMembership(membership, env);
    if (read.found) return read;
    if (now() >= deadline)
      throw new Error(
        `App Store Connect beta group ${groupName} (${groupId}) for app ${appId} does not contain build ${buildId} before the deadline; the last read listed ${read.buildsListed} builds across ${read.pagesRead} pages`,
      );
    await sleep(MEMBERSHIP_POLL_MS);
  }
}

export async function attachInternalGroup(
  argv,
  env,
  {
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = {},
) {
  const appId = requiredOption(argv, '--app-id');
  const buildId = requiredOption(argv, '--build-id');
  const groupId = requiredOption(argv, '--group-id');
  const groupName = requiredOption(argv, '--group-name');
  const output = requiredOption(argv, '--output');
  if (!/^[A-Za-z0-9-]+$/.test(groupId))
    throw new Error('--group-id must be an App Store Connect resource id');
  const deadlineSeconds = Number(
    valueAfter(argv, '--deadline-seconds') ?? '60',
  );
  if (
    !Number.isInteger(deadlineSeconds) ||
    deadlineSeconds < 10 ||
    deadlineSeconds > 600
  )
    throw new Error('--deadline-seconds must be an integer from 10 to 600');
  const groupQuery = new URLSearchParams({
    'filter[app]': appId,
    'filter[name]': groupName,
    limit: '2',
  });
  const payload = await appStoreConnectRequest(
    `/v1/betaGroups?${groupQuery}`,
    credentialsFromEnvironment(env),
  );
  const group = selectInternalGroup(payload, { appId, groupId, groupName });
  const hasAccessToAllBuilds = group.attributes.hasAccessToAllBuilds;
  const deadline = now() + deadlineSeconds * 1000;
  const membership = { appId, buildId, groupId, groupName, deadline };
  if (hasAccessToAllBuilds) {
    // An internal group with access to all builds receives every build
    // automatically and refuses manual attachment (#1777). Membership is
    // derived from the group's build list, never asserted by a POST.
    const read = await waitForGroupMembership(membership, env, { sleep, now });
    writeReceipt(output, {
      schemaVersion: 1,
      kind: 'testflight-internal-group-assignment',
      appId,
      buildId,
      groupId,
      groupName,
      membership: 'automatic',
      hasAccessToAllBuilds,
      assignmentResponseStatus: null,
      membershipPagesRead: read.pagesRead,
      membershipBuildsListed: read.buildsListed,
      observedAt: new Date().toISOString(),
    });
    return;
  }
  const token = createAppStoreConnectJwt(credentialsFromEnvironment(env));
  const response = await fetch(
    resolveAppStoreConnectUrl(membershipRelationshipPath(groupId)),
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
  if (!response.ok && response.status !== 409) {
    // 409 is the idempotent "already a member" answer. Anything else names
    // its cause from the provider body (export compliance, build state, a
    // group that is not this app's), which the log otherwise never shows.
    const detail = appStoreConnectErrorDetail(
      Buffer.byteLength(text) > MAX_RESPONSE_BYTES ? '' : text,
    );
    throw new Error(
      `App Store Connect beta-group assignment returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
    throw new Error(
      'App Store Connect beta-group response exceeded the 1 MiB limit',
    );
  const read = await waitForGroupMembership(membership, env, { sleep, now });
  writeReceipt(output, {
    schemaVersion: 1,
    kind: 'testflight-internal-group-assignment',
    appId,
    buildId,
    groupId,
    groupName,
    membership: 'assigned',
    hasAccessToAllBuilds,
    assignmentResponseStatus: response.status,
    membershipPagesRead: read.pagesRead,
    membershipBuildsListed: read.buildsListed,
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
