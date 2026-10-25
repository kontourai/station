import type { PluginRegistryTrust } from '@kontourai/station-contracts/registry-trust';
import './PluginRegistryTrustSection.css';

/**
 * #1521: the registry claim and pin the server persisted, rendered as-is.
 *
 * Every value here comes from the host's own verification receipt. Nothing is
 * read from the package manifest, and no state is inferred client-side: an
 * absent or unreadable receipt is said plainly rather than implying a check.
 */
export function PluginRegistryTrustSection({
  trust,
  context,
}: {
  trust: PluginRegistryTrust | undefined;
  /** A preview binds a fresh check; an installation shows its stored receipt. */
  context: 'preview' | 'installed';
}) {
  return (
    <section
      className="detail-panel__section plugin-registry-trust"
      aria-label="Registry verification"
    >
      <div className="plugins__settings-header">Registry verification</div>
      <RegistryTrustBody trust={trust} context={context} />
    </section>
  );
}

function RegistryTrustBody({
  trust,
  context,
}: {
  trust: PluginRegistryTrust | undefined;
  context: 'preview' | 'installed';
}) {
  const subject = context === 'preview' ? 'package' : 'installation';
  if (!trust)
    return (
      <p className="plugin-registry-trust__note">
        Station did not report registry verification for this {subject}. Treat
        it as unverified.
      </p>
    );
  if (trust.state === 'unavailable')
    return (
      <p className="plugin-registry-trust__note">
        The stored registry verification for this installation could not be
        read. Station does not treat it as verified.
      </p>
    );
  if (trust.state === 'none')
    return (
      <p className="plugin-registry-trust__note">
        No verified registry claim. Station has no verified source, signer or
        registry pin for this {subject}.
      </p>
    );
  const { receipt } = trust;
  return (
    <>
      <p className="plugin-registry-trust__note">
        {context === 'preview'
          ? 'Station checked these bytes against the registry claim under the applied trust policy. Installing binds this exact claim and pin.'
          : 'Recorded when this installation was verified. This is the stored receipt, not a fresh check.'}
      </p>
      <dl className="plugin-registry-trust__list">
        <dt>Source</dt>
        <dd>
          Registry entry <code>{receipt.registryId}</code>
          <span className="plugin-registry-trust__detail">
            Registry key <code>{receipt.registryKeyDigest}</code>
          </span>
        </dd>
        <dt>Package digest</dt>
        <dd>
          <code>{receipt.packageDigest}</code>
        </dd>
        <dt>Signer</dt>
        <dd>
          {receipt.signer ? (
            <>
              Key <code>{receipt.signer.keyId}</code>
              <span className="plugin-registry-trust__detail">
                Fingerprint <code>{receipt.signer.spkiFingerprint}</code>
              </span>
            </>
          ) : (
            'Unsigned. No signer was verified.'
          )}
        </dd>
        <dt>Pin</dt>
        <dd>
          <code>{trust.revision}</code>
          <span className="plugin-registry-trust__detail">
            Claim <code>{receipt.claimDigest}</code>
          </span>
        </dd>
        <dt>Policy</dt>
        <dd>
          {policyOutcome(context, receipt.signer !== null)}
          <span className="plugin-registry-trust__detail">
            Scope <code>{receipt.policyScope}</code>, epoch{' '}
            <code>{receipt.policyEpoch}</code>
          </span>
          <span className="plugin-registry-trust__detail">
            Fingerprint <code>{receipt.policyFingerprint}</code>
          </span>
        </dd>
      </dl>
    </>
  );
}

/** A preview states the policy it was just checked against; an installation
 * reports the policy recorded with its receipt, which is not re-checked here. */
function policyOutcome(context: 'preview' | 'installed', signed: boolean) {
  if (context === 'preview')
    return signed
      ? 'Signature verified with a key this policy trusts.'
      : 'Unsigned package accepted because this policy does not require signatures.';
  return signed
    ? 'Signature verified with a key the recorded policy trusted.'
    : 'Unsigned package accepted because the recorded policy did not require signatures.';
}
