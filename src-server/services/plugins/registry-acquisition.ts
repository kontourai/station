import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MANAGED_POLICY_CAPABILITY_DISABLED_CODE } from '@kontourai/station-contracts/managed-policy';
import {
  type AppliedRegistryTrustPolicy,
  isRegistryAcquisitionReceipt,
  type PluginRegistryTrust,
  type RegistryAcquisitionReceipt,
} from '@kontourai/station-contracts/registry-trust';
import { AgentCatalogOwnershipRefusal } from '../../providers/registries/agent-registry-provider.js';
import { managedCapabilityDenial } from '../../security/managed-capability-limits.js';
import {
  type RegistryPackageClaim,
  registryPackageSignaturePayload,
  verifyRegistryPackage,
} from './registry-supply-chain.js';
import {
  type RegistryTrustPolicyAuthority,
  RegistryTrustPolicyConflict,
} from './registry-trust-policy.js';

/** Stored only in the selected generation's activation plan; the contract owns its shape. */
export type { RegistryAcquisitionReceipt };
export const validRegistryAcquisitionReceipt = isRegistryAcquisitionReceipt;
const digest = (value: string | Buffer) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
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
  // #4521: `limits.registries.unsignedPackages: false`. Answered with the
  // managed sentence (organization and support link), see refusalMessage.
  'managed-signature-required':
    "Your organization's managed policy requires a registry package signed by a key this Station already trusts.",
} as const;

/** The subject of the managed sentence for `managed-signature-required`. */
const MANAGED_SIGNATURE_SUBJECT = 'unsigned registry packages';

function refusalMessage(reason: RegistryAcquisitionRefusalReason): string {
  return reason === 'managed-signature-required'
    ? managedCapabilityDenial(MANAGED_SIGNATURE_SUBJECT)
    : REFUSALS[reason];
}
export type RegistryAcquisitionRefusalReason = keyof typeof REFUSALS;
export class RegistryAcquisitionRefused extends Error {
  constructor(
    readonly reason: RegistryAcquisitionRefusalReason = 'continuity-change',
  ) {
    super(refusalMessage(reason));
  }
}
export function isRegistryAcquisitionRefusal(error: unknown): boolean {
  return (
    error instanceof RegistryAcquisitionRefused ||
    error instanceof RegistryTrustPolicyConflict ||
    error instanceof AgentCatalogOwnershipRefusal
  );
}
/** A dependency failure wraps its cause; recover the closed trust refusal so
 * routes answer it as one (409 with its reason) instead of a generic failure. */
export function findRegistryAcquisitionRefusal(
  error: unknown,
):
  | RegistryAcquisitionRefused
  | RegistryTrustPolicyConflict
  | AgentCatalogOwnershipRefusal
  | null {
  const seen = new Set<object>();
  try {
    for (let depth = 0; depth < 32 && error instanceof Error; depth++) {
      if (error instanceof AggregateError || seen.has(error)) return null;
      if (
        error instanceof RegistryAcquisitionRefused ||
        error instanceof RegistryTrustPolicyConflict ||
        error instanceof AgentCatalogOwnershipRefusal
      )
        return error;
      seen.add(error);
      const cause = Object.getOwnPropertyDescriptor(error, 'cause');
      error = cause && 'value' in cause ? cause.value : undefined;
    }
  } catch {
    // A hostile reflection trap cannot prove a trust refusal.
  }
  return null;
}
function refusalReason(error: unknown): RegistryAcquisitionRefusalReason {
  return error instanceof RegistryAcquisitionRefused
    ? error.reason
    : 'policy-unavailable';
}

/**
 * Closed outward diagnostic; no claim fields, URLs, PEMs or arbitrary error
 * text. #4521: the managed signature requirement answers like every other
 * managed refusal (the managed code and sentence), keeping its reason.
 */
export function registryAcquisitionRefusalDetails(error: unknown) {
  // An unresolved agent catalog owner answers with its own fixed sentence.
  if (error instanceof AgentCatalogOwnershipRefusal)
    return {
      code: error.code,
      reason: error.state,
      error: error.reason,
      message: error.reason,
    };
  const reason = refusalReason(error);
  if (reason === 'managed-signature-required')
    return {
      code: MANAGED_POLICY_CAPABILITY_DISABLED_CODE,
      reason,
      error: refusalMessage(reason),
      retryable: false as const,
    };
  return {
    code: 'registry-trust-refused' as const,
    reason,
    error: REFUSALS[reason],
  };
}

/** The status a route answers a refusal with: 403 when the managed policy refused. */
export function registryAcquisitionRefusalStatus(
  error: unknown,
): 403 | 409 | 503 {
  if (error instanceof AgentCatalogOwnershipRefusal) return error.status;
  return refusalReason(error) === 'managed-signature-required' ? 403 : 409;
}
export type RegistryPolicyAdmission = Awaited<
  ReturnType<RegistryTrustPolicyAuthority['captureAdmission']>
>;
export const registryAcquisitionRevision = (
  receipt: RegistryAcquisitionReceipt,
) => digest(JSON.stringify(receipt));

/** Outward projection of the persisted receipt: the receipt itself plus the
 * pin a consent echoes. Nothing here is recomputed from package metadata. */
export function pluginRegistryTrust(
  observed:
    | { state: 'observed'; receipt: RegistryAcquisitionReceipt | null }
    | { state: 'unavailable' }
    | undefined,
): PluginRegistryTrust {
  if (observed?.state === 'unavailable') return { state: 'unavailable' };
  const receipt = observed?.receipt;
  return receipt
    ? {
        state: 'verified',
        revision: registryAcquisitionRevision(receipt),
        receipt: {
          ...receipt,
          signer: receipt.signer && { ...receipt.signer },
        },
      }
    : { state: 'none' };
}

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
