import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import {
  useEngineAccountsQuery,
  useEngineAccountUsageQuery,
} from '@kontourai/station-sdk/engine-accounts';
import { Button } from '../../components/Button';
import { Meter } from '../../components/resource-hub/Meter';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  SkeletonBlock,
} from '../../components/state';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';

type Scope = NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;

/**
 * Provider-reported allowance for each engine that holds accounts, read for
 * the account its runs use. The caller renders this only for a viewer with
 * `access:manage`: each read calls the provider live.
 */
export function OverviewAllowance({
  engines,
  scope,
}: {
  engines: readonly AgentConnectionView[];
  scope: Scope;
}) {
  if (!engines.length)
    return (
      <Empty variant="compact" label="No engine with an account is added" />
    );
  return (
    <div className="connections-overview__allowance">
      {engines.map((engine) => (
        <EngineAllowance key={engine.id} engine={engine} scope={scope} />
      ))}
    </div>
  );
}

function EngineAllowance({
  engine,
  scope,
}: {
  engine: AgentConnectionView;
  scope: Scope;
}) {
  const accounts = useEngineAccountsQuery(engine.id, scope, true);
  const ref = accounts.data?.activeProfileRef ?? null;
  const account = accounts.data?.accounts.find((item) => item.ref === ref);
  const usage = useEngineAccountUsageQuery(engine.id, ref, scope, !!account);
  const failed = accounts.isError ? accounts : usage.isError ? usage : null;
  return (
    <section
      className="connections-overview__engine"
      aria-label={`${engine.name} allowance`}
    >
      <h3>{engine.name}</h3>
      {account ? <small>{account.label}</small> : null}
      {failed ? (
        <ErrorState
          variant="compact"
          title="Allowance could not be loaded"
          description={describeReadFailure(failed.error)}
          action={<Button onClick={() => void failed.refetch()}>Retry</Button>}
        />
      ) : accounts.data && !account ? (
        <Empty variant="compact" label="No account in use" />
      ) : !usage.data ? (
        <SkeletonBlock count={1} label={`Loading ${engine.name} allowance`} />
      ) : usage.data.status === 'unknown' ? (
        <Empty
          variant="compact"
          label="Not reported"
          description={usage.data.reason}
        />
      ) : (
        usage.data.windows.map((window) => (
          <Meter
            key={window.id}
            label={window.label}
            usedPercent={window.usedPercent}
          >
            {window.resetsAt ? (
              <small>
                Resets{' '}
                {new Date(window.resetsAt).toLocaleString(undefined, {
                  weekday: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </small>
            ) : null}
          </Meter>
        ))
      )}
    </section>
  );
}
