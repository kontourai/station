#!/usr/bin/env node
/**
 * Tagged-release Windows Authenticode policy (#3591).
 *
 * Owner decision 2026-11-13: until publisher signing is provisioned, a tagged
 * release ships the Windows MSI without an Authenticode signature, as Nightly
 * already does. The unsigned state is never silent: `release.yml` records it
 * in a receipt bound to the MSI bytes, the release inventory derives its
 * Windows `platformSigning` claim from that receipt, and publish-release.yml
 * revalidates both. Tauri updater signing stays mandatory either way.
 *
 * The receipt states reuse Nightly's vocabulary (`VERIFIED` / `NOT_SIGNED`,
 * see windows-nightly.mjs). release.yml's PowerShell step only observes: it
 * writes what `Get-AuthenticodeSignature` returned for the MSI (status,
 * signer thumbprint, MSI hash) to a JSON file, and every decision about which
 * observation each mode accepts is made here. Configured signing authority must sign or fail:
 * a partial certificate pair refuses, and so does `WINDOWS_SIGN_COMMAND`,
 * which Nightly honours but the tagged path does not implement yet.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { invokedDirectly } from './module-entry.mjs';

const KIND = 'station.windows-release-signing/v1';
const SHA = /^[0-9a-f]{40}$/;
const CHECKSUM = /^[0-9a-f]{64}$/;
const THUMBPRINT = /^[0-9A-F]{40}$/;
const STATES = {
  certificate: {
    authenticodeStatus: 'Valid',
    platformSigningState: 'VERIFIED',
  },
  unsigned: {
    authenticodeStatus: 'NotSigned',
    platformSigningState: 'NOT_SIGNED',
  },
};
const OBSERVATION_KEYS = [
  'authenticodeStatus',
  'installer',
  'installerSha256',
  'signerThumbprint',
  'statusMessage',
];
/** The inventory claim each receipt state maps to. */
const INVENTORY_CLAIMS = {
  VERIFIED: { state: 'signed', proof: 'platform-signature' },
  NOT_SIGNED: { state: 'unsigned', proof: 'not-applicable' },
};

function fail(message) {
  throw new Error(`Windows release signing: ${message}`);
}

function configured(env, name) {
  return typeof env[name] === 'string' && env[name].trim() !== '';
}

/**
 * Decide the signing mode from the protected environment.
 * @returns {'certificate' | 'unsigned'}
 */
export function windowsReleaseSigningMode(env) {
  if (configured(env, 'WINDOWS_SIGN_COMMAND'))
    fail(
      'WINDOWS_SIGN_COMMAND is configured, but tagged releases support only the WINDOWS_CERTIFICATE_BASE64/WINDOWS_CERTIFICATE_PASSWORD route; refusing to ship an unsigned installer while signing authority is configured (#3591)',
    );
  const certificate = configured(env, 'WINDOWS_CERTIFICATE_BASE64');
  const password = configured(env, 'WINDOWS_CERTIFICATE_PASSWORD');
  if (certificate && password) return 'certificate';
  if (!certificate && !password) return 'unsigned';
  fail(
    `only ${certificate ? 'WINDOWS_CERTIFICATE_BASE64' : 'WINDOWS_CERTIFICATE_PASSWORD'} is configured; configure both to sign or neither to ship unsigned`,
  );
}

export function windowsSigningReceiptAsset(tag) {
  return `station-${tag}-windows-x86_64-signing.json`;
}

/**
 * Refuse anything but the exact record release.yml's observation step writes:
 * `Get-AuthenticodeSignature`'s status name, its signer's thumbprint (null
 * when there is no signer certificate) and the observed MSI's SHA-256.
 */
export function parseWindowsAuthenticodeObservation(observation) {
  if (
    !observation ||
    typeof observation !== 'object' ||
    Array.isArray(observation) ||
    JSON.stringify(Object.keys(observation).sort()) !==
      JSON.stringify(OBSERVATION_KEYS) ||
    typeof observation.authenticodeStatus !== 'string' ||
    observation.authenticodeStatus === '' ||
    typeof observation.installer !== 'string' ||
    !CHECKSUM.test(observation.installerSha256 ?? '') ||
    !(
      observation.signerThumbprint === null ||
      typeof observation.signerThumbprint === 'string'
    ) ||
    !(
      observation.statusMessage === null ||
      typeof observation.statusMessage === 'string'
    )
  )
    fail('Authenticode observation is malformed');
  return observation;
}

/**
 * The signing policy: certificate mode accepts only a Valid signature by the
 * certificate release.yml imported; unsigned mode accepts only NotSigned with
 * no signer. Every other status (HashMismatch, NotTrusted, UnknownError, ...)
 * refuses in both modes.
 * @param {object} options
 * @param {string} options.mode
 * @param {ReturnType<typeof parseWindowsAuthenticodeObservation>} options.observation
 * @param {string | null} [options.expectedThumbprint]
 */
export function decideWindowsAuthenticode({
  mode,
  observation,
  expectedThumbprint = null,
}) {
  const expected = STATES[mode];
  if (!expected) fail(`unknown signing mode ${JSON.stringify(mode)}`);
  const observed = parseWindowsAuthenticodeObservation(observation);
  if (observed.authenticodeStatus !== expected.authenticodeStatus)
    fail(
      `${mode} mode requires Authenticode status ${expected.authenticodeStatus}, observed ${JSON.stringify(observed.authenticodeStatus)}${observed.statusMessage ? ` (${observed.statusMessage})` : ''}`,
    );
  if (mode === 'certificate') {
    if (!THUMBPRINT.test(expectedThumbprint ?? ''))
      fail(
        'certificate mode requires the imported release certificate thumbprint',
      );
    if (observed.signerThumbprint !== expectedThumbprint)
      fail(
        `the MSI is signed by ${JSON.stringify(observed.signerThumbprint)}, not the imported release certificate ${expectedThumbprint}`,
      );
  } else if (observed.signerThumbprint !== null) {
    fail(
      `unsigned mode observed signer ${JSON.stringify(observed.signerThumbprint)}`,
    );
  }
  return {
    authenticodeStatus: observed.authenticodeStatus,
    platformSigningState: expected.platformSigningState,
    signerThumbprint: mode === 'certificate' ? observed.signerThumbprint : null,
    installerSha256: observed.installerSha256,
  };
}

/**
 * Bind the decided Authenticode observation to the release and MSI bytes.
 * @param {object} options
 * @param {string} options.tag
 * @param {string} options.sourceSha
 * @param {string} options.mode
 * @param {ReturnType<typeof parseWindowsAuthenticodeObservation>} options.observation
 * @param {string | null} [options.expectedThumbprint]
 * @param {string} options.installer
 * @param {string} options.installerSha256
 */
export function createWindowsReleaseSigningReceipt({
  tag,
  sourceSha,
  mode,
  observation,
  expectedThumbprint = null,
  installer,
  installerSha256,
}) {
  const decision = decideWindowsAuthenticode({
    mode,
    observation,
    expectedThumbprint,
  });
  if (decision.installerSha256 !== installerSha256)
    fail(
      `the Authenticode observation is for MSI sha256 ${decision.installerSha256}, not the staged installer ${installerSha256}`,
    );
  const receipt = {
    kind: KIND,
    tag,
    sourceSha,
    platform: 'windows-x86_64',
    installer,
    installerSha256,
    signingMode: mode,
    authenticodeStatus: decision.authenticodeStatus,
    platformSigningState: decision.platformSigningState,
    signerThumbprint: decision.signerThumbprint,
  };
  assertWindowsReleaseSigningReceipt(receipt, {
    tag,
    sourceSha,
    installerSha256,
  });
  return receipt;
}

/** Refuse any receipt that does not bind this release and these MSI bytes. */
export function assertWindowsReleaseSigningReceipt(
  receipt,
  { tag, sourceSha, installerSha256 },
) {
  const expected = STATES[receipt?.signingMode];
  const keys = [
    'authenticodeStatus',
    'installer',
    'installerSha256',
    'kind',
    'platform',
    'platformSigningState',
    'signerThumbprint',
    'signingMode',
    'sourceSha',
    'tag',
  ];
  if (
    !receipt ||
    JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(keys) ||
    receipt.kind !== KIND ||
    receipt.tag !== tag ||
    !SHA.test(receipt.sourceSha ?? '') ||
    receipt.sourceSha !== sourceSha ||
    receipt.platform !== 'windows-x86_64' ||
    receipt.installer !== `station-${tag}-windows-x86_64.msi` ||
    !CHECKSUM.test(receipt.installerSha256 ?? '') ||
    receipt.installerSha256 !== installerSha256 ||
    !expected ||
    receipt.authenticodeStatus !== expected.authenticodeStatus ||
    receipt.platformSigningState !== expected.platformSigningState ||
    (receipt.signingMode === 'certificate'
      ? !THUMBPRINT.test(receipt.signerThumbprint ?? '')
      : receipt.signerThumbprint !== null)
  )
    fail('signing receipt does not bind this release installer');
  return receipt;
}

export function windowsPlatformSigningClaim(receipt) {
  const claim = INVENTORY_CLAIMS[receipt?.platformSigningState];
  if (!claim) fail('signing receipt has no platform signing state');
  return { ...claim };
}

/** Every claim a Windows variant may make; the receipt picks one. */
export function windowsPlatformSigningClaims() {
  return Object.values(INVENTORY_CLAIMS).map((claim) => ({ ...claim }));
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) fail(`missing ${name}`);
  return argv[index + 1];
}

function optional(argv, name) {
  return argv.includes(name) ? option(argv, name) : null;
}

function readObservation(argv) {
  const path = option(argv, '--observation');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(
      `cannot read Authenticode observation ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function summary(mode) {
  return mode === 'certificate'
    ? 'Windows Authenticode: signing with the configured certificate; the MSI must verify as Valid.'
    : 'Windows Authenticode: NOT_SIGNED. No Windows signing credentials are configured, so this tagged MSI ships without a publisher signature and SmartScreen warns on first run (#3591). The Tauri updater signature is still required.';
}

if (invokedDirectly(import.meta.url)) {
  try {
    const [command, ...argv] = process.argv.slice(2);
    if (command === 'mode') {
      const mode = windowsReleaseSigningMode(process.env);
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary(mode)}\n`);
      console.log(`mode=${mode}`);
    } else if (command === 'check') {
      const decision = decideWindowsAuthenticode({
        mode: option(argv, '--mode'),
        observation: readObservation(argv),
        expectedThumbprint: optional(argv, '--expected-thumbprint'),
      });
      console.log(
        `Windows Authenticode ${decision.authenticodeStatus} accepted: platformSigningState=${decision.platformSigningState}`,
      );
    } else if (command === 'receipt') {
      const installer = option(argv, '--installer');
      const receipt = createWindowsReleaseSigningReceipt({
        tag: option(argv, '--tag'),
        sourceSha: option(argv, '--sha'),
        mode: option(argv, '--mode'),
        observation: readObservation(argv),
        expectedThumbprint: optional(argv, '--expected-thumbprint'),
        installer: basename(installer),
        installerSha256: createHash('sha256')
          .update(readFileSync(installer))
          .digest('hex'),
      });
      writeFileSync(
        option(argv, '--output'),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
      console.log(
        `Windows platformSigningState=${receipt.platformSigningState}`,
      );
    } else {
      fail(
        'usage: windows-release-signing.mjs <mode | check --mode --observation [--expected-thumbprint] | receipt --tag --sha --mode --observation [--expected-thumbprint] --installer --output>',
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
