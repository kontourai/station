import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export class ApkSignatureVerificationError extends Error {
  constructor() {
    super('Android APK signer verification failed.');
    this.name = 'ApkSignatureVerificationError';
  }
}

export function normalizeSha256Fingerprint(value) {
  const normalized = String(value ?? '')
    .replace(/[^a-f0-9]/gi, '')
    .toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(normalized)) {
    throw new ApkSignatureVerificationError();
  }
  return normalized;
}

/**
 * Verifies an APK and binds its sole signing certificate to the expected
 * upload-certificate fingerprint without printing apksigner output.
 *
 * @param {string} apkPath
 * @param {string} expectedFingerprint
 * @param {{ apksigner?: string }} [options]
 */
export function verifyAndroidApkSignature(
  apkPath,
  expectedFingerprint,
  { apksigner = 'apksigner' } = {},
) {
  if (typeof apkPath !== 'string' || !apkPath || !existsSync(apkPath)) {
    throw new ApkSignatureVerificationError();
  }
  const expected = normalizeSha256Fingerprint(expectedFingerprint);
  const result = spawnSync(
    apksigner,
    ['verify', '--verbose', '--print-certs', apkPath],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw new ApkSignatureVerificationError();
  }

  const fingerprints = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(
        /^Signer #\d+ certificate SHA-256 digest:\s*(.+)$/,
      );
      return match ? [normalizeSha256Fingerprint(match[1])] : [];
    });
  if (fingerprints.length !== 1 || fingerprints[0] !== expected) {
    throw new ApkSignatureVerificationError();
  }
}

if (process.argv[1]?.endsWith('verify-android-apk-signature.mjs')) {
  try {
    verifyAndroidApkSignature(process.argv[2], process.argv[3], {
      apksigner: process.argv[4] || 'apksigner',
    });
    console.log('Android APK signer verified.');
  } catch (error) {
    if (error instanceof ApkSignatureVerificationError) {
      console.error(error.message);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
