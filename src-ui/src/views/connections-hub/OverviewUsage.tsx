import type { UsageRollupRow } from '@kontourai/station-contracts/usage-rollup';
import { readUsageConnectionFiltersCapability } from '@kontourai/station-sdk/client';
import { useUsageRollupQuery } from '@kontourai/station-sdk/usage-rollup-query';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../components/Button';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  SkeletonBlock,
} from '../../components/state';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';

type Scope = NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;

function rowTokens(row: UsageRollupRow): number | undefined {
  return row.inputTokens === undefined && row.outputTokens === undefined
    ? undefined
    : (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
}

/**
 * This Station's last 7 days of usage, one row per engine connection. The
 * caller renders this only for a viewer with `access:manage`. Grouping by
 * connection is sent only to a host that says it applies it: an older one
 * would answer something else.
 */
export function OverviewUsage({
  scope,
  names,
}: {
  scope: Scope;
  /** Connection id → the name its list shows. */
  names: ReadonlyMap<string, string>;
}) {
  const capability = useQuery({
    queryKey: ['usage-connection-filters', scope.apiBase],
    queryFn: () => readUsageConnectionFiltersCapability(scope.apiBase),
    staleTime: 60_000,
    retry: false,
  });
  const rollup = useUsageRollupQuery(
    { days: 7, localOnly: true, groupBy: 'connection', pageSize: 100 },
    {
      requestScope: scope,
      requireRequestScope: true,
      enabled: capability.data === true,
    },
  );
  if (capability.isLoading)
    return <SkeletonBlock count={2} label="Loading usage" />;
  // `null`: the host published no capability handshake, so it cannot be
  // asked to group by connection either. Retrying would read the same answer.
  if (capability.data === false || capability.data === null)
    return (
      <Empty
        variant="compact"
        label="This Station can't report usage by connection"
        {...(capability.data === false
          ? { description: 'Update Station to see it.' }
          : {})}
      />
    );
  const failed = capability.isError
    ? capability
    : rollup.isError
      ? rollup
      : null;
  if (failed)
    return (
      <ErrorState
        variant="compact"
        title="Usage could not be loaded"
        description={describeReadFailure(failed.error)}
        action={<Button onClick={() => void failed.refetch()}>Retry</Button>}
      />
    );
  if (!rollup.data) return <SkeletonBlock count={2} label="Loading usage" />;
  const rows = [...rollup.data.rows].sort(
    (a, b) => (rowTokens(b) ?? -1) - (rowTokens(a) ?? -1),
  );
  const partial = rollup.data.coverage.some(
    (coverage) => coverage.state !== 'complete',
  );
  if (!rows.length)
    return (
      <Empty
        variant="compact"
        label={partial ? 'Usage unavailable' : 'No usage in the last 7 days'}
      />
    );
  return (
    <div className="connections-overview__usage">
      <table>
        <caption className="sr-only">Tokens by connection, last 7 days</caption>
        <thead>
          <tr>
            <th scope="col">Connection</th>
            <th scope="col">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const tokens = rowTokens(row);
            return (
              <tr key={row.key}>
                <td>
                  {row.connectionId === undefined
                    ? 'Not attributed'
                    : (names.get(row.connectionId) ?? row.connectionId)}
                </td>
                <td>{tokens === undefined ? '—' : tokens.toLocaleString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.some((row) => row.connectionId === undefined) ? (
        <small>Not attributed: runs recorded without their engine.</small>
      ) : null}
      {partial ? <small>Some usage could not be read.</small> : null}
    </div>
  );
}
