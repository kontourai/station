import {
  useFeaturePreviewsQuery,
  useUpdateWorkloadBudgetSettingsMutation,
  useWorkloadBudgetsQuery,
  type WorkloadBudgetStatus,
  WorkloadBudgetsUnsupportedError,
} from '@kontourai/station-sdk';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { ErrorState, SkeletonBlock } from '../../components/state';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';

/** The Feature Preview that offers this editor (server-bound id). */
export const WORKLOAD_BUDGET_SETTINGS_PREVIEW_ID = 'workload-budget-settings';

const MIB = 1024 * 1024;
const mib = (bytes: number) => Math.round(bytes / MIB);
const gib = (bytes: number) => (bytes / 1024 / MIB).toFixed(1);

const SOURCE_ENV = {
  memory: 'STATION_WORKLOAD_MEMORY_MIB',
  totalMemory: 'STATION_WORKLOAD_TOTAL_MEMORY_MIB',
} as const;

function enforcementSentence(status: WorkloadBudgetStatus): string {
  const { state, platform, reason } = status.enforcement;
  if (state === 'ready')
    return 'Enforced: each engine and every command it starts run inside one Linux memory limit.';
  if (state === 'unavailable')
    return `Not enforced: workload isolation could not start${reason ? ` (${reason})` : ''}.`;
  if (state === 'stopping') return 'Not enforced: Station is stopping.';
  return `Not enforced on this host (${platform}). Budgets apply only when Station runs as a Linux systemd user service.`;
}

/**
 * Host options: the per-engine and total memory budgets for engine
 * workloads. Rendered only while the `workload-budget-settings` Feature
 * Preview is enabled; the server refuses the write while it is off.
 */
export function WorkloadBudgetSettings() {
  const previews = useFeaturePreviewsQuery();
  const enabled =
    previews.data?.some(
      (preview) =>
        preview.id === WORKLOAD_BUDGET_SETTINGS_PREVIEW_ID && preview.enabled,
    ) === true;
  if (!enabled) return null;
  return <WorkloadBudgetEditor />;
}

function WorkloadBudgetEditor() {
  const status = useWorkloadBudgetsQuery();
  const update = useUpdateWorkloadBudgetSettingsMutation();
  const saved = status.data?.settings;
  const [memory, setMemory] = useState('');
  const [total, setTotal] = useState('');
  useEffect(() => {
    setMemory(saved?.memoryMiB?.toString() ?? '');
    setTotal(saved?.totalMemoryMiB?.toString() ?? '');
  }, [saved?.memoryMiB, saved?.totalMemoryMiB]);
  const dirty =
    memory !== (saved?.memoryMiB?.toString() ?? '') ||
    total !== (saved?.totalMemoryMiB?.toString() ?? '');
  const { DiscardModal } = useUnsavedGuard(dirty);

  let body: ReactNode;
  if (status.isLoading)
    body = <SkeletonBlock count={2} label="Reading workload budgets" />;
  else if (status.error instanceof WorkloadBudgetsUnsupportedError)
    body = <p className="settings__field-hint">{status.error.message}</p>;
  else if (status.error || !status.data)
    body = (
      <ErrorState
        variant="compact"
        title="Could not read workload budgets"
        description="Station did not report its workload budgets."
        action={<Button onClick={() => status.refetch()}>Retry</Button>}
      />
    );
  else {
    const data = status.data;
    const fromEnv = (key: 'memory' | 'totalMemory') =>
      data.sources?.[key] === 'environment';
    const parse = (value: string) => (value.trim() ? Number(value) : null);
    const field = (
      key: 'memory' | 'totalMemory',
      label: string,
      value: string,
      onChange: (value: string) => void,
      effectiveBytes: number | undefined,
    ) => (
      <div className="settings__field">
        <label
          className="settings__field-label"
          htmlFor={`workload-budget-${key}`}
        >
          {label} (MiB)
        </label>
        <input
          id={`workload-budget-${key}`}
          type="number"
          inputMode="numeric"
          min={256}
          step={256}
          value={value}
          disabled={fromEnv(key) || !data.settingsWritable}
          placeholder={
            effectiveBytes !== undefined
              ? `Default: ${mib(effectiveBytes)}`
              : 'Default'
          }
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <span className="settings__field-hint">
          {fromEnv(key)
            ? `Set by ${SOURCE_ENV[key]} in Station's environment, which overrides this setting.`
            : effectiveBytes !== undefined
              ? `${data.enforcement.state === 'ready' ? 'In effect' : 'Resolves to'}: ${mib(effectiveBytes)} MiB (${data.sources?.[key] === 'settings' ? 'saved setting' : 'default'}).`
              : 'Leave empty for the default.'}
        </span>
      </div>
    );
    body = (
      <>
        <p className="settings__field-hint workload-budgets__status">
          {enforcementSentence(data)} This host has {gib(data.hostMemoryBytes)}{' '}
          GiB of memory.
        </p>
        {field(
          'memory',
          'Per-engine memory',
          memory,
          setMemory,
          data.limits?.memoryMaxBytes,
        )}
        {field(
          'totalMemory',
          'Total workload memory',
          total,
          setTotal,
          data.limits?.totalMemoryMaxBytes,
        )}
        {data.settingsError && (
          <p className="settings__field-warning">{data.settingsError}</p>
        )}
        <p className="settings__field-hint">
          {data.applies === 'new-scopes'
            ? 'Saved budgets apply to engines started after saving. Running engines keep the budget they started with.'
            : 'Station reads these budgets when workload enforcement starts. Restart Station to apply them.'}
        </p>
        {update.error && (
          <p className="settings__field-warning" role="status">
            {update.error.message}
          </p>
        )}
        <div className="workload-budgets__actions">
          <Button
            variant="primary"
            disabled={!dirty || !data.settingsWritable}
            pending={update.isPending}
            onClick={() =>
              update.mutate({
                memoryMiB: parse(memory),
                totalMemoryMiB: parse(total),
              })
            }
          >
            Save budgets
          </Button>
          <Button
            disabled={!dirty}
            onClick={() => {
              setMemory(saved?.memoryMiB?.toString() ?? '');
              setTotal(saved?.totalMemoryMiB?.toString() ?? '');
            }}
          >
            Discard changes
          </Button>
        </div>
      </>
    );
  }

  return (
    <div className="settings__subsection" id="workload-budgets" tabIndex={-1}>
      <h3 className="settings__field-label">Workload memory budgets</h3>
      <p className="settings__field-hint">
        How much memory one engine, together with every command it runs, may
        use, and how much all engine workloads may use together.
      </p>
      {body}
      <DiscardModal />
    </div>
  );
}
