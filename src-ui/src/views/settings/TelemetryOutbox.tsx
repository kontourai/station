import type {
  TelemetryOutboxEntry,
  TelemetryPublisherId,
} from '@kontourai/station-contracts/product-telemetry';
import { authenticatedFetch, getJson } from '@kontourai/station-sdk';
import { DEFAULT_CLIENT_REQUEST_TIMEOUT_MS } from '@kontourai/station-sdk/client';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { SHARING_LABELS } from '../../components/UsageSharingChoices';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useOptionalRecoveryScope } from '../../contexts/RecoveryQueryBoundary';
import { telemetryPublisherLabel } from '../../hooks/useTelemetryStatus';
import '../../components/TelemetryPrivacy.css';

const SUPPRESSED = new Set([
  'off',
  'DNT',
  'disclosure',
  'notice',
  'unconfigured',
]);
const LIMIT = 50;

export function TelemetryOutbox({
  publisher,
}: {
  publisher: TelemetryPublisherId;
}) {
  const { apiBase } = useApiBase();
  const scope = useOptionalRecoveryScope();
  const targetBase = scope?.apiBase ?? apiBase;
  const query = useQuery({
    queryKey: ['telemetry-outbox', targetBase, scope?.identityKey, publisher],
    queryFn: async ({ signal }): Promise<TelemetryOutboxEntry[]> => {
      const url = `${targetBase}/api/usage-telemetry/outbox?publisher=${encodeURIComponent(publisher)}&limit=${LIMIT}`;
      const response = scope
        ? await getJson(url, {
            signal,
            timeoutMs: DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
            ...(scope.requestScope ? { requestScope: scope.requestScope } : {}),
          })
        : await authenticatedFetch(url, { signal });
      if (!response.ok) throw new Error('The outbox could not be loaded.');
      return (await response.json()).data;
    },
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const entries = query.data
    ?.filter((entry) => entry.publisher === publisher)
    .slice(-LIMIT)
    .reverse();
  return (
    <section
      className="telemetry-outbox"
      aria-label={`What was sent to ${telemetryPublisherLabel(publisher)}`}
    >
      <p>
        Latest {LIMIT} records per destination. Local history retains at most 30
        days and 5 MiB across destinations; oldest records are evicted.
        Suppressed and dropped records show reasons and counts, without a
        payload viewer.
      </p>
      <Button
        size="sm"
        variant="secondary"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Refresh {telemetryPublisherLabel(publisher)} outbox
      </Button>
      {query.isLoading && (
        <SkeletonBlock count={1} label="Reading telemetry history" />
      )}
      {query.isError && (
        <ErrorState
          variant="compact"
          title="The outbox could not be loaded"
          description="Use Refresh to try again."
        />
      )}
      {entries?.length === 0 && (
        <Empty
          variant="compact"
          label="Nothing has been sent to this destination."
        />
      )}
      <ol className="telemetry-outbox__list">
        {entries?.map((entry, index) => (
          <li key={`${entry.recordedAt}:${index}`}>
            <p>
              <strong>
                {entry.outcome === 'sent'
                  ? 'Sent'
                  : SUPPRESSED.has(entry.reason)
                    ? 'Suppressed'
                    : 'Dropped'}
              </strong>{' '}
              · {SHARING_LABELS[entry.tier]} · {entry.reason} ·{' '}
              <time dateTime={entry.recordedAt}>{entry.recordedAt}</time>
            </p>
            {entry.outcome === 'sent' ? (
              <details>
                <summary>View sent payload JSON</summary>
                <pre>{JSON.stringify(entry.payload, null, 2)}</pre>
              </details>
            ) : (
              <p>
                {entry.payload &&
                typeof entry.payload === 'object' &&
                'count' in entry.payload
                  ? `${entry.payload.count} ${entry.payload.count === 1 ? 'observation' : 'observations'}`
                  : 'Payload not displayed for an unsent record.'}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
