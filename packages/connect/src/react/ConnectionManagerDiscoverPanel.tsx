import type { ConnectionCandidateProviderResult } from '../core/connectionCandidates';
import {
  httpConnectionConsentRequired,
  httpDevelopmentOrigin,
} from '../core/hostInput';
import type {
  ConnectionCandidate,
  ConnectionCandidateSource,
} from '../core/types';
import './ConnectionManagerModal.css';

const SOURCE_LABEL: Record<ConnectionCandidateSource, string> = {
  'lan-dns-sd': 'Local network',
  tailnet: 'Tailnet',
  'desktop-host': 'Desktop host',
};

interface ConnectionManagerDiscoverPanelProps {
  discovering: boolean;
  candidates: ConnectionCandidate[];
  providers: ConnectionCandidateProviderResult[];
  providerCount: number;
  existingUrls: Set<string>;
  onRefresh: () => void;
  onSelect: (candidate: ConnectionCandidate) => void;
  onBack?: () => void;
}

export function ConnectionManagerDiscoverPanel({
  discovering,
  candidates,
  providers,
  providerCount,
  existingUrls,
  onRefresh,
  onSelect,
  onBack,
}: ConnectionManagerDiscoverPanelProps) {
  const cancelled = providers.some(
    (provider) => provider.status === 'cancelled',
  );
  const permissionRequired = providers.some(
    (provider) => provider.status === 'permission-required',
  );
  const denied = providers.some(
    (provider) => provider.status === 'permission-denied',
  );
  const unavailable = providers.some(
    (provider) => provider.status === 'unavailable',
  );
  const timedOut = providers.some(
    (provider) => provider.status === 'timed-out',
  );
  const failed = providers.some((provider) => provider.status === 'failed');
  return (
    <div className="station-connect-discovery">
      <p className="station-connect-discovery__intro">
        Choose your computer. You’ll still need to approve access there.
      </p>

      {providerCount === 0 ? (
        <div role="status" className="station-connect-discovery__empty">
          Nearby discovery is not available here. Scan a QR code, enter a
          pairing code, or use a Station address instead.
        </div>
      ) : (
        <div className="station-connect-discovery__toolbar">
          <span role="status" className="station-connect-discovery__status">
            {discovering
              ? 'Looking for nearby Stations…'
              : candidates.length > 0
                ? `${candidates.length} Station suggestion${candidates.length === 1 ? '' : 's'}`
                : permissionRequired
                  ? 'Allow local network access when asked. After returning to Station, choose Check again.'
                  : denied
                    ? 'Local network permission is denied. Allow access in system settings, then check again.'
                    : unavailable
                      ? 'Local network discovery is unavailable on this device. Use a QR code or address.'
                      : timedOut
                        ? 'Discovery did not finish in time. Check network access, then try again.'
                        : cancelled
                          ? 'Discovery stopped. Keep Station open and check again.'
                          : failed
                            ? 'Local network discovery failed. Try again or use a QR code.'
                            : 'No Stations found. On your computer, enable nearby discovery in Settings → Devices → Pairing.'}
          </span>
          <button
            type="button"
            onClick={() => {
              if (!discovering) onRefresh();
            }}
            aria-disabled={discovering || undefined}
            className="station-connect-btn station-connect-btn--quiet"
          >
            {discovering ? 'Checking…' : 'Check again'}
          </button>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="station-connect-discovery__candidates">
          {candidates.map((candidate) => {
            const alreadyAdded = existingUrls.has(candidate.url);
            const needsHttpConsent =
              !alreadyAdded &&
              httpConnectionConsentRequired(candidate.url) &&
              !httpDevelopmentOrigin(candidate.url);
            return (
              <div
                key={candidate.id}
                className="station-connect-discovery__candidate"
              >
                <div className="station-connect-discovery__candidate-name">
                  {candidate.name}
                </div>
                <p className="station-connect-discovery__candidate-meta">
                  {SOURCE_LABEL[candidate.source]} · Unverified
                  {!alreadyAdded && ' · Access not granted'}
                </p>
                {candidate.url.startsWith('http:') && (
                  <p className="station-connect-discovery__http-warning">
                    Unencrypted HTTP
                    {needsHttpConsent && ' · consent required'}
                  </p>
                )}
                <div className="station-connect-discovery__candidate-actions">
                  <details className="station-connect-discovery__identity">
                    <summary
                      aria-label={`Connection details for ${candidate.name}`}
                    >
                      Connection details
                    </summary>
                    <dl>
                      <dt>Full name</dt>
                      <dd>{candidate.name}</dd>
                      <dt>Station address</dt>
                      <dd>{candidate.url}</dd>
                    </dl>
                  </details>
                  {alreadyAdded ? (
                    <span className="station-connect-discovery__saved">
                      Saved
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Request access to ${candidate.name}`}
                      onClick={() => onSelect(candidate)}
                      className="station-connect-btn station-connect-btn--primary"
                    >
                      Request access
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {onBack && (
        <button
          type="button"
          className="station-connect-btn station-connect-btn--quiet station-connect-discovery__back"
          onClick={onBack}
        >
          Back
        </button>
      )}
    </div>
  );
}
