import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { readUsageConnectionFiltersCapability } from '@kontourai/station-sdk/client';
import {
  useEngineAccountsQuery,
  useEngineAccountUsageQuery,
  useEngineActivityQuery,
} from '@kontourai/station-sdk/engine-accounts';
import { useUsageRollupQuery } from '@kontourai/station-sdk/usage-rollup-query';
import { Field, Select } from '@kontourai/ui/react';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import {
  type UsageDays,
  UsagePanel,
  type UsagePanelState,
} from '../../components/resource-hub/UsagePanel';
import { ErrorState } from '../../components/state';
import { useCoarseNow } from '../../hooks/useCoarseNow';
import { EngineAllowanceHistory } from './EngineAllowanceHistory';
import { useEngineAccountAccess } from './useEngineAccountAccess';

type Access = ReturnType<typeof useEngineAccountAccess>;

/** Keys the disabled reads when this device has no Station scope. */
const NO_SCOPE = {
  apiBase: '',
  authorityKey: 'scope-unavailable',
  isCurrent: () => false,
};

/** The state a read gives the panel before its data arrives. */
function accessState(access: Access): UsagePanelState | null {
  if (!access.scope) return { kind: 'access-denied' };
  if (access.authority.isLoading) return { kind: 'loading' };
  if (access.authority.isError || !access.authority.data)
    return {
      kind: 'error',
      error: access.authority.error,
      onRetry: () => void access.authority.refetch(),
    };
  if (!access.canManage) return { kind: 'access-denied' };
  return null;
}

function queryState<T>(
  query: {
    data?: T;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  },
  ready: (data: T) => UsagePanelState,
): UsagePanelState {
  if (query.isError)
    return {
      kind: 'error',
      error: query.error,
      onRetry: () => void query.refetch(),
    };
  if (query.data === undefined) return { kind: 'loading' };
  return ready(query.data);
}

/**
 * An engine's Station-observed usage. Claude Code and Codex record their
 * connection only when dispatch passes it, so they are read by provider kind
 * (with the account filter and allowance history their accounts allow).
 * Other engines are read by this connection, on a host that applies that
 * filter. A command (ACP) engine keeps no usage receipts, which the panel
 * says instead of showing zero.
 */
export function EngineUsageTab({
  connection,
}: {
  connection: AgentConnectionView;
}) {
  const access = useEngineAccountAccess();
  const [days, setDays] = useState<UsageDays>(7);
  if (connection.type === 'claude' || connection.type === 'codex')
    return (
      <AccountEngineUsage
        connectionId={connection.id}
        engine={connection.type}
        access={access}
        days={days}
        onDaysChange={setDays}
      />
    );
  if (connection.type === 'acp')
    return (
      <UsagePanel
        state={{ kind: 'context-only' }}
        days={days}
        onDaysChange={setDays}
        label={connection.name}
      />
    );
  return (
    <ConnectionUsage
      connection={connection}
      access={access}
      days={days}
      onDaysChange={setDays}
    />
  );
}

function ConnectionUsage({
  connection,
  access,
  days,
  onDaysChange,
}: {
  connection: AgentConnectionView;
  access: Access;
  days: UsageDays;
  onDaysChange: (days: UsageDays) => void;
}) {
  const gate = accessState(access);
  const apiBase = access.scope?.apiBase;
  // An older host ignores the connection filter and answers every engine's
  // totals, so the filter is sent only where the host says it applies it.
  const capability = useQuery({
    queryKey: ['usage-connection-filters', apiBase],
    queryFn: () => readUsageConnectionFiltersCapability(apiBase!),
    enabled: !gate && !!apiBase,
    staleTime: 60_000,
    retry: false,
  });
  const rollup = useUsageRollupQuery(
    {
      days,
      connectionId: connection.id,
      localOnly: true,
      groupBy: 'day',
      pageSize: 100,
    },
    {
      requestScope: access.scope ?? undefined,
      requireRequestScope: true,
      enabled: !gate && capability.data === true,
    },
  );
  const state: UsagePanelState =
    gate ??
    (capability.isLoading
      ? { kind: 'loading' }
      : capability.data === false
        ? { kind: 'unsupported' }
        : capability.data !== true
          ? {
              kind: 'error',
              error: capability.error,
              onRetry: () => void capability.refetch(),
            }
          : queryState(rollup, (data) => ({ kind: 'ready', data })));
  return (
    <UsagePanel
      state={state}
      days={days}
      onDaysChange={onDaysChange}
      scope="This Station · this engine"
      unattributed="Runs recorded before Station tracked each run's engine are not counted here."
      label={connection.name}
    />
  );
}

function AccountEngineUsage({
  connectionId,
  engine,
  access,
  days,
  onDaysChange,
}: {
  connectionId: string;
  engine: 'claude' | 'codex';
  access: Access;
  days: UsageDays;
  onDaysChange: (days: UsageDays) => void;
}) {
  const gate = accessState(access);
  const pickerId = useId();
  // Read by engine kind: every connection of this kind is in these figures.
  const kindLabel = engine === 'codex' ? 'Codex' : 'Claude Code';
  const scope = access.scope ?? NO_SCOPE;
  const reads = !gate && !!access.scope;
  // `undefined`: every account of this engine.
  const [accountRef, setAccountRef] = useState<string | null | undefined>();
  const now = useCoarseNow(undefined, {
    intervalMs: 60_000,
    enabled: !gate,
  });
  const accounts = useEngineAccountsQuery(connectionId, scope, reads);
  const known = accounts.data?.accounts ?? [];
  const selected =
    accountRef !== undefined && known.some((a) => a.ref === accountRef)
      ? accountRef
      : undefined;
  // History is per account: the chosen one, or the one runs use.
  const historyRef =
    selected !== undefined
      ? selected
      : (accounts.data?.activeProfileRef ?? null);
  const historyAccount = known.find((a) => a.ref === historyRef);
  const activity = useEngineActivityQuery(engine, days, scope, reads, selected);
  const allowance = useEngineAccountUsageQuery(
    connectionId,
    historyRef,
    scope,
    reads && !!historyAccount,
  );
  const state =
    gate ?? queryState(activity, (data) => ({ kind: 'ready', data }));
  return (
    <>
      <UsagePanel
        state={state}
        days={days}
        onDaysChange={onDaysChange}
        provider={engine}
        label={engine}
        scope={
          selected === undefined
            ? `This Station · every ${kindLabel} connection · all accounts`
            : `This Station · every ${kindLabel} connection · selected account`
        }
        controls={
          !gate && known.length > 1 ? (
            <Field label="Usage for" htmlFor={pickerId}>
              <Select
                id={pickerId}
                value={selected === undefined ? '*' : (selected ?? '')}
                onChange={(event) =>
                  setAccountRef(
                    event.target.value === '*'
                      ? undefined
                      : event.target.value || null,
                  )
                }
                options={[
                  { label: 'All accounts', value: '*' },
                  ...known.map((account) => ({
                    label: account.label,
                    value: account.ref ?? '',
                  })),
                ]}
              />
            </Field>
          ) : null
        }
      />
      {!gate && allowance.isError ? (
        <ErrorState
          variant="compact"
          title="Allowance history could not be loaded"
          action={
            <Button onClick={() => void allowance.refetch()}>Retry</Button>
          }
        />
      ) : !gate && allowance.data?.history ? (
        <div className="engine-account-overview">
          {/* Another account is another series: its own limits and table. */}
          <EngineAllowanceHistory
            key={historyRef ?? 'default'}
            history={allowance.data.history}
            days={days}
            now={now}
          />
        </div>
      ) : null}
    </>
  );
}
