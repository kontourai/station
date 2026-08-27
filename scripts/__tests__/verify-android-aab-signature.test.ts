import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AabSignatureVerificationError,
  verifyAndroidAabSignature,
} from '../verify-android-aab-signature.mjs';
import {
  ApkSignatureVerificationError,
  verifyAndroidApkSignature,
} from '../verify-android-apk-signature.mjs';

const root = resolve(import.meta.dirname, '../..');
const verifier = resolve(root, 'scripts/verify-android-aab-signature.mjs');
const fixtureRoots: string[] = [];
const PASSWORD = 'fixture-signing-password';
let fixture: ReturnType<typeof createFixture>;

function run(command: string, args: string[], cwd?: string) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'station-aab-signature-'));
  fixtureRoots.push(directory);
  const content = join(directory, 'content');
  const unsignedEntry = join(directory, 'unsigned-entry');
  const signingStore = join(directory, 'signing.p12');
  const trustStore = join(directory, 'trust.p12');
  const certificate = join(directory, 'signer.pem');
  const alternateSigningStore = join(directory, 'alternate-signing.p12');
  const alternateCertificate = join(directory, 'alternate-signer.pem');
  const expiredSigningStore = join(directory, 'expired-signing.p12');
  const expiredCertificate = join(directory, 'expired-signer.pem');
  const signed = join(directory, 'signed.aab');
  const appendedUnsigned = join(directory, 'appended-unsigned.aab');
  const alternateSigned = join(directory, 'alternate-signed.aab');
  const multipleSigners = join(directory, 'multiple-signers.aab');
  const expiredSigned = join(directory, 'expired-signed.aab');
  const unsigned = join(directory, 'unsigned.aab');
  const corrupt = join(directory, 'corrupt.aab');
  const apk = join(directory, 'artifact.apk');

  mkdirSync(content);
  mkdirSync(unsignedEntry);
  writeFileSync(join(content, 'payload.txt'), 'signed payload\n');
  writeFileSync(join(unsignedEntry, 'unsigned.txt'), 'unsigned payload\n');
  run('jar', ['--create', '--file', signed, '-C', content, '.']);
  run('keytool', [
    '-genkeypair',
    '-alias',
    'signer',
    '-keyalg',
    'EC',
    '-groupname',
    'secp256r1',
    '-validity',
    '365',
    '-dname',
    'CN=Station Fixture,O=Kontour AI,C=US',
    '-keystore',
    signingStore,
    '-storetype',
    'PKCS12',
    '-storepass',
    PASSWORD,
    '-keypass',
    PASSWORD,
    '-noprompt',
  ]);
  run('keytool', [
    '-genkeypair',
    '-alias',
    'expired-signer',
    '-keyalg',
    'EC',
    '-groupname',
    'secp256r1',
    '-startdate',
    '-2y',
    '-validity',
    '1',
    '-dname',
    'CN=Expired Station Fixture,O=Kontour AI,C=US',
    '-keystore',
    expiredSigningStore,
    '-storetype',
    'PKCS12',
    '-storepass',
    PASSWORD,
    '-keypass',
    PASSWORD,
    '-noprompt',
  ]);
  run('keytool', [
    '-genkeypair',
    '-alias',
    'alternate-signer',
    '-keyalg',
    'EC',
    '-groupname',
    'secp256r1',
    '-validity',
    '365',
    '-dname',
    'CN=Alternate Station Fixture,O=Kontour AI,C=US',
    '-keystore',
    alternateSigningStore,
    '-storetype',
    'PKCS12',
    '-storepass',
    PASSWORD,
    '-keypass',
    PASSWORD,
    '-noprompt',
  ]);
  run('keytool', [
    '-exportcert',
    '-alias',
    'alternate-signer',
    '-keystore',
    alternateSigningStore,
    '-storetype',
    'PKCS12',
    '-storepass',
    PASSWORD,
    '-rfc',
    '-file',
    alternateCertificate,
  ]);
  run('keytool', [
    '-exportcert',
    '-alias',
    'expired-signer',
    '-keystore',
    expiredSigningStore,
    '-storetype',
    'PKCS12',
    '-storepass',
    PASSWORD,
    '-rfc',
    '-file',
    expiredCertificate,
  ]);
  run('keytool', [
    '-exportcert',
    '-alias',
    'signer',
    '-keystore',
    signingStore,
    '-storetype',
    'PKCS12',
    '-storepass',
    PASSWORD,
    '-rfc',
    '-file',
    certificate,
  ]);
  run('keytool', [
    '-importcert',
    '-alias',
    'signer',
    '-file',
    certificate,
    '-keystore',
    trustStore,
    '-storetype',
    'PKCS12',
    '-storepass',
    PASSWORD,
    '-noprompt',
  ]);
  run('jarsigner', [
    '-keystore',
    signingStore,
    '-storetype',
    'PKCS12',
    '-storepass',
    PASSWORD,
    '-keypass',
    PASSWORD,
    signed,
    'signer',
  ]);
  copyFileSync(signed, appendedUnsigned);
  run('zip', ['-q', appendedUnsigned, 'unsigned.txt'], unsignedEntry);
  run('jar', ['--create', '--file', alternateSigned, '-C', content, '.']);
  run('jarsigner', [
    '-keystore',
    alternateSigningStore,
    '-storetype',
    'PKCS12',
    '-storepass',
    PASSWORD,
    '-keypass',
    PASSWORD,
    alternateSigned,
    'alternate-signer',
  ]);
  run('jar', ['--create', '--file', expiredSigned, '-C', content, '.']);
  run('jarsigner', [
    '-keystore',
    expiredSigningStore,
    '-storetype',
    'PKCS12',
    '-storepass',
    PASSWORD,
    '-keypass',
    PASSWORD,
    expiredSigned,
    'expired-signer',
  ]);
  copyFileSync(signed, multipleSigners);
  run('jarsigner', [
    '-keystore',
    alternateSigningStore,
    '-storetype',
    'PKCS12',
    '-storepass',
    PASSWORD,
    '-keypass',
    PASSWORD,
    multipleSigners,
    'alternate-signer',
  ]);
  run('jar', ['--create', '--file', unsigned, '-C', content, '.']);
  writeFileSync(corrupt, 'not a zip archive');
  writeFileSync(apk, 'APK fixture');

  const fingerprint = (certificatePath: string) => {
    const output = run('keytool', ['-printcert', '-file', certificatePath]);
    return output.match(/^\s*SHA256:\s*([0-9A-F:]+)\s*$/im)?.[1] ?? '';
  };

  return {
    alternateFingerprint: fingerprint(alternateCertificate),
    alternateSigned,
    appendedUnsigned,
    apk,
    corrupt,
    expiredFingerprint: fingerprint(expiredCertificate),
    expiredSigned,
    multipleSigners,
    primaryFingerprint: fingerprint(certificate),
    signed,
    trustStore,
    unsigned,
  };
}

function fakeApksigner(directory: string, output: string) {
  const binary = join(directory, 'fake-apksigner');
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  chmodSync(binary, 0o755);
  return binary;
}

function trustedVerificationArgs(trustStore: string) {
  return [
    '-keystore',
    trustStore,
    '-storetype',
    'PKCS12',
    '-storepass',
    PASSWORD,
  ];
}

beforeAll(() => {
  fixture = createFixture();
});

afterAll(() => {
  for (const directory of fixtureRoots.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('Android App Bundle signature verifier', () => {
  it('accepts a fully signed bundle when its signer is trusted', () => {
    expect(
      verifyAndroidAabSignature(fixture.signed, fixture.primaryFingerprint, {
        verificationArgs: trustedVerificationArgs(fixture.trustStore),
      }),
    ).toEqual({ condition: 'verified', exitCode: 0 });
  });

  it('allows only the expected strict chain-validation warning for a signed bundle', () => {
    expect(
      verifyAndroidAabSignature(fixture.signed, fixture.primaryFingerprint),
    ).toEqual({
      condition: 'chain-validation-warning',
      exitCode: 4,
    });
  });

  it('rejects missing or malformed expected fingerprints before accepting an AAB', () => {
    expect(() => verifyAndroidAabSignature(fixture.signed, '')).toThrow(
      AabSignatureVerificationError,
    );
    expect(() =>
      verifyAndroidAabSignature(fixture.signed, 'not-a-fingerprint'),
    ).toThrow(AabSignatureVerificationError);
  });

  it('rejects rc4 when expiry is added to the expected chain-validation errors', () => {
    let thrown: unknown;
    try {
      verifyAndroidAabSignature(
        fixture.expiredSigned,
        fixture.expiredFingerprint,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AabSignatureVerificationError);
    expect(thrown).toMatchObject({ exitCode: 4 });
  });

  it('rejects an appended unsigned entry even when chain validation also returns 4', () => {
    let thrown: unknown;
    try {
      verifyAndroidAabSignature(
        fixture.appendedUnsigned,
        fixture.primaryFingerprint,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AabSignatureVerificationError);
    expect(thrown).toMatchObject({ exitCode: 20 });
  });

  it('rejects a bundle re-signed by a second key and a multi-signer bundle', () => {
    expect(() =>
      verifyAndroidAabSignature(
        fixture.alternateSigned,
        fixture.primaryFingerprint,
      ),
    ).toThrow(AabSignatureVerificationError);
    expect(() =>
      verifyAndroidAabSignature(
        fixture.multipleSigners,
        fixture.primaryFingerprint,
      ),
    ).toThrow(AabSignatureVerificationError);
    expect(fixture.alternateFingerprint).not.toBe(fixture.primaryFingerprint);
  });

  it.each(['unsigned', 'corrupt', 'missing'] as const)(
    'rejects %s bundles without printing keystore material',
    (kind) => {
      const aab =
        kind === 'unsigned'
          ? fixture.unsigned
          : kind === 'corrupt'
            ? fixture.corrupt
            : join(fixture.trustStore, 'missing.aab');
      const result = spawnSync(
        process.execPath,
        [verifier, aab, fixture.primaryFingerprint],
        {
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain(
        'Android App Bundle signature verification failed.',
      );
      expect(output).not.toContain(PASSWORD);
    },
  );

  it('requires exactly one expected APK signer and rejects malformed fingerprints', () => {
    const singleSigner = fakeApksigner(
      join(fixture.trustStore, '..'),
      `Signer #1 certificate SHA-256 digest: ${fixture.primaryFingerprint}`,
    );
    verifyAndroidApkSignature(fixture.apk, fixture.primaryFingerprint, {
      apksigner: singleSigner,
    });
    expect(() =>
      verifyAndroidApkSignature(fixture.apk, fixture.alternateFingerprint, {
        apksigner: singleSigner,
      }),
    ).toThrow(ApkSignatureVerificationError);
    expect(() =>
      verifyAndroidApkSignature(fixture.apk, 'not-a-fingerprint', {
        apksigner: singleSigner,
      }),
    ).toThrow(ApkSignatureVerificationError);

    const multipleSigners = fakeApksigner(
      join(fixture.trustStore, '..'),
      `Signer #1 certificate SHA-256 digest: ${fixture.primaryFingerprint}\nSigner #2 certificate SHA-256 digest: ${fixture.alternateFingerprint}`,
    );
    expect(() =>
      verifyAndroidApkSignature(fixture.apk, fixture.primaryFingerprint, {
        apksigner: multipleSigners,
      }),
    ).toThrow(ApkSignatureVerificationError);
  });
});
