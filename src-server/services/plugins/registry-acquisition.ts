import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AppliedRegistryTrustPolicy } from '@kontourai/station-contracts/registry-trust';
import {
  type RegistryPackageClaim,
  registryPackageSignaturePayload,
  verifyRegistryPackage,
} from './registry-supply-chain.js';
import type { RegistryTrustPolicyAuthority } from './registry-trust-policy.js';

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
export class RegistryAcquisitionRefused extends Error {
  constructor() {
    super(
      'Registry acquisition requires a fresh verified claim and unchanged trust continuity. Retained installation data has not been migrated.',
    );
  }
}
export type RegistryPolicyAdmission = Awaited<
  ReturnType<RegistryTrustPolicyAuthority['captureAdmission']>
>;

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
    if (
      input.previous ||
      configuration?.profiles.some(
        (entry) => entry.signatures === 'required',
      ) ||
      input.claim !== undefined
    )
      throw new RegistryAcquisitionRefused();
    return undefined;
  }
  const decision = input.admission.decision;
  if (
    !decision ||
    !input.fresh ||
    !input.registryId ||
    !input.registryKey ||
    !input.claim
  )
    throw new RegistryAcquisitionRefused();
  const verified = verifyRegistryPackage({
    claim: input.claim as RegistryPackageClaim,
    observedPackageDigest: input.observedSourceDigest,
    policy: { ...profile, pins: 'exact' },
  });
  if (verified.kind !== 'verified') throw new RegistryAcquisitionRefused();
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
  if (claim.signature && !signer) throw new RegistryAcquisitionRefused();
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
