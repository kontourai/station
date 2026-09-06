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
  onReview: (candidate: ConnectionCandidate) => Promise<boolean>;
  onOpen: (candidate: ConnectionCandidate) => void;
  onBack: () => void;
}

export function ConnectionManagerDiscoverPanel({
  discovering,
  candidates,
  providers,
  providerCount,
  existingUrls,
  onRefresh,
  onReview,
  onOpen,
  onBack,
}: ConnectionManagerDiscoverPanelProps) {
  const [checkingId, setCheckingId] = React.useState<string | null>(null);
  const checkingRef = React.useRef<string | null>(null);
  const mountedRef = React.useRef(true);
  const [reviewedIds, setReviewedIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [reviewErrorId, setReviewErrorId] = React.useState<string | null>(null);
  const failedProviders = providers.filter(
    (provider) => provider.status === 'failed',
  ).length;
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
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
        Connection suggestions are reachability hints. Station verifies the
        environment and requests access before trusting a new browser.
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
          Automatic discovery is not available in this browser. Station does not
          scan every address on your network. Use a saved Station, pair with a
          code, or add an address from Advanced options.
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
              ? 'Checking available connection providers…'
              : candidates.length > 0
                ? `${candidates.length} Station suggestion${candidates.length === 1 ? '' : 's'}`
                : failedProviders > 0
                  ? 'No suggestions available; a provider could not respond.'
                  : 'No other Stations are currently advertised.'}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={discovering || checkingId !== null}
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
            const reviewed = reviewedIds.has(candidate.id);
            const checking = checkingId === candidate.id;
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
                    {SOURCE_LABEL[candidate.source]} ·{' '}
                    {reviewed
                      ? 'Station found · Access not granted'
                      : 'Unverified'}
                    <br />
                    {candidate.url}
                    {reviewErrorId === candidate.id && (
                      <span
                        role="alert"
                        style={{
                          display: 'block',
                          color: 'var(--error-text, #ef4444)',
                        }}
                      >
                        This suggestion did not answer with a valid Station
                        identity. It was not saved or opened.
                      </span>
                    )}
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
                    disabled={checkingId !== null}
                    onClick={() => {
                      if (reviewed) {
                        onOpen(candidate);
                        return;
                      }
                      if (checkingRef.current) return;
                      checkingRef.current = candidate.id;
                      setCheckingId(candidate.id);
                      setReviewErrorId(null);
                      void onReview(candidate).then(
                        (valid) => {
                          if (!mountedRef.current) return;
                          if (checkingRef.current === candidate.id) {
                            checkingRef.current = null;
                          }
                          setCheckingId((current) =>
                            current === candidate.id ? null : current,
                          );
                          if (valid) {
                            setReviewedIds((current) =>
                              new Set(current).add(candidate.id),
                            );
                          } else {
                            setReviewErrorId(candidate.id);
                          }
                        },
                        () => {
                          if (!mountedRef.current) return;
                          if (checkingRef.current === candidate.id) {
                            checkingRef.current = null;
                          }
                          setCheckingId((current) =>
                            current === candidate.id ? null : current,
                          );
                          setReviewErrorId(candidate.id);
                        },
                      );
                    }}
                    style={primaryBtnStyle}
                  >
                    {checking
                      ? 'Checking…'
                      : reviewed
                        ? 'Open Station'
                        : 'Check'}
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
