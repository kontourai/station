import type { EnvironmentRef } from '@kontourai/station-contracts/execution-target';
import type { DelegatedTaskHandle } from '@kontourai/station-sdk';
import { lazy, Suspense, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useDevicePresentation } from '../../hooks/useDevicePresentation';
import { ArrowDownGlyph } from '../icons/Glyph';
import { SkeletonList } from '../state';

const DelegationLauncher = lazy(() =>
  import('../chat-dock/DelegationLauncher').then((module) => ({
    default: module.DelegationLauncher,
  })),
);

/** Remote tasks retain the launcher's portable Project and receiver admission. */
export function StartStationControl({
  prompt,
  projectSlug,
  projectName,
  defaultEnvironment,
  agentSlug,
  model,
  executionAgentId,
  expectedDefinitionFingerprint,
  environmentId,
  providerOptions,
  disabled,
  onPromptChange,
  onStarted,
}: {
  prompt: string;
  projectSlug?: string;
  projectName?: string;
  defaultEnvironment?: EnvironmentRef;
  agentSlug?: string;
  model?: string;
  executionAgentId?: string;
  expectedDefinitionFingerprint?: string;
  environmentId?: string;
  providerOptions?: Record<string, unknown>;
  disabled?: boolean;
  onPromptChange: (prompt: string) => void;
  onStarted: (
    task: DelegatedTaskHandle,
    station: string,
    sentPrompt: string,
  ) => void;
}) {
  const scope = useHostRequestAuthorityScope();
  const device = useDevicePresentation();
  const destination =
    environmentId && environmentId !== 'current'
      ? 'Selected Station'
      : !environmentId && defaultEnvironment?.kind === 'saved'
        ? 'Project default'
        : (device?.hostName ?? 'This Station');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="choice-trigger start-composer__station"
        aria-haspopup="dialog"
        aria-label={`Run a task on a Station; current Station: ${destination}`}
        disabled={disabled || !scope}
        onClick={() => setOpen(true)}
      >
        <span>on {destination}</span>
        <ArrowDownGlyph className="choice-caret" />
      </button>
      {open && scope && (
        <Suspense
          fallback={<SkeletonList count={1} label="Loading Stations" />}
        >
          <DelegationLauncher
            isOpen
            apiBase={scope.apiBase}
            projectSlug={projectSlug}
            projectName={projectName}
            currentAgentId={agentSlug}
            currentModel={model}
            executionAgentId={executionAgentId}
            expectedDefinitionFingerprint={expectedDefinitionFingerprint}
            initialEnvironmentId={environmentId}
            providerOptions={providerOptions}
            initialPrompt={prompt}
            onDraftChange={onPromptChange}
            title="Run on a Station"
            submitLabel="Run task"
            routingExpanded
            onClose={close}
            onDelegated={(task, _worker, placement) => {
              close();
              onStarted(task, placement.stationName, placement.prompt);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
