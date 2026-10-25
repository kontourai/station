/**
 * Offline Sigstore keyless verification of a plugin artifact (#2998, design
 * decision 1 in docs/design/shell-plugins-distributions.md).
 *
 * The verifier answers one question: did a GitHub Actions workflow, certified
 * by Sigstore's Fulcio and logged in Rekor, attest SLSA provenance for exactly
 * this artifact digest, and which workflow identity did it? It does not decide
 * trust. Pinning and provenance live in `plugin-install-trust.ts`.
 *
 * Offline conditions (all enforced here):
 * - the trust material is the embedded `trusted_root.json` snapshot
 *   (`sigstore-public-good-trusted-root.json`, refreshed only by
 *   `scripts/sigstore-trusted-root-snapshot.mjs`); no TUF client runs;
 * - verification makes no network request: `@sigstore/verify` is given the
 *   trust material directly and never fetches;
 * - every transparency-log entry carries an inclusion proof with a signed
 *   checkpoint, and the bundle carries at least one timestamp (a Rekor v1
 *   signed entry timestamp or an RFC 3161 timestamp) that falls inside the
 *   certificate's validity window.
 *
 * Station checks those structural conditions itself before calling the
 * library, so each refusal has its own reason. The library then verifies the
 * certificate chain and SCT, every timestamp, every inclusion proof and
 * checkpoint, the log entry body and the signature. Station's pre-checks only
 * ever refuse; acceptance requires the library's verification as well.
 */
import { assertBundleLatest, type Bundle } from '@sigstore/bundle';
import { RFC3161Timestamp, X509Certificate } from '@sigstore/core';
import { Bundle as BundleMessage, TrustedRoot } from '@sigstore/protobuf-specs';
import {
  toSignedEntity,
  toTrustMaterial,
  VerificationError,
  Verifier,
} from '@sigstore/verify';
import embeddedTrustedRoot from './sigstore-public-good-trusted-root.json' with {
  type: 'json',
};

const BUNDLE_MEDIA_TYPE = 'application/vnd.dev.sigstore.bundle.v0.3+json';
const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
const IN_TOTO_STATEMENT_V1 = 'https://in-toto.io/Statement/v1';
const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';
const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
/** Real SLSA bundles are ~15 KiB; the bound refuses, never truncates. */
export const MAX_PLUGIN_SIGSTORE_BUNDLE_BYTES = 512 * 1024;
const MAX_STATEMENT_SUBJECTS = 1024;
const SHA256_DIGEST = /^sha256:([0-9a-f]{64})$/;

/** Fulcio certificate extensions for GitHub Actions identities. */
const FULCIO_OID = {
  issuer: '1.3.6.1.4.1.57264.1.8',
  buildSignerUri: '1.3.6.1.4.1.57264.1.9',
  runnerEnvironment: '1.3.6.1.4.1.57264.1.11',
  sourceRepositoryUri: '1.3.6.1.4.1.57264.1.12',
  sourceRepositoryRef: '1.3.6.1.4.1.57264.1.14',
  repositoryId: '1.3.6.1.4.1.57264.1.15',
  ownerId: '1.3.6.1.4.1.57264.1.17',
  trigger: '1.3.6.1.4.1.57264.1.20',
} as const;

/**
 * The workflow identity a verified Fulcio certificate states. Every field is
 * read from the certificate the library verified, never from the bundle's
 * statement or from package metadata.
 */
export interface SigstoreCertificateIdentity {
  issuer: string;
  /** The certificate's SAN: `https://github.com/<repo>/<workflow>@<ref>`. */
  subjectAlternativeName: string;
  buildSignerUri: string;
  sourceRepositoryUri: string;
  sourceRepositoryRef: string;
  repositoryId: string;
  ownerId: string;
  trigger: string;
  runnerEnvironment: string;
}

export type PluginSigstoreRefusalReason =
  | 'bundle-too-large'
  | 'malformed-bundle'
  | 'unsupported-bundle'
  | 'missing-transparency-log-entry'
  | 'missing-inclusion-proof'
  | 'no-verified-timestamp'
  | 'timestamp-outside-certificate-window'
  | 'verification-failed'
  | 'unsupported-statement'
  | 'artifact-digest-mismatch'
  | 'unsupported-signer-identity';

export type PluginSigstoreVerification =
  | {
      state: 'verified';
      identity: SigstoreCertificateIdentity;
      /** Earliest verified timestamp, ISO 8601. */
      signedAt: string;
    }
  | {
      state: 'refused';
      reason: PluginSigstoreRefusalReason;
      /** Library error code for `verification-failed`; never key material. */
      detail?: string;
    };

export interface PluginSigstoreVerifier {
  verify(input: {
    /** Parsed Sigstore bundle JSON, untrusted. */
    bundle: unknown;
    /** Host-computed `sha256:<hex>` digest of the artifact bytes. */
    artifactDigest: string;
  }): PluginSigstoreVerification;
}

function refused(
  reason: PluginSigstoreRefusalReason,
  detail?: string,
): PluginSigstoreVerification {
  return { state: 'refused', reason, ...(detail ? { detail } : {}) };
}

function utf8Extension(
  certificate: X509Certificate,
  oid: string,
): string | undefined {
  // Fulcio's v2 extensions hold a DER UTF8String inside the extnValue octets.
  const inner = certificate.extension(oid)?.valueObj.subs[0];
  if (inner?.tag.number !== 0x0c || inner.tag.constructed) return undefined;
  return inner.value.toString('utf8');
}

function certificateIdentity(
  certificate: X509Certificate,
): SigstoreCertificateIdentity | null {
  const subjectAlternativeName = certificate.subjectAltName;
  const fields = Object.fromEntries(
    Object.entries(FULCIO_OID).map(([field, oid]) => [
      field,
      utf8Extension(certificate, oid),
    ]),
  ) as Record<keyof typeof FULCIO_OID, string | undefined>;
  if (
    typeof subjectAlternativeName !== 'string' ||
    Object.values(fields).some((value) => !value) ||
    fields.issuer !== GITHUB_ACTIONS_ISSUER
  ) {
    return null;
  }
  return {
    subjectAlternativeName,
    ...(fields as Record<keyof typeof FULCIO_OID, string>),
  };
}

function bundleCertificate(bundle: Bundle): X509Certificate | null {
  const content = bundle.verificationMaterial.content;
  if (content.$case !== 'certificate') return null;
  return X509Certificate.parse(Buffer.from(content.certificate.rawBytes));
}

/**
 * Timestamps the bundle claims. Only a log entry with an inclusion promise
 * (signed entry timestamp) carries a timestamp; a Rekor v2 entry has
 * `integratedTime` 0 and needs an RFC 3161 timestamp instead. The library
 * verifies each of these; this list only lets Station refuse early.
 */
function claimedTimestamps(bundle: Bundle): Date[] {
  const { tlogEntries, timestampVerificationData } =
    bundle.verificationMaterial;
  const fromLog = tlogEntries
    .filter(
      (entry) =>
        entry.inclusionPromise !== undefined &&
        entry.integratedTime !== '' &&
        entry.integratedTime !== '0',
    )
    .map((entry) => new Date(Number(entry.integratedTime) * 1000));
  const fromAuthority = (
    timestampVerificationData?.rfc3161Timestamps ?? []
  ).map(
    (timestamp) =>
      RFC3161Timestamp.parse(Buffer.from(timestamp.signedTimestamp))
        .signingTime,
  );
  return [...fromLog, ...fromAuthority];
}

function statementCoversDigest(payload: Buffer, hex: string): boolean | null {
  let statement: unknown;
  try {
    statement = JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof statement !== 'object' ||
    statement === null ||
    (statement as { _type?: unknown })._type !== IN_TOTO_STATEMENT_V1 ||
    (statement as { predicateType?: unknown }).predicateType !==
      SLSA_PROVENANCE_V1
  ) {
    return null;
  }
  const subjects = (statement as { subject?: unknown }).subject;
  if (
    !Array.isArray(subjects) ||
    subjects.length === 0 ||
    subjects.length > MAX_STATEMENT_SUBJECTS
  ) {
    return null;
  }
  return subjects.some(
    (subject) =>
      typeof subject === 'object' &&
      subject !== null &&
      (subject as { digest?: { sha256?: unknown } }).digest?.sha256 === hex,
  );
}

function serializedLength(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? Buffer.byteLength(text) : null;
  } catch {
    return null;
  }
}

// UNWIRED(#2998): the installer verifies a plugin's bundle once install trust records land.
/**
 * Builds a verifier over a trusted root. Production uses the embedded
 * public-good snapshot; tests may pass another root, never a network source.
 */
export function createPluginSigstoreVerifier(
  options: { trustedRoot?: unknown } = {},
): PluginSigstoreVerifier {
  const trustMaterial = toTrustMaterial(
    TrustedRoot.fromJSON(options.trustedRoot ?? embeddedTrustedRoot),
  );
  // Thresholds are explicit so a library default change cannot relax them.
  const verifier = new Verifier(trustMaterial, {
    tlogThreshold: 1,
    ctlogThreshold: 1,
    timestampThreshold: 1,
  });

  return {
    verify({ bundle: input, artifactDigest }) {
      const digest = SHA256_DIGEST.exec(artifactDigest);
      if (!digest)
        throw new RangeError('artifactDigest must be a sha256:<hex> digest');
      const length = serializedLength(input);
      if (length === null) return refused('malformed-bundle');
      if (length > MAX_PLUGIN_SIGSTORE_BUNDLE_BYTES)
        return refused('bundle-too-large');

      // Decode without the library's structural assertion first, so each
      // Station condition below refuses with its own reason. The assertion
      // still runs afterwards as a second layer.
      let bundle: Bundle;
      try {
        bundle = BundleMessage.fromJSON(input) as Bundle;
      } catch {
        return refused('malformed-bundle');
      }
      if (
        bundle.mediaType !== BUNDLE_MEDIA_TYPE ||
        bundle.content?.$case !== 'dsseEnvelope' ||
        bundle.content.dsseEnvelope.payloadType !== IN_TOTO_PAYLOAD_TYPE ||
        bundle.verificationMaterial?.content?.$case !== 'certificate'
      ) {
        return refused(
          bundle.mediaType === undefined || bundle.mediaType === ''
            ? 'malformed-bundle'
            : 'unsupported-bundle',
        );
      }
      const { tlogEntries } = bundle.verificationMaterial;
      if (tlogEntries.length === 0)
        return refused('missing-transparency-log-entry');
      if (
        tlogEntries.some(
          (entry) => entry.inclusionProof?.checkpoint === undefined,
        )
      ) {
        return refused('missing-inclusion-proof');
      }
      let certificate: X509Certificate | null;
      let timestamps: Date[];
      try {
        assertBundleLatest(bundle);
        certificate = bundleCertificate(bundle);
        timestamps = claimedTimestamps(bundle);
      } catch {
        return refused('malformed-bundle');
      }
      if (certificate === null) return refused('unsupported-bundle');
      if (timestamps.length === 0) return refused('no-verified-timestamp');
      const { notBefore, notAfter } = certificate;
      if (
        timestamps.some(
          (timestamp) =>
            Number.isNaN(timestamp.getTime()) ||
            timestamp < notBefore ||
            timestamp > notAfter,
        )
      ) {
        return refused('timestamp-outside-certificate-window');
      }

      try {
        verifier.verify(toSignedEntity(bundle));
      } catch (error) {
        return refused(
          'verification-failed',
          error instanceof VerificationError ? error.code : 'unexpected',
        );
      }

      const covers = statementCoversDigest(
        bundle.content.dsseEnvelope.payload,
        digest[1],
      );
      if (covers === null) return refused('unsupported-statement');
      if (!covers) return refused('artifact-digest-mismatch');

      const identity = certificateIdentity(certificate);
      if (!identity) return refused('unsupported-signer-identity');
      const signedAt = new Date(
        Math.min(...timestamps.map((timestamp) => timestamp.getTime())),
      );
      return { state: 'verified', identity, signedAt: signedAt.toISOString() };
    },
  };
}
