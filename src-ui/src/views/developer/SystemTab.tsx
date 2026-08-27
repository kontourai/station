import { useConnectionStatus } from '@kontourai/station-connect';
import { useSystemStatusForApiBaseQuery } from '@kontourai/station-sdk';
import {
  useBootHistoryQuery,
  useSystemInstanceQuery,
} from '@kontourai/station-sdk/developer-runtime';
import {
  Empty,
  ErrorState,
  SkeletonBlock,
  SkeletonList,
} from '../../components/state';
import {
  checkServerHealth,
  probeServerConnection,
} from '../../lib/serverHealth';
import { BuildProvenance } from '../settings/BuildProvenance';
import './SystemTab.css';
import { relativeTimeAgo } from '../../utils/relativeTime';

export default function SystemTab({ apiBase }: { apiBase: string }) {
  const { data: instance, isLoading } = useSystemInstanceQuery(apiBase);
  const { data: status } = useSystemStatusForApiBaseQuery(apiBase);
  const bootHistory = useBootHistoryQuery(apiBase);
  const connection = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
  });

  return (
    <section className="developer-tab" aria-label="System">
      <BuildProvenance build={status?.build} />
      <div className="system-tab__grid">
        <section
          className="system-tab__card"
          aria-labelledby="this-station-title"
        >
          <h2 id="this-station-title">This Station</h2>
          <dl className="system-tab__facts">
            <div>
              <dt>Uptime</dt>
              <dd>
                {bootHistory.data
                  ? formatDuration(bootHistory.data.currentUptimeSeconds)
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Boot time</dt>
              <dd>
                {bootHistory.data?.records[0]
                  ? formatDate(bootHistory.data.records[0].bootTime)
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Current build</dt>
              <dd>
                {status?.build?.shortSha ??
                  status?.build?.fullSha ??
                  'Unavailable'}
              </dd>
            </div>
          </dl>
        </section>
        <section
          className="system-tab__card"
          aria-labelledby="connection-title"
        >
          <h2 id="connection-title">Connection (this device)</h2>
          <p className="system-tab__connection">
            <strong>{connection.status}</strong>
            {connection.reason ? ` · ${connection.reason}` : ''} · streak{' '}
            {connection.failureStreak}
          </p>
          <p className="system-tab__muted">
            Device-local view for this browser session.
          </p>
          {connection.failureWindows.length ? (
            <ul className="system-tab__rows">
              {connection.failureWindows.map((window, index) => (
                <li key={`${window.start}-${index}`}>
                  {formatDate(window.start)} · {window.reason} sustained failure
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              label="No sustained failures in this session"
              variant="compact"
            />
          )}
        </section>
      </div>
      <section
        className="system-tab__card"
        aria-labelledby="restart-history-title"
      >
        <h2 id="restart-history-title">Restart history</h2>
        {bootHistory.isLoading ? (
          <SkeletonList count={3} />
        ) : bootHistory.isError ? (
          <ErrorState
            title="Restart history unavailable"
            variant="compact"
            action={
              <button
                type="button"
                className="button"
                onClick={() => void bootHistory.refetch()}
              >
                Try again
              </button>
            }
          />
        ) : bootHistory.data?.records.length ? (
          <ul className="system-tab__rows">
            {bootHistory.data.records.map((record, index) => (
              <li key={`${record.bootTime}-${index}`}>
                <span>{timeAgo(record.bootTime)}</span>
                <span>
                  {record.shortSha ?? record.fullSha ?? 'Build unavailable'}
                </span>
                {record.cause ? (
                  <span className="system-tab__cause">{record.cause}</span>
                ) : null}
                {record.source === 'derived' ? (
                  <span className="system-tab__derived">derived from logs</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty label="No boot records yet" variant="compact" />
        )}
      </section>
      <h2>Instance identity</h2>
      {isLoading ? (
        <SkeletonBlock count={1} label="Loading instance details" />
      ) : (
        <pre className="developer-tab__pre">
          {instance
            ? JSON.stringify(instance, null, 2)
            : 'Instance details unavailable.'}
        </pre>
      )}
    </section>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}
// Shared work-item convention (src-ui/src/utils/relativeTime.ts) — one
// relative-time story across Home lanes, inbox, switcher, and this tab.
function timeAgo(value: string): string {
  return relativeTimeAgo(Date.parse(value), Date.now());
}
