import {
  type ReadinessInitResultVM,
  useInitFlowMutation,
  useInitReadinessMutation,
} from '@kontourai/station-sdk';
import { useEffect, useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import {
  type WorkflowPlanArtifact,
  WorkflowPlanPanel,
} from '../flow/WorkflowPlanPanel';
import { ConfirmModal } from '../modals/ConfirmModal';
import { ReadinessPanel } from '../readiness/ReadinessPanel';
import { Empty } from '../state';
import { TrustPanel } from '../trust/TrustPanel';
import './CodingInspectorPanel.css';

const FLOW_DOCS_URL = 'https://kontourai.io/flow';
const VERITAS_DOCS_URL = 'https://kontourai.io/veritas';
const TRUST_DOCS_URL = 'https://kontourai.io/surface';

function SetupCta({
  label,
  helper,
  onAction,
  pending,
  error,
  docsUrl,
  command,
  commandNote,
}: {
  label: string;
  helper?: string;
  onAction?: () => void;
  pending?: boolean;
  error?: string | null;
  docsUrl: string;
  /** When set, show a copyable command instead of a one-click action. */
  command?: string;
  /**
   * Why the copy-command fallback exists instead of the one-click action, so
   * the bare command does not read as an instruction to leave the app for a
   * terminal the reader may not have open.
   */
  commandNote?: string;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  useEffect(() => {
    if (copyState === 'idle') return;
    const t = window.setTimeout(() => setCopyState('idle'), 1500);
    return () => window.clearTimeout(t);
  }, [copyState]);

  return (
    <div className="coding-inspector__cta">
      {command ? (
        <>
          {commandNote && (
            <p className="coding-inspector__cta-note">{commandNote}</p>
          )}
          <code className="coding-inspector__cta-command">{command}</code>
          <div className="coding-inspector__cta-row">
            <button
              type="button"
              className={`coding-inspector__cta-action${
                copyState === 'failed' ? ' copy-affordance--failed' : ''
              }`}
              title={
                copyState === 'failed'
                  ? 'This browser refused clipboard access — select the command above to copy it manually.'
                  : undefined
              }
              onClick={() => {
                void copyToClipboard(command).then((copied) => {
                  setCopyState(copied ? 'copied' : 'failed');
                });
              }}
            >
              {copyState === 'copied'
                ? 'Copied'
                : copyState === 'failed'
                  ? "Can't copy"
                  : 'Copy command'}
            </button>
            <a
              className="coding-inspector__cta-link"
              href={docsUrl}
              target="_blank"
              rel="noreferrer"
            >
              Docs
            </a>
          </div>
        </>
      ) : (
        <>
          {onAction && (
            <button
              type="button"
              className="coding-inspector__cta-action"
              onClick={onAction}
              disabled={pending}
            >
              {pending ? 'Working…' : label}
            </button>
          )}
          <a
            className="coding-inspector__cta-link"
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
          >
            {helper ?? 'Learn more'}
          </a>
        </>
      )}
      {error && (
        <p className="coding-inspector__cta-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function WorkflowPlanInspectorContent({
  projectSlug,
  artifact,
  sessionTitle,
  runtimeState,
  configured,
}: {
  projectSlug: string;
  artifact: WorkflowPlanArtifact | null;
  sessionTitle?: string | null;
  runtimeState?: {
    status?: string | null;
    pendingApprovals?: number;
    isProcessingStep?: boolean;
  };
  configured: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const initFlow = useInitFlowMutation(projectSlug);
  const initError =
    initFlow.error instanceof Error ? initFlow.error.message : null;

  // A plan artifact can still arrive from chat even without a `.flow/` layout;
  // only show the setup CTA when neither a flow layout nor a live artifact
  // exists, so we never hide a real plan behind the empty state.
  if (!configured && !artifact) {
    return (
      <>
        <Empty
          variant="compact"
          label="No delivery flow"
          description="Add a Flow delivery definition to track gated steps, evidence, and route-backs as this project ships."
          action={
            <SetupCta
              label="Add a delivery flow"
              helper="What is Flow?"
              docsUrl={FLOW_DOCS_URL}
              pending={initFlow.isPending}
              error={initError}
              onAction={() => setConfirmOpen(true)}
            />
          }
        />
        <ConfirmModal
          isOpen={confirmOpen}
          title="Add a delivery flow?"
          message="This scaffolds a starter .flow/ layout in the project workspace (it writes files to your project). You can edit or remove it afterwards."
          confirmLabel="Add flow"
          onConfirm={() => {
            setConfirmOpen(false);
            initFlow.mutate();
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      </>
    );
  }

  return (
    <WorkflowPlanPanel
      artifact={artifact}
      sessionTitle={sessionTitle}
      runtimeState={runtimeState}
    />
  );
}

export function ReadinessInspectorContent({
  projectSlug,
}: {
  projectSlug: string;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const initReadiness = useInitReadinessMutation(projectSlug);
  const initError =
    initReadiness.error instanceof Error ? initReadiness.error.message : null;
  const result = initReadiness.data as ReadinessInitResultVM | undefined;
  const noCli = result?.outcome === 'no-cli';

  return (
    <>
      <ReadinessPanel
        projectSlug={projectSlug}
        renderSetup={() =>
          noCli ? (
            <SetupCta
              label="Set up readiness"
              docsUrl={VERITAS_DOCS_URL}
              command={result?.command ?? 'npx veritas init --non-interactive'}
              commandNote="The Veritas CLI is not installed in this workspace yet, so Station cannot run the setup for you. Copy the command below into a terminal in this project — it downloads the CLI and scaffolds a .veritas/ directory (it writes files to your project)."
            />
          ) : (
            <SetupCta
              label="Set up readiness"
              helper="What is Veritas?"
              docsUrl={VERITAS_DOCS_URL}
              pending={initReadiness.isPending}
              error={initError}
              onAction={() => setConfirmOpen(true)}
            />
          )
        }
      />
      <ConfirmModal
        isOpen={confirmOpen}
        title="Set up merge readiness?"
        message="This runs `veritas init` in the project workspace, creating a .veritas/ directory (it writes files to your project). You can edit or remove it afterwards."
        confirmLabel="Set up"
        onConfirm={() => {
          setConfirmOpen(false);
          initReadiness.mutate();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

export function TrustInspectorContent({
  projectSlug,
}: {
  projectSlug: string;
}) {
  return (
    <div className="coding-inspector__trust">
      <TrustPanel projectSlug={projectSlug} />
      <SetupCta
        label="Trust bundles"
        helper="How trust bundles work"
        docsUrl={TRUST_DOCS_URL}
      />
    </div>
  );
}
