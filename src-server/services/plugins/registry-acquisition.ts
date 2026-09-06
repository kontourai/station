import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AppliedRegistryTrustPolicy } from '@kontourai/station-contracts/registry-trust';
import {
  type RegistryPackageClaim,
  registryPackageSignaturePayload,
  verifyRegistryPackage,
} from './registry-supply-chain.js';
import {
  type RegistryTrustPolicyAuthority,
  RegistryTrustPolicyConflict,
} from './registry-trust-policy.js';

/** Stored only in the selected generation's activation plan. Source and registry
 * URLs are hashed: credentials, PEM keys and signatures never enter this receipt. */
export interface RegistryAcquisitionReceipt {
  version: 1;
  policyScope: string;
  policyEpoch: string;
  policyFingerprint: string;
  registryKeyDigest: string;
  registryId: string;
  claimDigest: string;
  packageDigest: string;
  signer: { keyId: string; spkiFingerprint: string } | null;
}
const digest = (value: string | Buffer) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function validRegistryAcquisitionReceipt(
  value: unknown,
): value is RegistryAcquisitionReceipt {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !==
      'claimDigest,packageDigest,policyEpoch,policyFingerprint,policyScope,registryId,registryKeyDigest,signer,version' ||
    value.version !== 1
  )
    return false;
  if (
    !['policyScope', 'policyEpoch', 'registryId'].every(
      (key) => typeof value[key] === 'string' && ID.test(value[key] as string),
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
        typeof value[key] === 'string' && DIGEST.test(value[key] as string),
    )
  )
    return false;
  return (
    value.signer === null ||
    (object(value.signer) &&
      Object.keys(value.signer).sort().join(',') === 'keyId,spkiFingerprint' &&
      typeof value.signer.keyId === 'string' &&
      ID.test(value.signer.keyId) &&
      typeof value.signer.spkiFingerprint === 'string' &&
      DIGEST.test(value.signer.spkiFingerprint))
  );
}
const REFUSALS = {
  'invalid-claim':
    'The registry package claim does not match the requested package.',
  'unsigned-package': 'The selected registry requires a signed package.',
  'untrusted-signing-key':
    'The package signing key is not trusted by the applied host policy.',
  'signature-mismatch':
    'The package signature or signed source bytes do not match.',
  'content-mismatch':
    'The package source bytes do not match the registry claim.',
  'pin-mismatch': 'The package claim changed from its installed pin.',
  'missing-claim': 'The selected registry did not provide a package claim.',
  'unqualified-provider':
    'This registry cannot provide a fresh coherent package claim.',
  'stale-review':
    'The registry review changed. Preview again before installing.',
  'policy-unavailable':
    'Registry trust policy is unavailable or awaiting application.',
  'receipt-unavailable':
    'The installed registry verification receipt is unavailable. Retained data has not been migrated.',
  'unsupported-path':
    'Registry verification is unavailable for this mutation path. Retained data has not been migrated.',
  'continuity-change':
    'Registry trust continuity changed. Retained installation data requires reviewed migration.',
} as const;
export type RegistryAcquisitionRefusalReason = keyof typeof REFUSALS;
export class RegistryAcquisitionRefused extends Error {
  constructor(
    readonly reason: RegistryAcquisitionRefusalReason = 'continuity-change',
  ) {
    super(REFUSALS[reason]);
  }
}
export function isRegistryAcquisitionRefusal(error: unknown): boolean {
  return (
    error instanceof RegistryAcquisitionRefused ||
    error instanceof RegistryTrustPolicyConflict
  );
}
/** Closed outward diagnostic; no claim fields, URLs, PEMs or arbitrary error text. */
export function registryAcquisitionRefusalDetails(error: unknown) {
  const reason: RegistryAcquisitionRefusalReason =
    error instanceof RegistryAcquisitionRefused
      ? error.reason
      : 'policy-unavailable';
  return {
    code: 'registry-trust-refused' as const,
    reason,
    error: REFUSALS[reason],
  };
}
export type RegistryPolicyAdmission = Awaited<
  ReturnType<RegistryTrustPolicyAuthority['captureAdmission']>
>;
export const registryAcquisitionRevision = (
  receipt: RegistryAcquisitionReceipt,
) => digest(JSON.stringify(receipt));

/** Called with a fresh HOST-resolved provider observation, never request claims. */
export async function verifyRegistryAcquisition(input: {
  admission: RegistryPolicyAdmission;
  registryId?: string;
  registryKey?: string;
  fresh: boolean;
  claim?: unknown;
  source: string;
  pluginName: string;
  packageVersion: string;
  observedSourceDigest: string;
  previous?: RegistryAcquisitionReceipt;
}): Promise<RegistryAcquisitionReceipt | undefined> {
  await input.admission.assertCurrent();
  const configuration = input.admission.configuration;
  const profile = configuration?.profiles.find(
    (entry) => entry.registryKey === input.registryKey,
  );
  if (!profile) {
    if (input.previous)
      throw new RegistryAcquisitionRefused('continuity-change');
    if (input.claim !== undefined)
      throw new RegistryAcquisitionRefused('policy-unavailable');
    return undefined;
  }
  const decision = input.admission.decision;
  if (!decision) throw new RegistryAcquisitionRefused('policy-unavailable');
  if (!input.fresh)
    throw new RegistryAcquisitionRefused('unqualified-provider');
  if (!input.registryId || !input.registryKey)
    throw new RegistryAcquisitionRefused('invalid-claim');
  if (!input.claim) throw new RegistryAcquisitionRefused('missing-claim');
  const verified = verifyRegistryPackage({
    claim: input.claim as RegistryPackageClaim,
    observedPackageDigest: input.observedSourceDigest,
    policy: { ...profile, pins: 'exact' },
  });
  if (verified.kind !== 'verified')
    throw new RegistryAcquisitionRefused(verified.reason);
  const claim = verified.package.claim;
  if (
    claim.registryId !== input.registryId ||
    claim.registryKey !== input.registryKey ||
    claim.source !== input.source ||
    claim.pluginName !== input.pluginName ||
    claim.packageVersion !== input.packageVersion
  )
    throw new RegistryAcquisitionRefused();
  const signer = claim.signature
    ? decision.identity.profiles
        .find((entry) => entry.registryKey === input.registryKey)
        ?.trustedKeys.find((key) => key.keyId === claim.signature!.keyId)
    : null;
  if (claim.signature && !signer)
    throw new RegistryAcquisitionRefused('untrusted-signing-key');
  const receipt: RegistryAcquisitionReceipt = {
    version: 1,
    policyScope: decision.scope,
    policyEpoch: decision.epoch,
    policyFingerprint: decision.identity.fingerprint,
    registryKeyDigest: digest(input.registryKey),
    registryId: input.registryId,
    claimDigest: digest(registryPackageSignaturePayload(claim)),
    packageDigest: claim.packageDigest,
    signer: signer ? { ...signer } : null,
  };
  if (
    !validRegistryAcquisitionReceipt(receipt) ||
    (input.previous && !isDeepStrictEqual(input.previous, receipt))
  )
    throw new RegistryAcquisitionRefused();
  await input.admission.assertCurrent();
  return receipt;
}

export function registryReceiptMatchesAppliedPolicy(
  receipt: RegistryAcquisitionReceipt,
  decision: AppliedRegistryTrustPolicy | null,
): boolean {
  return (
    !!decision &&
    decision.scope === receipt.policyScope &&
    decision.epoch === receipt.policyEpoch &&
    decision.identity.fingerprint === receipt.policyFingerprint
  );
}

/** Retained immutable code is bound to an original verification, not a new
 * source observation. Recovery remains local when the registry is offline. */
export async function verifyRetainedRegistryAcquisition(
  admission: RegistryPolicyAdmission,
  receipt: RegistryAcquisitionReceipt,
): Promise<RegistryAcquisitionReceipt> {
  await admission.assertCurrent();
  if (
    !validRegistryAcquisitionReceipt(receipt) ||
    !registryReceiptMatchesAppliedPolicy(receipt, admission.decision)
  )
    throw new RegistryAcquisitionRefused();
  const profile = admission.decision!.identity.profiles.find(
    (entry) => digest(entry.registryKey) === receipt.registryKeyDigest,
  );
  if (
    !profile ||
    (receipt.signer
      ? !profile.trustedKeys.some(
          (key) =>
            key.keyId === receipt.signer!.keyId &&
            key.spkiFingerprint === receipt.signer!.spkiFingerprint,
        )
      : profile.signatures === 'required')
  )
    throw new RegistryAcquisitionRefused();
  return receipt;
}
