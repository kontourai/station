/**
 * Install trust: signer pinning, `plugins.lock` membership, provenance and
 * the tier decision (#2998, slice d1 of docs/design/shell-plugins-distributions.md).
 *
 * Everything here is a pure function of verified inputs. The Sigstore
 * identity comes from `plugin-sigstore-verifier.ts`; an ed25519 signer comes
 * from the registry receipt that registry-acquisition already persists.
 *
 * The record pins a verified signer identity plus a content digest, not a key
 * plus a digest: under Sigstore keyless signing (OPEN-4, 2026-10-20) there is
 * no long-lived key to pin.
 */
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import type { SigstoreCertificateIdentity } from './plugin-sigstore-verifier.js';

/**
 * The expected workflow identity of a Kontour plugin release. Data, not
 * code: a rotation ships a release that lists both the old and the new pin
 * for an overlap window. Station pins none yet: `kontourai/station-plugins`
 * (slice i1) does not exist, so its repository id is unknown and no install
 * can be `kontour`.
 */
export interface SigstoreSignerPin {
  issuer: string;
  /** `owner/name`, as the certificate's source repository URI states it. */
  repository: string;
  /** Numeric ids, so a deleted and re-created repository does not match. */
  repositoryId: string;
  ownerId: string;
  /** Path of the signing workflow inside `repository`. */
  workflowPath: string;
  /**
   * Git ref the run was triggered from. `*` matches one or more characters
   * other than `/`; every other character matches itself.
   */
  refPattern: string;
  /** Trigger event, so a `workflow_dispatch` of a `push` workflow does not match. */
  trigger: string;
  runnerEnvironment: 'github-hosted';
}

function refMatches(pattern: string, ref: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[\\^$.|?+()[\]{}]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${source}$`).test(ref);
}

export function matchesSignerPin(
  identity: SigstoreCertificateIdentity,
  pin: SigstoreSignerPin,
): boolean {
  const repositoryUri = `https://github.com/${pin.repository}`;
  return (
    identity.issuer === pin.issuer &&
    identity.sourceRepositoryUri === repositoryUri &&
    identity.repositoryId === pin.repositoryId &&
    identity.ownerId === pin.ownerId &&
    identity.trigger === pin.trigger &&
    identity.runnerEnvironment === pin.runnerEnvironment &&
    refMatches(pin.refPattern, identity.sourceRepositoryRef) &&
    // The signing workflow must be the pinned file in the pinned repository
    // at the triggering ref, not a reusable workflow hosted elsewhere.
    identity.subjectAlternativeName ===
      `${repositoryUri}/${pin.workflowPath}@${identity.sourceRepositoryRef}` &&
    identity.buildSignerUri === identity.subjectAlternativeName
  );
}

// ── plugins.lock (d1 minimum: name plus identity) ─────────────────────────

const MAX_LOCK_ENTRIES = 256;
const PIN_KEYS = [
  'issuer',
  'ownerId',
  'refPattern',
  'repository',
  'repositoryId',
  'runnerEnvironment',
  'trigger',
  'workflowPath',
].join(',');

export class PluginsLockError extends Error {
  constructor(detail: string) {
    super(`plugins.lock is invalid: ${detail}`);
    this.name = 'PluginsLockError';
  }
}

/** Lock membership: plugin name to the pinned identity its entry names. */
export type PluginsLockMembership = ReadonlyMap<string, SigstoreSignerPin>;

function samePin(a: SigstoreSignerPin, b: SigstoreSignerPin): boolean {
  return PIN_KEYS.split(',').every(
    (key) =>
      a[key as keyof SigstoreSignerPin] === b[key as keyof SigstoreSignerPin],
  );
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// UNWIRED(#2998): the installer reads the release's lock once install trust records land.
/**
 * Reads the minimum of `plugins.lock` that d1 needs. Slice i0 extends the
 * entry with version, artifact URL, sha256 and capabilities. Refuses rather
 * than skips: an entry whose identity is not one of `pins` cannot widen
 * trust, and an unsorted or duplicate name is a broken lock, not a choice.
 */
export function parsePluginsLock(
  value: unknown,
  pins: readonly SigstoreSignerPin[],
): PluginsLockMembership {
  if (
    !isRecordValue(value) ||
    Object.keys(value).sort().join(',') !== 'plugins,version' ||
    value.version !== 1 ||
    !Array.isArray(value.plugins)
  ) {
    throw new PluginsLockError('expected { version: 1, plugins: [] }');
  }
  if (value.plugins.length > MAX_LOCK_ENTRIES)
    throw new PluginsLockError(`more than ${MAX_LOCK_ENTRIES} entries`);
  const membership = new Map<string, SigstoreSignerPin>();
  let previous: string | null = null;
  for (const entry of value.plugins) {
    if (
      !isRecordValue(entry) ||
      Object.keys(entry).sort().join(',') !== 'name,sigstoreIdentity' ||
      !isCanonicalPluginId(entry.name)
    ) {
      throw new PluginsLockError('entry must be { name, sigstoreIdentity }');
    }
    if (previous !== null && entry.name <= previous)
      throw new PluginsLockError('entries must be sorted by unique name');
    previous = entry.name;
    const identity = entry.sigstoreIdentity;
    if (
      !isRecordValue(identity) ||
      Object.keys(identity).sort().join(',') !== PIN_KEYS
    ) {
      throw new PluginsLockError(`${entry.name}: malformed sigstoreIdentity`);
    }
    const pin = pins.find((candidate) =>
      samePin(candidate, identity as unknown as SigstoreSignerPin),
    );
    if (!pin)
      throw new PluginsLockError(
        `${entry.name}: sigstoreIdentity is not a pinned identity`,
      );
    membership.set(entry.name, pin);
  }
  return membership;
}

// ── Provenance and tier ───────────────────────────────────────────────────

export type PluginProvenance = 'kontour' | 'publisher' | 'unsigned';
export type PluginTrustTier = 2 | 3;

/**
 * The signer a trust record pins. A Sigstore signer is the workflow (the
 * certificate SAN without its `@ref`), so successive releases of the same
 * workflow are the same signer. An ed25519 signer is its SPKI fingerprint;
 * the registry `keyId` is a label and is kept for display only.
 */
export type PluginSigner =
  | {
      kind: 'sigstore';
      issuer: string;
      identity: string;
      repositoryId: string;
      ownerId: string;
    }
  | { kind: 'ed25519'; keyId: string; keyFingerprint: string };

/** What the installer verified about the bytes it is installing. */
export type VerifiedPluginSignature =
  | { kind: 'sigstore'; identity: SigstoreCertificateIdentity }
  | { kind: 'ed25519'; keyId: string; keyFingerprint: string }
  | null;

export function pluginSigner(
  signature: VerifiedPluginSignature,
): PluginSigner | null {
  if (signature === null) return null;
  if (signature.kind === 'ed25519') return { ...signature };
  const san = signature.identity.subjectAlternativeName;
  const at = san.lastIndexOf('@');
  return {
    kind: 'sigstore',
    issuer: signature.identity.issuer,
    identity: at > 0 ? san.slice(0, at) : san,
    repositoryId: signature.identity.repositoryId,
    ownerId: signature.identity.ownerId,
  };
}

// UNWIRED(#2998): the installer records provenance once install trust records land.
/**
 * `kontour` needs both the pinned identity and a lock entry for the name read
 * from the verified artifact's manifest, naming that same identity. The same
 * workflow may release examples and templates; those are `publisher`, and so
 * is any other identity that ships a locked name.
 */
export function pluginProvenance(input: {
  signature: VerifiedPluginSignature;
  manifestName: string;
  pins: readonly SigstoreSignerPin[];
  lock: PluginsLockMembership;
}): PluginProvenance {
  const { signature } = input;
  if (signature === null) return 'unsigned';
  if (signature.kind === 'ed25519') return 'publisher';
  const lockedPin = input.lock.get(input.manifestName);
  const kontour =
    lockedPin !== undefined &&
    input.pins.some(
      (pin) =>
        samePin(pin, lockedPin) && matchesSignerPin(signature.identity, pin),
    );
  return kontour ? 'kontour' : 'publisher';
}

/**
 * Owner decision 3 (2026-09-29): Kontour-signed starts at tier 2, unsigned at
 * tier 3. Publisher-signed is OPEN-3; this applies its proposed default, 3.
 */
function defaultTrustTier(
  provenance: PluginProvenance,
): PluginTrustTier {
  return provenance === 'kontour' ? 2 : 3;
}

function sameSigner(a: PluginSigner, b: PluginSigner): boolean {
  if (a.kind === 'ed25519')
    return b.kind === 'ed25519' && a.keyFingerprint === b.keyFingerprint;
  return (
    b.kind === 'sigstore' &&
    a.issuer === b.issuer &&
    a.identity === b.identity &&
    a.repositoryId === b.repositoryId &&
    a.ownerId === b.ownerId
  );
}

export type PluginTrustDecision =
  /** No earlier record: the provenance default applies. */
  | { kind: 'initial'; tier: PluginTrustTier }
  /** Same bytes under the same signer (or still unsigned): nothing changed. */
  | { kind: 'unchanged'; tier: PluginTrustTier }
  /** New digest under the same pinned signer: the tier is kept. */
  | { kind: 'inherited'; tier: PluginTrustTier }
  /**
   * The earlier decision does not carry over: the signer differs, or the
   * plugin is unsigned and its bytes changed. The provenance default applies
   * and the operator decides again.
   */
  | {
      kind: 'new-decision';
      reason: 'signer-changed' | 'unsigned-content-changed';
      tier: PluginTrustTier;
    };

// UNWIRED(#2998): the installer records this decision once install trust records land.
export function decidePluginTrust(input: {
  previous: {
    signer: PluginSigner | null;
    contentDigest: string;
    tier: PluginTrustTier;
  } | null;
  signer: PluginSigner | null;
  provenance: PluginProvenance;
  contentDigest: string;
}): PluginTrustDecision {
  const fallback = defaultTrustTier(input.provenance);
  const { previous, signer } = input;
  if (previous === null) return { kind: 'initial', tier: fallback };
  const signerKept =
    previous.signer === null || signer === null
      ? previous.signer === signer
      : sameSigner(previous.signer, signer);
  if (!signerKept)
    return { kind: 'new-decision', reason: 'signer-changed', tier: fallback };
  if (previous.contentDigest === input.contentDigest)
    return { kind: 'unchanged', tier: previous.tier };
  if (signer === null)
    return {
      kind: 'new-decision',
      reason: 'unsigned-content-changed',
      tier: fallback,
    };
  return { kind: 'inherited', tier: previous.tier };
}
