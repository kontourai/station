import React from 'react';
import type { ConnectionCandidateProviderResult } from '../core/connectionCandidates';
import type {
  ConnectionCandidate,
  ConnectionCandidateSource,
} from '../core/types';

const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 14px',
  minHeight: 44,
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 8,
  border: 'none',
  cursor: 'pointer',
  background: 'var(--accent-primary, #3b82f6)',
  color: 'var(--text-on-accent, white)',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '10px 20px',
  minHeight: 44,
  fontSize: 13,
  fontWeight: 500,
  borderRadius: 8,
  border: '1px solid var(--border-primary, #333)',
  cursor: 'pointer',
  background: 'transparent',
  color: 'var(--text-primary, #e5e5e5)',
};

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p
        style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.5,
          color: 'var(--text-secondary, #999)',
        }}
      >
        Choose your computer. You’ll still need to approve access there.
      </p>

      {providerCount === 0 ? (
        <div
          role="status"
          style={{
            border: '1px solid var(--border-primary, #333)',
            borderRadius: 8,
            padding: 14,
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--text-secondary, #999)',
          }}
        >
          Nearby discovery is not available here. Scan a QR code, enter a
          pairing code, or use a Station address instead.
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <span
            role="status"
            style={{
              flex: '1 1 180px',
              fontSize: 13,
              color: 'var(--text-secondary, #999)',
            }}
          >
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {candidates.map((candidate) => {
            const alreadyAdded = existingUrls.has(candidate.url);
            return (
              <div
                key={candidate.id}
                style={{
                  background: 'var(--bg-primary, #0a0a0a)',
                  border: '1px solid var(--border-primary, #333)',
                  borderRadius: 8,
                  padding: 12,
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>
                    {candidate.name}
                  </div>
                  <div
                    style={{
                      marginTop: 2,
                      fontSize: 11,
                      color: 'var(--text-secondary, #999)',
                      overflowWrap: 'anywhere',
                    }}
                  >
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
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--text-secondary, #999)',
                    }}
                  >
                    Saved
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Request access to ${candidate.name}`}
                    onClick={() => onSelect(candidate)}
                    style={primaryBtnStyle}
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
