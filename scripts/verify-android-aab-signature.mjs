import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const VERIFIED_OUTPUT = 'jar verified.';
const CHAIN_WARNING_OUTPUT = 'jar verified, with signer errors.';
const EXPECTED_CHAIN_VALIDATION_LINE =
  /^This jar contains entries whose certificate chain is invalid\. Reason: PKIX path building failed: .*unable to find valid certification path to requested target$/;
const EXPECTED_SELF_SIGNED_LINE =
  /^This jar contains entries whose signer certificate is self-signed\.$/;

export class AabSignatureVerificationError extends Error {
  constructor(exitCode) {
    super('Android App Bundle signature verification failed.');
    this.name = 'AabSignatureVerificationError';
    this.exitCode = exitCode;
  }
}

function normalizeSha256Fingerprint(value) {
  const normalized = String(value ?? '')
    .replace(/[^a-f0-9]/gi, '')
    .toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(normalized)) {
    throw new AabSignatureVerificationError(null);
  }
  return normalized;
}

function aabSignerFingerprints(output) {
  const signerBlocks = output.split(/^Signer #\d+:\s*$/m).slice(1);
  return signerBlocks.map((block) => {
    const primaryCertificate = block.split(/^Certificate #2:\s*$/m, 1)[0];
    const fingerprint = primaryCertificate.match(
      /^\s*SHA256:\s*([0-9A-F:]+)\s*$/im,
    )?.[1];
    return normalizeSha256Fingerprint(fingerprint);
  });
}

function strictErrorLines(output) {
  const marker = output.match(/^Error:\s*$/m);
  if (!marker || marker.index === undefined) return [];
  const afterMarker = output
    .slice(marker.index + marker[0].length)
    .replace(/^\r?\n/, '');
  const section = afterMarker.split(/\r?\n\s*\r?\n/, 1)[0];
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function hasOnlyExpectedChainValidationErrors(output) {
  const errors = strictErrorLines(output);
  return (
    errors.length === 2 &&
    EXPECTED_CHAIN_VALIDATION_LINE.test(errors[0]) &&
    EXPECTED_SELF_SIGNED_LINE.test(errors[1])
  );
}

/**
 * Verifies an Android App Bundle without exposing jarsigner's untrusted output.
 *
 * Jarsigner's strict exit status is a bitmask. A signed bundle using the
 * expected upload certificate can return 4 when its chain is not in the
 * runner's trust store. That is accepted only alongside jarsigner's
 * affirmative verification output and exactly the expected two-line
 * chain-validation Error section. Any extra strict condition (expired,
 * disabled, unsigned, and so on) is rejected.
 *
 * @param {string} aabPath
 * @param {string} expectedFingerprint
 * @param {{ jarsigner?: string, keytool?: string, verificationArgs?: string[] }} [options]
 */
export function verifyAndroidAabSignature(
  aabPath,
  expectedFingerprint,
  { jarsigner = 'jarsigner', keytool = 'keytool', verificationArgs = [] } = {},
) {
  if (typeof aabPath !== 'string' || !aabPath || !existsSync(aabPath)) {
    throw new AabSignatureVerificationError(null);
  }
  const expected = normalizeSha256Fingerprint(expectedFingerprint);

  const result = spawnSync(
    jarsigner,
    ['-verify', '-strict', ...verificationArgs, aabPath],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw new AabSignatureVerificationError(null);

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const allowsChainValidationWarning =
    result.status === 4 &&
    output.includes(CHAIN_WARNING_OUTPUT) &&
    hasOnlyExpectedChainValidationErrors(output);
  const isVerified = result.status === 0 && output.includes(VERIFIED_OUTPUT);
  if (!isVerified && !allowsChainValidationWarning) {
    throw new AabSignatureVerificationError(result.status);
  }

  const certificate = spawnSync(keytool, ['-printcert', '-jarfile', aabPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (certificate.error || certificate.status !== 0) {
    throw new AabSignatureVerificationError(null);
  }
  const fingerprints = aabSignerFingerprints(
    `${certificate.stdout ?? ''}\n${certificate.stderr ?? ''}`,
  );
  if (fingerprints.length !== 1 || fingerprints[0] !== expected) {
    throw new AabSignatureVerificationError(null);
  }
  return {
    condition: allowsChainValidationWarning
      ? 'chain-validation-warning'
      : 'verified',
    exitCode: result.status,
  };
}

if (process.argv[1]?.endsWith('verify-android-aab-signature.mjs')) {
  try {
    const result = verifyAndroidAabSignature(process.argv[2], process.argv[3]);
    console.log(`Android App Bundle signature verified (${result.condition}).`);
  } catch (error) {
    if (error instanceof AabSignatureVerificationError) {
      console.error(error.message);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
