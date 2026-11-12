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
 * `access:manage`: each read calls the provider live, so it is made once per
 * visit (no polling; the engine's own page polls) and only for an engine
 * that is on, ready and signed in. Allowance must not become a background
 * read for every viewer (docs/design/connections-overhaul.md).
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
      <Empty
        variant="compact"
        label="Nothing here yet"
        description="Add Claude Code or Codex to see its allowance."
      />
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
  // An engine that is off or not ready runs nothing to spend allowance on.
  const ready = engine.enabled && engine.status === 'ready';
  const accounts = useEngineAccountsQuery(engine.id, scope, ready);
  const ref = accounts.data?.activeProfileRef ?? null;
  const account = accounts.data?.accounts.find((item) => item.ref === ref);
  const signedIn = account?.authState === 'authenticated';
  const usage = useEngineAccountUsageQuery(
    engine.id,
    ref,
    scope,
    ready && signedIn,
    { poll: false },
  );
  const failed = accounts.isError ? accounts : usage.isError ? usage : null;
  return (
    <section
      className="connections-overview__engine"
      aria-label={`${engine.name} allowance`}
    >
      <h3>{engine.name}</h3>
      {account ? <small>{account.label}</small> : null}
      {!ready ? (
        <Empty
          variant="compact"
          label={engine.enabled ? 'Not ready' : 'Turned off'}
        />
      ) : failed ? (
        <ErrorState
          variant="compact"
          title="Allowance could not be loaded"
          description={describeReadFailure(failed.error)}
          action={<Button onClick={() => void failed.refetch()}>Retry</Button>}
        />
      ) : accounts.data && !account ? (
        <Empty
          variant="compact"
          label="Nothing here yet"
          description="Choose the account its runs use on its Accounts tab."
        />
      ) : account && !signedIn ? (
        <Empty
          variant="compact"
          label={
            account.authState === 'unauthenticated'
              ? 'Signed out'
              : 'Status unavailable'
          }
        />
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
