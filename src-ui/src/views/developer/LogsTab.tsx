import { useServerLogsQuery } from '@kontourai/station-sdk/developer-runtime';
import { useState } from 'react';
import { HostAction } from '../../components/host-action/HostAction';
import { Empty, ErrorState, Skeleton } from '../../components/state';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useDevicePresentation } from '../../hooks/useDevicePresentation';

const LEVELS = ['', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export default function LogsTab() {
  const { apiBase } = useApiBase();
  // #3843 T3. D6 redacts this read for any principal that did not prove home
  // possession, and it is right to. What was missing is the sentence: a page
  // that quietly serves `[REDACTED]` reads as a broken page rather than as a
  // correct boundary. The read itself is remote-safe — the host performs it
  // and this device only asks — so the affordance stays and the host is named
  // beside it, which is exactly `HostAction`'s remote-safe branch. Note it
  // does NOT claim the entries in view were redacted: the projection says
  // which device is asking, and that is all it says.
  const devicePresentation = useDevicePresentation();
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('');
  const [q, setQuery] = useState('');
  const [limit, setLimit] = useState(100);
  const { data, error, isLoading, refetch } = useServerLogsQuery(apiBase, {
    ...(level ? { level } : {}),
    ...(q ? { q } : {}),
    limit,
  });

  return (
    <section className="developer-tab" aria-label="Logs">
      <div className="developer-tab__controls">
        <label>
          Minimum level
          <select
            value={level}
            onChange={(event) => setLevel(event.target.value as typeof level)}
          >
            <option value="">All levels</option>
            {LEVELS.slice(1).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search
          <input
            value={q}
            onChange={(event) => setQuery(event.target.value)}
            // Not "Search redacted logs": that said `redacted` to a local
            // operator who is receiving UNREDACTED bytes, which is a state
            // word nothing on this page derived. Whether the read is redacted
            // follows from the device class, and the host-named sentence
            // below the list is where that is said.
            placeholder="Search logs"
          />
        </label>
        <label>
          Limit
          <select
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
          >
            {[50, 100, 200, 500].map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </div>
      {isLoading ? <Skeleton variant="block" /> : null}
      {error ? (
        // A transient outage's error must not read as a permanently broken
        // tab (owner report; live diagnosis 2026-08-14: server + scope
        // healthy, the cached error simply had no way out).
        <ErrorState
          variant="compact"
          title="Unable to load server logs."
          action={
            <button
              type="button"
              className="button"
              onClick={() => void refetch()}
            >
              Try again
            </button>
          }
        />
      ) : null}
      {!isLoading && !error ? (
        <HostAction id="developer-logs" presentation={devicePresentation}>
          {data?.entries.length ? (
            <ul className="developer-tab__logs" aria-label="Server logs">
              {data.entries.map((entry, index) => (
                <li key={`${entry.timestamp ?? 'unknown'}-${index}`}>
                  <code>
                    {entry.timestamp ?? 'unknown time'}{' '}
                    {entry.level ?? 'unknown'}{' '}
                    {entry.msg ?? JSON.stringify(entry)}
                  </code>
                </li>
              ))}
            </ul>
          ) : (
            <Empty variant="compact" label="No matching logs available." />
          )}
        </HostAction>
      ) : null}
      {data?.truncated ? (
        <p className="developer-tab__hint">
          Results may be incomplete because the server log scan was bounded.
        </p>
      ) : null}
    </section>
  );
}
