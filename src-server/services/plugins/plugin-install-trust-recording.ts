/**
 * Install-time trust decisions (#2998, slice d1 part 2). The installer calls
 * {@link preparePluginInstallTrust} before any effect and
 * {@link pluginTrustRecordFor} once the installed bytes are final.
 *
 * Provenance always comes from THIS install's own verification: the
 * Sigstore bundle supplied for these bytes, verified now, or the registry
 * receipt captured for this acquisition. The stored record contributes only
 * the earlier tier and signer the decision compares against; it never
 * supplies provenance.
 */
import {
  decidePluginTrust,
  defaultTrustTier,
  type PluginProvenance,
  type PluginSigner,
  type PluginsLockMembership,
  pluginProvenance,
  pluginSigner,
  type SigstoreSignerPin,
  type VerifiedPluginSignature,
} from './plugin-install-trust.js';
import {
  type PluginTrustMigrationWitness,
  type PluginTrustRecord,
  type PluginTrustRecordState,
  readPluginTrustRecord,
} from './plugin-install-trust-store.js';
import {
  createPluginSigstoreVerifier,
  type PluginSigstoreRefusalReason,
  type PluginSigstoreVerifier,
} from './plugin-sigstore-verifier.js';

export interface PluginInstallTrustPolicy {
  pins: readonly SigstoreSignerPin[];
  lock: PluginsLockMembership;
  verifier: PluginSigstoreVerifier;
  // UNWIRED(#3995): no production acquisition supplies a bundle until i0's bundled payload.
  /**
   * The Sigstore bundle bytes delivered with this source, if any. No
   * production acquisition delivers one yet: the bundled payload (i0) is the
   * first. A delivered bundle that does not verify refuses the install; it
   * never falls back to unsigned.
   */
  sigstoreBundle?: (request: {
    pluginName: string;
    sourceDigest: string;
  }) => Promise<Uint8Array | null>;
}

/**
 * Production policy: no pinned identity (station-plugins does not exist
 * yet, so nothing is `kontour`), an empty lock, the embedded-root verifier,
 * and no bundle channel.
 */
export function defaultPluginInstallTrustPolicy(): PluginInstallTrustPolicy {
  return {
    pins: [],
    lock: new Map(),
    verifier: createPluginSigstoreVerifier(),
  };
}

export class PluginInstallTrustRefused extends Error {
  readonly code = 'plugin-install-trust-refused';
  constructor(readonly reason: PluginSigstoreRefusalReason) {
    super(`The plugin's Sigstore bundle was refused (${reason}).`);
    this.name = 'PluginInstallTrustRefused';
  }
}

export interface PreparedPluginInstallTrust {
  signer: PluginSigner | null;
  provenance: PluginProvenance;
  previous: PluginTrustRecordState;
}

export async function preparePluginInstallTrust(input: {
  projectHomeDir: string;
  pluginName: string;
  /** The name read from the manifest of the bytes being installed. */
  manifestName: string;
  /** The source digest consent and registry claims bind (pre-build). */
  sourceDigest: string;
  /** Signer of the registry receipt captured for this acquisition, if any. */
  registrySigner: { keyId: string; spkiFingerprint: string } | null;
  policy: PluginInstallTrustPolicy;
  witness?: PluginTrustMigrationWitness;
}): Promise<PreparedPluginInstallTrust> {
  // Read first: an unreadable store refuses before any verification work.
  const previous = readPluginTrustRecord(
    input.projectHomeDir,
    input.pluginName,
    input.witness,
  );
  const bundleBytes = await input.policy.sigstoreBundle?.({
    pluginName: input.pluginName,
    sourceDigest: input.sourceDigest,
  });
  let signature: VerifiedPluginSignature = null;
  if (bundleBytes) {
    const verified = input.policy.verifier.verify({
      bundleBytes,
      artifactDigest: input.sourceDigest,
    });
    if (verified.state !== 'verified')
      throw new PluginInstallTrustRefused(verified.reason);
    signature = { kind: 'sigstore', identity: verified.identity };
  } else if (input.registrySigner) {
    signature = {
      kind: 'ed25519',
      keyId: input.registrySigner.keyId,
      keyFingerprint: input.registrySigner.spkiFingerprint,
    };
  }
  return {
    signer: pluginSigner(signature),
    provenance: pluginProvenance({
      signature,
      manifestName: input.manifestName,
      pins: input.policy.pins,
      lock: input.policy.lock,
    }),
    previous,
  };
}

/**
 * The record for the installed bytes. `installedBefore` is whether this name
 * was installed when the install began: a record that survived an uninstall
 * is compared against, but a reinstall never keeps a tier above what its own
 * provenance allows.
 */
export function pluginTrustRecordFor(
  prepared: PreparedPluginInstallTrust,
  installedDigest: string,
  now: Date,
  options: { installedBefore: boolean },
): PluginTrustRecord {
  const previous =
    prepared.previous.state === 'recorded' ? prepared.previous.record : null;
  const fallback = defaultTrustTier(prepared.provenance);
  if (previous && !options.installedBefore && previous.tier < fallback)
    return {
      version: 1,
      signer: prepared.signer,
      provenance: prepared.provenance,
      contentDigest: installedDigest,
      tier: fallback,
      decision: 'new-decision',
      reason: 'tier-exceeds-provenance',
      priorTier: previous.tier,
      decidedBy: 'station',
      decidedAt: now.toISOString(),
    };
  const decision = decidePluginTrust({
    previous: previous
      ? {
          signer: previous.signer,
          contentDigest: previous.contentDigest,
          tier: previous.tier,
        }
      : null,
    signer: prepared.signer,
    provenance: prepared.provenance,
    contentDigest: installedDigest,
  });
  // Same bytes under the same signer: the earlier decision stands as it was,
  // including a grandfathered or pending new decision and its reason and
  // prior tier. Only signer and provenance are this install's own.
  if (decision.kind === 'unchanged' && previous)
    return {
      ...previous,
      signer: prepared.signer,
      provenance: prepared.provenance,
    };
  return {
    version: 1,
    signer: prepared.signer,
    provenance: prepared.provenance,
    contentDigest: installedDigest,
    tier: decision.tier,
    decision: decision.kind,
    ...(decision.kind === 'new-decision'
      ? {
          reason: decision.reason,
          ...(previous ? { priorTier: previous.tier } : {}),
        }
      : {}),
    decidedBy: 'station',
    decidedAt: now.toISOString(),
  };
}
