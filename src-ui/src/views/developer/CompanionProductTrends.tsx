import { useTelemetryCompanionProductTrendsQuery } from '@kontourai/station-sdk';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { SkeletonBlock } from '../../components/state';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';

function windowFor(days: number) {
  const end = new Date();
  return {
    from: new Date(end.getTime() - days * 86400000).toISOString(),
    to: end.toISOString(),
  };
}

export function CompanionProductTrends({
  authority,
}: {
  authority: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const [days, setDays] = useState(7);
  const [window, setWindow] = useState(() => windowFor(7));
  const [release, setRelease] = useState('');
  const [page, setPage] = useState(0);
  const query = useTelemetryCompanionProductTrendsQuery(
    authority.apiBase,
    window,
    { requestScope: authority },
  );
  const data = !query.isError && !query.isFetching ? query.data : undefined;
  const releaseKey = (row: { version: string; sha: string | null }) =>
    JSON.stringify([row.version, row.sha]);
  const releases = [
    ...new Map(
      (data?.rows ?? []).map((row) => [releaseKey(row), row]),
    ).entries(),
  ];
  const rows = (data?.rows ?? []).filter(
    (row) => !release || releaseKey(row) === release,
  );
  const visible = rows.slice(page * 50, (page + 1) * 50);
  return (
    <section
      className="companion-managed companion-product-trends"
      aria-label="Received product trends"
    >
      <h3>Received product trends</h3>
      <p>
        Disclosed product observations received by this companion. These counts
        are not personal usage, billing or proof that every event arrived.
      </p>
      <div className="companion-product-trends__controls">
        <label>
          Time window
          <select
            value={days}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (![7, 14, 30].includes(next)) return;
              setDays(next);
              setWindow(windowFor(next));
              setPage(0);
              setRelease('');
            }}
          >
            {[7, 14, 30].map((value) => (
              <option key={value} value={value}>
                Last {value} days
              </option>
            ))}
          </select>
        </label>
        <label>
          Release
          <select
            value={release}
            disabled={!data}
            onChange={(event) => {
              setRelease(event.target.value);
              setPage(0);
            }}
          >
            <option value="">All received releases</option>
            {releases.map(([key, row]) => (
              <option key={key} value={key}>
                {row.version}
                {row.sha
                  ? ` · ${row.sha.slice(0, 12)}`
                  : ' · source unavailable'}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          disabled={query.isFetching}
          onClick={() => {
            setWindow(windowFor(days));
            setPage(0);
            setRelease('');
          }}
        >
          Refresh product trends
        </Button>
      </div>
      {query.isError ? (
        <p role="alert">
          Product trends are unavailable. Check companion runtime, storage and
          operator permissions. Previous results are hidden.
        </p>
      ) : !data ? (
        <SkeletonBlock count={1} label="Reading product trends" />
      ) : (
        <>
          <p>
            UTC window {data.window.from} to {data.window.to} (end excluded).
            Event time comes from the producing Station's clock. Retention:{' '}
            {data.retentionDays} days. Delivery coverage is unknown.
          </p>
          {rows.length === 0 ? (
            <p>
              No received groups match this window and release. This does not
              prove no activity occurred.
            </p>
          ) : (
            <>
              <p>
                {rows.length} received groups match; showing {page * 50 + 1}–
                {Math.min((page + 1) * 50, rows.length)}.
              </p>
              <ul>
                {visible.map((row) => (
                  <li key={JSON.stringify(row)}>
                    {row.day}: {row.event} — {row.count} received. Release{' '}
                    {row.version};{' '}
                    {row.sha
                      ? `${row.sha} (${row.shaSource})`
                      : 'source unavailable'}
                    {row.engine ? `; engine ${row.engine}` : ''}
                    {row.outcome ? `; outcome ${row.outcome}` : ''}.
                  </li>
                ))}
              </ul>
              <div className="companion-product-trends__controls">
                <Button
                  variant="secondary"
                  disabled={page === 0}
                  onClick={() => setPage((value) => value - 1)}
                >
                  Previous groups
                </Button>
                <Button
                  variant="secondary"
                  disabled={(page + 1) * 50 >= rows.length}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next groups
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
