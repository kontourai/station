#!/usr/bin/env node
import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NIGHTLY_BUILDS_PER_DAY } from './lib/nightly-build-identity.mjs';
import { verifyTauriUpdaterSignature } from './lib/release-artifacts.mjs';
import {
  canonicalJson,
  createArtifactRecord,
  parseVerificationCandidate,
} from './release-cohort.mjs';

const REPOSITORY = 'kontourai/station';
const NIGHTLY_WORKFLOW = `${REPOSITORY}/.github/workflows/nightly.yml`;
const NIGHTLY_SOURCE_REF = 'refs/heads/main';
const NIGHTLY_CERT_IDENTITY = `https://github.com/${NIGHTLY_WORKFLOW}@${NIGHTLY_SOURCE_REF}`;
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const SHA256 = /^[a-f0-9]{64}$/;
const PLAY_ADAPTER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'query-google-play-release.mjs',
);
const MACOS_NIGHTLY_ASSETS = Object.freeze([
  'latest.json',
  'station-nightly-desktop-macos-aarch64.app.tar.gz',
  'station-nightly-desktop-macos-aarch64.app.tar.gz.sig',
  'station-nightly-desktop-macos-aarch64.dmg',
]);
const fail = (message) => {
  throw new Error(`release cohort verification failed: ${message}`);
};
const plain = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const digest = (value) =>
  `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const text = (value, label) => {
  if (typeof value !== 'string' || !value) fail(`${label} is invalid`);
  return value;
};
const iso = (value) => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    fail('observation timestamp is invalid');
  return value;
};

function output(result, label) {
  if (result?.error) fail(`${label} could not start: ${result.error.message}`);
  if (result?.status !== 0 || result?.signal)
    fail(`${label} did not succeed: ${String(result?.stderr ?? '').trim()}`);
  return String(result.stdout ?? '');
}
function jsonOutput(result, label) {
  const raw = output(result, label);
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${label} returned malformed JSON`);
  }
}
export function ghAttestationArgs(path, sourceSha) {
  return [
    'attestation',
    'verify',
    path,
    '--repo',
    REPOSITORY,
    '--source-ref',
    NIGHTLY_SOURCE_REF,
    '--source-digest',
    sourceSha,
    '--cert-identity',
    NIGHTLY_CERT_IDENTITY,
    '--cert-oidc-issuer',
    OIDC_ISSUER,
    '--deny-self-hosted-runners',
    '--format',
    'json',
  ];
}

/** Parses only authenticated certificate facts and the verified subject. */
export function parseVerifiedAttestation(
  entries,
  record,
  sourceSha,
  workflowRunId,
  now,
) {
  if (!Array.isArray(entries) || entries.length < 1)
    fail('attestation verifier returned no entries');
  const matching = entries.filter((entry) => {
    const result = entry?.verificationResult;
    const certificate = result?.signature?.certificate;
    const subjects = result?.statement?.subject;
    const timestamps = result?.verifiedTimestamps;
    if (
      !plain(certificate) ||
      !Array.isArray(subjects) ||
      !Array.isArray(timestamps) ||
      timestamps.length < 1
    )
      return false;
    const invocation = certificate.runInvocationURI;
    const invocationPattern = new RegExp(
      `^https://github\\.com/${REPOSITORY}/actions/runs/${workflowRunId}(?:/attempts/[1-9][0-9]*)?$`,
    );
    const certificateMatches =
      certificate.subjectAlternativeName === NIGHTLY_CERT_IDENTITY &&
      typeof certificate.certificateIssuer === 'string' &&
      certificate.certificateIssuer &&
      certificate.issuer === OIDC_ISSUER &&
      invocationPattern.test(invocation ?? '');
    const timestampsMatch = timestamps.every(
      (timestamp) =>
        plain(timestamp) &&
        canonicalJson(Object.keys(timestamp).sort()) ===
          canonicalJson(['timestamp', 'type', 'uri']) &&
        typeof timestamp.type === 'string' &&
        timestamp.type &&
        typeof timestamp.uri === 'string' &&
        timestamp.uri &&
        typeof timestamp.timestamp === 'string' &&
        !Number.isNaN(Date.parse(timestamp.timestamp)) &&
        Date.parse(timestamp.timestamp) <= now.getTime() + 5_000 &&
        Date.parse(timestamp.timestamp) >= now.getTime() - 24 * 60 * 60_000,
    );
    const subjectMatches = subjects.filter(
      (subject) =>
        plain(subject) &&
        plain(subject.digest) &&
        subject.digest.sha256 === record.sha256,
    );
    return certificateMatches && timestampsMatch && subjectMatches.length === 1;
  });
  if (matching.length !== 1)
    fail(
      'attestation did not contain exactly one authenticated subject for staged bytes',
    );
  const entry = matching[0];
  return {
    repository: REPOSITORY,
    signerWorkflow: NIGHTLY_WORKFLOW,
    sourceRef: NIGHTLY_SOURCE_REF,
    sourceSha,
    oidcIssuer: OIDC_ISSUER,
    certificateIssuer:
      entry.verificationResult.signature.certificate.certificateIssuer,
    authenticatedWorkflowRunId: workflowRunId,
    runInvocationURI:
      entry.verificationResult.signature.certificate.runInvocationURI,
    subjectDigest: `sha256:${record.sha256}`,
    bundleDigest: digest(entry.attestation),
    verifiedTimestamps: entry.verificationResult.verifiedTimestamps,
    verifiedTimestampDigest: digest(
      entry.verificationResult.verifiedTimestamps,
    ),
  };
}

function requiredArtifactPaths(candidate, input) {
  if (!plain(input) || !plain(input.artifacts))
    fail('artifact input is malformed');
  const groups = input.artifacts;
  const result = [];
  for (const stage of candidate.stageClaims) {
    const values = groups[stage.platform];
    if (!plain(values)) fail(`artifact input has no ${stage.platform} group`);
    const expected = stage.artifacts.map((record) => record.name).sort();
    if (canonicalJson(Object.keys(values).sort()) !== canonicalJson(expected))
      fail(
        `artifact input does not exactly match staged ${stage.platform} assets`,
      );
    for (const record of stage.artifacts) {
      const path = text(
        values[record.name],
        `artifact path ${stage.platform}/${record.name}`,
      );
      const bytes = readFileSync(resolve(path));
      const actual = createArtifactRecord({ name: record.name, bytes });
      if (canonicalJson(actual) !== canonicalJson(record))
        fail(`artifact bytes drifted for ${stage.platform}/${record.name}`);
      result.push({ platform: stage.platform, record, path: resolve(path) });
    }
  }
  const android = candidate.stageClaims.find(
    (stage) => stage.platform === 'android',
  );
  const macos = candidate.stageClaims.find(
    (stage) => stage.platform === 'macos',
  );
  if (!android) fail('Android delivery inventory is missing');
  if (
    android.artifacts.length !== 1 ||
    !android.artifacts[0].name.endsWith('.aab')
  ) {
    fail('Android delivery inventory must contain exactly one AAB');
  }
  if (
    !macos ||
    canonicalJson(macos.artifacts.map((record) => record.name).sort()) !==
      canonicalJson(MACOS_NIGHTLY_ASSETS)
  ) {
    fail('macOS delivery inventory does not exactly match the Nightly assets');
  }
  return result;
}

export function assertNightlyVersionRelationship(identities) {
  const version = identities?.android?.versionName;
  const match = /-nightly\.([0-9]+)$/.exec(version ?? '');
  const day = match ? Number(match[1]) : Number.NaN;
  const androidCode = identities?.android?.versionCode;
  const desktopCode = Number(identities?.desktop?.bundleVersion);
  if (
    !Number.isSafeInteger(day) ||
    identities?.desktop?.version !== version ||
    !Number.isSafeInteger(androidCode) ||
    !Number.isSafeInteger(desktopCode) ||
    desktopCode !== day * NIGHTLY_BUILDS_PER_DAY ||
    Math.floor(androidCode / NIGHTLY_BUILDS_PER_DAY) !== day
  ) {
    fail(
      'Nightly Android/macOS version identities do not share one nightly-build identity',
    );
  }
  return {
    day,
    androidVersionCode: androidCode,
    desktopBundleVersion: desktopCode,
  };
}

export function parseAndroidManifestIdentity(manifest) {
  if (typeof manifest !== 'string')
    fail('apkanalyzer manifest output is invalid');
  const packageName = /\bpackage="([^"]+)"/.exec(manifest)?.[1];
  const versionCode = /\bandroid:versionCode="([0-9]+)"/.exec(manifest)?.[1];
  const versionName = /\bandroid:versionName="([^"]+)"/.exec(manifest)?.[1];
  if (!packageName || !versionCode || !versionName)
    fail('apkanalyzer manifest lacks package/version identity');
  return { packageName, versionCode: Number(versionCode), versionName };
}
function verifyAndroidAabIdentity(path, identity, apkanalyzer) {
  const outputText = output(
    defaultSpawnSync(apkanalyzer.apkanalyzerPath, ['manifest', 'print', path], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 60_000,
    }),
    'apkanalyzer Android identity verification',
  );
  const observed = parseAndroidManifestIdentity(outputText);
  if (canonicalJson(observed) !== canonicalJson(identity))
    fail('AAB manifest identity does not match the candidate');
  return observed;
}

export function parseMacosInfoPlist(json) {
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    fail('macOS Info.plist is not valid JSON');
  }
  if (
    !plain(value) ||
    typeof value.CFBundleIdentifier !== 'string' ||
    typeof value.CFBundleShortVersionString !== 'string' ||
    typeof value.CFBundleVersion !== 'string'
  ) {
    fail('macOS Info.plist lacks required string identity fields');
  }
  return {
    CFBundleIdentifier: value.CFBundleIdentifier,
    CFBundleShortVersionString: value.CFBundleShortVersionString,
    CFBundleVersion: value.CFBundleVersion,
  };
}
function verifyMacosArchive(path, identity) {
  if (process.platform !== 'darwin')
    fail(
      'macOS archive verification requires a protected macOS verifier runner',
    );
  const listing = output(
    defaultSpawnSync('tar', ['-tzf', path], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 60_000,
    }),
    'tar archive listing',
  )
    .split('\n')
    .filter(Boolean);
  const verbose = output(
    defaultSpawnSync('tar', ['-tvzf', path], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 60_000,
    }),
    'tar archive metadata listing',
  )
    .split('\n')
    .filter(Boolean);
  if (
    !listing.length ||
    listing.some(
      (entry) =>
        entry.startsWith('/') ||
        entry.split('/').includes('..') ||
        entry.includes('\\'),
    ) ||
    verbose.some((line) => ['l', 'h'].includes(line[0]))
  ) {
    fail('macOS updater archive has unsafe, symlink, or hardlink paths');
  }
  const plists = listing.filter((entry) =>
    entry.endsWith('.app/Contents/Info.plist'),
  );
  if (plists.length !== 1)
    fail('macOS updater archive must contain exactly one app Info.plist');
  const plist = output(
    defaultSpawnSync('tar', ['-xOzf', path, '--', plists[0]], {
      encoding: 'buffer',
      shell: false,
      windowsHide: true,
      timeout: 60_000,
    }),
    'tar Info.plist stdout extraction',
  );
  if (!plist.trim()) fail('macOS updater archive Info.plist is empty');
  const parsed = parseMacosInfoPlist(
    output(
      defaultSpawnSync(
        '/usr/bin/plutil',
        ['-convert', 'json', '-o', '-', '-'],
        {
          encoding: 'utf8',
          input: plist,
          shell: false,
          windowsHide: true,
          timeout: 30_000,
        },
      ),
      'plutil Info.plist conversion',
    ),
  );
  if (
    parsed.CFBundleIdentifier !== 'io.kontourai.station.nightly' ||
    parsed.CFBundleShortVersionString !== identity.version ||
    parsed.CFBundleVersion !== identity.bundleVersion
  ) {
    fail('macOS updater archive Info.plist does not match the candidate');
  }
}

export function parseGithubTagReference(reference, tag, sourceSha) {
  if (
    !plain(reference) ||
    reference.ref !== `refs/tags/${tag}` ||
    !plain(reference.object) ||
    reference.object.type !== 'commit' ||
    reference.object.sha !== sourceSha
  ) {
    fail('GitHub tag does not resolve to the exact cohort source SHA');
  }
  return {
    ref: reference.ref,
    objectType: reference.object.type,
    sourceSha: reference.object.sha,
  };
}

export function parseLatestUpdaterManifest(bytes, identity, signatureBytes) {
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    fail('latest.json is not valid JSON');
  }
  const platform = manifest?.platforms?.['darwin-aarch64'];
  const expectedUrl = `https://github.com/${REPOSITORY}/releases/download/${identity.releaseTag}/station-nightly-desktop-macos-aarch64.app.tar.gz`;
  if (
    !plain(manifest) ||
    manifest.version !== identity.version ||
    !plain(platform) ||
    platform.url !== expectedUrl ||
    typeof platform.signature !== 'string' ||
    platform.signature.trim() !==
      Buffer.from(signatureBytes).toString('utf8').trim()
  ) {
    fail(
      'latest.json does not bind the expected Nightly updater asset identity',
    );
  }
  return {
    version: manifest.version,
    url: platform.url,
    signatureDigest: `sha256:${createHash('sha256').update(signatureBytes).digest('hex')}`,
  };
}

export function parseGithubReleaseObservation(
  release,
  identity,
  records,
  tag,
  now,
) {
  if (!plain(release) || !Array.isArray(release.assets))
    fail('GitHub release response is malformed');
  if (
    release.tag_name !== identity.releaseTag ||
    release.draft !== false ||
    release.prerelease !== true ||
    !Number.isSafeInteger(release.id) ||
    release.id < 1 ||
    typeof release.url !== 'string' ||
    !release.url
  ) {
    fail('GitHub release does not bind the expected rolling tag');
  }
  if (
    typeof release.published_at !== 'string' ||
    Number.isNaN(Date.parse(release.published_at)) ||
    Date.parse(release.published_at) > now.getTime()
  ) {
    fail(
      'GitHub release published_at is missing, malformed, or from the future',
    );
  }
  if (
    canonicalJson(release.assets.map((asset) => asset?.name).sort()) !==
    canonicalJson(MACOS_NIGHTLY_ASSETS)
  ) {
    fail(
      'GitHub release assets do not exactly match the Nightly delivery inventory',
    );
  }
  const assets = [];
  for (const record of records) {
    const matches = release.assets.filter(
      (asset) => plain(asset) && asset.name === record.name,
    );
    if (matches.length !== 1)
      fail(`GitHub release asset ${record.name} is missing or duplicated`);
    const asset = matches[0];
    if (
      !Number.isSafeInteger(asset.id) ||
      asset.id < 1 ||
      asset.size !== record.size ||
      asset.digest !== `sha256:${record.sha256}` ||
      typeof asset.url !== 'string' ||
      !asset.url ||
      typeof asset.browser_download_url !== 'string' ||
      !asset.browser_download_url
    ) {
      fail(`GitHub release asset ${record.name} does not match staged bytes`);
    }
    assets.push({
      id: asset.id,
      name: asset.name,
      size: asset.size,
      digest: asset.digest,
      apiUrl: asset.url,
      downloadUrl: asset.browser_download_url,
    });
  }
  return {
    provider: 'github-releases',
    observedAt: iso(now.toISOString()),
    immutableReference: `github-release:${release.id}`,
    requested: {
      tag: identity.releaseTag,
      sourceSha: identity.sourceSha,
      version: identity.version,
      bundleVersion: identity.bundleVersion,
    },
    observed: {
      id: release.id,
      apiUrl: release.url,
      tag: release.tag_name,
      targetCommitish: release.target_commitish ?? null,
      tagReference: tag,
      publishedAt: release.published_at,
      assets,
    },
    rawResponseDigest: digest(release),
  };
}

function ghReleaseArgs(tag) {
  return [
    'api',
    `repos/${REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`,
    '--method',
    'GET',
  ];
}
function ghTagArgs(tag) {
  return [
    'api',
    `repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`,
    '--method',
    'GET',
  ];
}
function validatePlayObservation(identity, value, aab, before, after) {
  if (
    !plain(value) ||
    value.provider !== 'google-play' ||
    typeof value.immutableReference !== 'string' ||
    !value.immutableReference ||
    typeof value.adapterVersion !== 'string' ||
    !value.adapterVersion.startsWith('google-auth-library/') ||
    typeof value.observedAt !== 'string' ||
    Number.isNaN(Date.parse(value.observedAt)) ||
    !plain(value.requested) ||
    !plain(value.observed) ||
    !/^sha256:[a-f0-9]{64}$/.test(value.rawResponseDigest ?? '')
  ) {
    fail('Google Play adapter returned malformed observation');
  }
  const requested = value.requested;
  const observed = value.observed;
  const observedAt = Date.parse(value.observedAt);
  if (
    observedAt > after.getTime() + 5_000 ||
    observedAt < before.getTime() - 5_000
  ) {
    fail(
      'Google Play observation is stale or outside the verifier clock bound',
    );
  }
  if (
    requested.packageName !== identity.packageName ||
    requested.track !== 'internal' ||
    requested.versionCode !== identity.versionCode ||
    requested.versionName !== identity.versionName ||
    requested.status !== 'completed' ||
    observed.packageName !== identity.packageName ||
    observed.track !== 'internal' ||
    observed.versionCode !== identity.versionCode ||
    observed.versionName !== identity.versionName ||
    observed.status !== 'completed'
  ) {
    fail(
      'Google Play adapter observation does not bind the requested identity',
    );
  }
  if (
    typeof observed.bundleSha256 !== 'string' ||
    !SHA256.test(observed.bundleSha256) ||
    observed.bundleSha256 !== aab.sha256
  ) {
    fail('Google Play bundle SHA-256 does not bind the staged AAB');
  }
  return value;
}
function ghVersion(runner) {
  return output(
    runner('gh', ['--version'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 30_000,
    }),
    'gh --version',
  )
    .split('\n')[0]
    .trim();
}
function protectedVerifierToolVersions() {
  if (process.platform !== 'darwin')
    fail('protected release-cohort verification requires macOS');
  const apkanalyzerPath = process.env.STATION_APKANALYZER_PATH;
  const expectedApkanalyzerVersion = process.env.STATION_APKANALYZER_VERSION;
  if (!apkanalyzerPath || !expectedApkanalyzerVersion)
    fail(
      'STATION_APKANALYZER_PATH and STATION_APKANALYZER_VERSION are required',
    );
  const apkanalyzer = output(
    defaultSpawnSync(apkanalyzerPath, ['--version'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 30_000,
    }),
    'apkanalyzer prerequisite',
  )
    .trim()
    .split('\n')[0];
  const macos = output(
    defaultSpawnSync('sw_vers', ['-productVersion'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 30_000,
    }),
    'macOS verifier prerequisite',
  ).trim();
  if (apkanalyzer !== expectedApkanalyzerVersion || !macos)
    fail(
      'protected verifier prerequisite version does not match its protected identity',
    );
  return { apkanalyzer, apkanalyzerPath, macos };
}
function verifyCandidateObservations(candidateInput, artifactInput) {
  const runner = defaultSpawnSync;
  const protectedTools = protectedVerifierToolVersions();
  const candidate = parseVerificationCandidate(candidateInput);
  if (
    candidate.admission.plan.channel !== 'nightly' ||
    candidate.versionIdentities.android.packageName !==
      'io.kontourai.station.nightly' ||
    candidate.versionIdentities.desktop.releaseTag !== 'nightly-desktop'
  )
    fail(
      'only Nightly identities match the protected verifier source identity',
    );
  assertNightlyVersionRelationship(candidate.versionIdentities);
  const paths = requiredArtifactPaths(candidate, artifactInput);
  const androidAab = paths.find((artifact) => artifact.platform === 'android');
  if (!androidAab) fail('candidate is missing Android AAB delivery artifact');
  verifyAndroidAabIdentity(
    androidAab.path,
    candidate.versionIdentities.android,
    protectedTools,
  );
  const artifacts = paths.map(({ platform, record, path }) => {
    const entries = jsonOutput(
      runner('gh', ghAttestationArgs(path, candidate.sourceSha), {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 60_000,
      }),
      `gh attestation verify ${basename(path)}`,
    );
    const attestationNow = new Date();
    return {
      platform,
      ...record,
      attestation: parseVerifiedAttestation(
        entries,
        record,
        candidate.sourceSha,
        candidate.workflowRunId,
        attestationNow,
      ),
    };
  });
  const playBefore = new Date();
  const android = validatePlayObservation(
    candidate.versionIdentities.android,
    jsonOutput(
      runner(
        process.execPath,
        [
          PLAY_ADAPTER,
          'query-json',
          canonicalJson(candidate.versionIdentities.android),
        ],
        {
          encoding: 'utf8',
          shell: false,
          windowsHide: true,
          timeout: 90_000,
        },
      ),
      'Google Play observation adapter',
    ),
    androidAab.record,
    playBefore,
    new Date(),
  );
  const macosRecords = candidate.stageClaims.find(
    (stage) => stage.platform === 'macos',
  )?.artifacts;
  if (!macosRecords) fail('candidate is missing macOS stage records');
  const macosPaths = new Map(
    paths
      .filter((artifact) => artifact.platform === 'macos')
      .map((artifact) => [artifact.record.name, artifact.path]),
  );
  const updaterPublicKeyFile = process.env.STATION_UPDATER_PUBLIC_KEY_FILE;
  if (typeof updaterPublicKeyFile !== 'string' || !updaterPublicKeyFile)
    fail(
      'STATION_UPDATER_PUBLIC_KEY_FILE is required on the protected verifier runner',
    );
  const updaterPath = macosPaths.get(
    'station-nightly-desktop-macos-aarch64.app.tar.gz',
  );
  const signaturePath = macosPaths.get(
    'station-nightly-desktop-macos-aarch64.app.tar.gz.sig',
  );
  if (!updaterPath || !signaturePath)
    fail('macOS updater/signature assets are missing');
  verifyTauriUpdaterSignature({
    updater: updaterPath,
    signature: signaturePath,
    updaterPublicKey: readFileSync(
      resolve(updaterPublicKeyFile),
      'utf8',
    ).trim(),
  });
  verifyMacosArchive(updaterPath, candidate.versionIdentities.desktop);
  parseLatestUpdaterManifest(
    readFileSync(
      macosPaths.get('latest.json') ?? fail('latest.json is missing'),
    ),
    candidate.versionIdentities.desktop,
    readFileSync(signaturePath),
  );
  const githubTag = parseGithubTagReference(
    jsonOutput(
      runner('gh', ghTagArgs(candidate.versionIdentities.desktop.releaseTag), {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 30_000,
      }),
      'gh api tag query',
    ),
    candidate.versionIdentities.desktop.releaseTag,
    candidate.sourceSha,
  );
  const githubReleasePayload = jsonOutput(
    runner(
      'gh',
      ghReleaseArgs(candidate.versionIdentities.desktop.releaseTag),
      {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 30_000,
      },
    ),
    'gh api release query',
  );
  const githubRelease = parseGithubReleaseObservation(
    githubReleasePayload,
    {
      ...candidate.versionIdentities.desktop,
      sourceSha: candidate.sourceSha,
    },
    macosRecords,
    githubTag,
    new Date(),
  );
  return {
    candidate,
    artifacts,
    providers: [android, githubRelease],
    observedAt: iso(new Date().toISOString()),
    gh: ghVersion(runner),
    protectedTools,
  };
}

const jsonFile = (path) => JSON.parse(readFileSync(resolve(path), 'utf8'));
async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3 || argv[0] !== 'verify-finalize')
    fail(
      'usage: verify-release-cohort.mjs verify-finalize <candidate.json> <artifacts.json>',
    );
  const observations = verifyCandidateObservations(
    jsonFile(argv[1]),
    jsonFile(argv[2]),
  );
  const googleAuthLibrary = observations.providers.find(
    (provider) => provider.provider === 'google-play',
  )?.adapterVersion;
  if (typeof googleAuthLibrary !== 'string')
    fail('Google Play adapter version is unavailable');
  const base = {
    kind: 'station.release-cohort-final/v1',
    state: 'complete',
    candidateContentDigest: observations.candidate.candidateContentDigest,
    cohortId: observations.candidate.cohortId,
    sourceSha: observations.candidate.sourceSha,
    authenticatedWorkflowRunId: observations.candidate.workflowRunId,
    versionIdentities: observations.candidate.versionIdentities,
    artifacts: observations.artifacts,
    providers: observations.providers,
    verifier: {
      workflowIdentity: `${NIGHTLY_WORKFLOW}@${NIGHTLY_SOURCE_REF}`,
      observedAt: observations.observedAt,
      toolVersions: {
        gh: observations.gh,
        googleAuthLibrary,
        ...observations.protectedTools,
        node: process.version,
      },
    },
  };
  const receipt = { ...base, finalContentDigest: digest(base) };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
