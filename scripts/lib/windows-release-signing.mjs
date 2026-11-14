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
 * see windows-nightly.mjs). Configured signing authority must sign or fail:
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

/** Bind the observed Authenticode status to the mode and the MSI bytes. */
export function createWindowsReleaseSigningReceipt({
  tag,
  sourceSha,
  mode,
  authenticodeStatus,
  signerThumbprint,
  installer,
  installerSha256,
}) {
  const expected = STATES[mode];
  if (!expected) fail(`unknown signing mode ${JSON.stringify(mode)}`);
  if (authenticodeStatus !== expected.authenticodeStatus)
    fail(
      `${mode} mode requires Authenticode status ${expected.authenticodeStatus}, observed ${JSON.stringify(authenticodeStatus)}`,
    );
  const thumbprint = mode === 'certificate' ? signerThumbprint : null;
  if (mode === 'certificate' && !THUMBPRINT.test(thumbprint ?? ''))
    fail('a valid signature must name its signer thumbprint');
  const receipt = {
    kind: KIND,
    tag,
    sourceSha,
    platform: 'windows-x86_64',
    installer,
    installerSha256,
    signingMode: mode,
    authenticodeStatus,
    platformSigningState: expected.platformSigningState,
    signerThumbprint: thumbprint,
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
    } else if (command === 'receipt') {
      const installer = option(argv, '--installer');
      const receipt = createWindowsReleaseSigningReceipt({
        tag: option(argv, '--tag'),
        sourceSha: option(argv, '--sha'),
        mode: option(argv, '--mode'),
        authenticodeStatus: option(argv, '--authenticode-status'),
        signerThumbprint: argv.includes('--signer-thumbprint')
          ? option(argv, '--signer-thumbprint')
          : null,
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
        'usage: windows-release-signing.mjs <mode|receipt --tag --sha --mode --authenticode-status [--signer-thumbprint] --installer --output>',
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
