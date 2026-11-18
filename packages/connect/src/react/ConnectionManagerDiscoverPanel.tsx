import type { ConnectionCandidateProviderResult } from '../core/connectionCandidates';
import type {
  ConnectionCandidate,
  ConnectionCandidateSource,
} from '../core/types';
import {
  compactPrimaryBtnStyle,
  secondaryBtnStyle,
} from './connection-manager-modal/styles';
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
  onBack: () => void;
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
            onClick={onRefresh}
            disabled={discovering}
            style={secondaryBtnStyle}
          >
            {discovering ? 'Checking…' : 'Check again'}
          </button>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="station-connect-discovery__candidates">
          {candidates.map((candidate) => {
            const alreadyAdded = existingUrls.has(candidate.url);
            return (
              <div
                key={candidate.id}
                className="station-connect-discovery__candidate"
              >
                <div className="station-connect-discovery__candidate-details">
                  <div className="station-connect-discovery__candidate-name">
                    {candidate.name}
                  </div>
                  <div className="station-connect-discovery__candidate-meta">
                    {SOURCE_LABEL[candidate.source]} · Unverified · Access not
                    granted
                    <br />
                    {candidate.url}
                    <br />
                    {candidate.url.startsWith('http:')
                      ? 'Unencrypted HTTP · requires your consent'
                      : 'HTTPS · still requires access approval'}
                  </div>
                </div>
                {alreadyAdded ? (
                  <span className="station-connect-discovery__saved">
                    Saved
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Request access to ${candidate.name}`}
                    onClick={() => onSelect(candidate)}
                    style={compactPrimaryBtnStyle}
                  >
                    Request access
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <button type="button" onClick={onBack} style={secondaryBtnStyle}>
        Back
      </button>
    </div>
  );
}
