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
  type PluginProvenance,
  type PluginSigner,
  type PluginsLockMembership,
  pluginProvenance,
  pluginSigner,
  type SigstoreSignerPin,
  type VerifiedPluginSignature,
} from './plugin-install-trust.js';
import {
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
}): Promise<PreparedPluginInstallTrust> {
  // Read first: an unreadable store refuses before any verification work.
  const previous = readPluginTrustRecord(
    input.projectHomeDir,
    input.pluginName,
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

export function pluginTrustRecordFor(
  prepared: PreparedPluginInstallTrust,
  installedDigest: string,
  now: Date,
): PluginTrustRecord {
  const previous =
    prepared.previous.state === 'recorded' ? prepared.previous.record : null;
  const decision = decidePluginTrust({
    previous: previous
      ? {
          signer: previous.signer,
          // A grandfathered record whose bytes were unreadable matches nothing.
          contentDigest: previous.contentDigest ?? '',
          tier: previous.tier,
        }
      : null,
    signer: prepared.signer,
    provenance: prepared.provenance,
    contentDigest: installedDigest,
  });
  return {
    version: 1,
    signer: prepared.signer,
    provenance: prepared.provenance,
    contentDigest: installedDigest,
    tier: decision.tier,
    decision:
      decision.kind === 'unchanged' && previous?.decision === 'grandfathered'
        ? 'grandfathered'
        : decision.kind,
    ...(decision.kind === 'new-decision'
      ? {
          reason: decision.reason,
          ...(previous ? { priorTier: previous.tier } : {}),
        }
      : {}),
    decidedBy:
      decision.kind === 'unchanged' && previous
        ? previous.decidedBy
        : 'station',
    decidedAt:
      decision.kind === 'unchanged' && previous
        ? previous.decidedAt
        : now.toISOString(),
  };
}
