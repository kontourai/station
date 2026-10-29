/** Candidate configuration; only an applied configuration decision grants policy authority. */
export interface RegistryTrustConfiguration {
  profiles: Array<{
    registryKey: string;
    signatures: 'optional' | 'required';
    trustedEd25519Keys: Record<string, string>;
  }>;
}

/** Bounded durable identity: no PEM keys or package-provided policy values. */
export interface RegistryTrustPolicyIdentity {
  configured: boolean;
  fingerprint: string;
  profiles: Array<{
    registryKey: string;
    signatures: 'optional' | 'required';
    trustedKeys: Array<{ keyId: string; spkiFingerprint: string }>;
  }>;
}

export interface AppliedRegistryTrustPolicy {
  scope: string;
  epoch: string;
  identity: RegistryTrustPolicyIdentity;
}

/** Published Agent Plugins schema targeted by a registry source-tree claim. */
export const AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' as const;
export interface RegistryPackageSignature {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  readonly value: string;
}
/** Untrusted registry assertion until verified against a host-selected key. */
export interface RegistryPackageClaim {
  readonly packageSchema: typeof AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL;
  readonly registryId: string;
  readonly registryKey: string;
  readonly pluginName: string;
  readonly packageVersion: string;
  readonly source: string;
  readonly packageDigest: string;
  readonly signature?: RegistryPackageSignature;
}

/**
 * The host's own record of one verified registry acquisition, written into the
 * selected generation's activation plan. Source and registry URLs are hashed;
 * credentials, PEM keys and signatures never enter it. Package-authored
 * metadata cannot produce one: only host verification against an applied
 * policy does.
 */
export interface RegistryAcquisitionReceipt {
  version: 1;
  policyScope: string;
  policyEpoch: string;
  policyFingerprint: string;
  registryKeyDigest: string;
  registryId: string;
  claimDigest: string;
  packageDigest: string;
  /** `null`: the applied profile accepted an unsigned package (optional signatures). */
  signer: { keyId: string; spkiFingerprint: string } | null;
}

const RECEIPT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RECEIPT_KEYS =
  'claimDigest,packageDigest,policyEpoch,policyFingerprint,policyScope,registryId,registryKeyDigest,signer,version';

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Exact-shape check shared by the persisting server and its readers. */
export function isRegistryAcquisitionReceipt(
  value: unknown,
): value is RegistryAcquisitionReceipt {
  if (
    !plainObject(value) ||
    Object.keys(value).sort().join(',') !== RECEIPT_KEYS ||
    value.version !== 1
  )
    return false;
  if (
    !['policyScope', 'policyEpoch', 'registryId'].every(
      (key) =>
        typeof value[key] === 'string' && RECEIPT_ID.test(value[key] as string),
    )
  )
    return false;
  if (
    ![
      'claimDigest',
      'packageDigest',
      'policyFingerprint',
      'registryKeyDigest',
    ].every(
      (key) =>
        typeof value[key] === 'string' &&
        RECEIPT_DIGEST.test(value[key] as string),
    )
  )
    return false;
  return (
    value.signer === null ||
    (plainObject(value.signer) &&
      Object.keys(value.signer).sort().join(',') === 'keyId,spkiFingerprint' &&
      typeof value.signer.keyId === 'string' &&
      RECEIPT_ID.test(value.signer.keyId) &&
      typeof value.signer.spkiFingerprint === 'string' &&
      RECEIPT_DIGEST.test(value.signer.spkiFingerprint))
  );
}

/**
 * Registry verification as the host persisted it for one preview or selected
 * installation. `verified` carries the receipt itself and the pin
 * (`revision`) a consent must echo; `none` means no verified claim exists;
 * `unavailable` means the persisted receipt could not be read. No state is
 * derived from package-authored metadata.
 */
export type PluginRegistryTrust =
  | {
      readonly state: 'verified';
      readonly revision: string;
      readonly receipt: RegistryAcquisitionReceipt;
    }
  | { readonly state: 'none' }
  | { readonly state: 'unavailable' };

export function isPluginRegistryTrust(
  value: unknown,
): value is PluginRegistryTrust {
  if (!plainObject(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  if (value.state === 'none' || value.state === 'unavailable')
    return keys === 'state';
  return (
    value.state === 'verified' &&
    keys === 'receipt,revision,state' &&
    typeof value.revision === 'string' &&
    RECEIPT_DIGEST.test(value.revision) &&
    isRegistryAcquisitionReceipt(value.receipt)
  );
}
