import {
  type AgentFixRoute,
  AgentReadinessCell,
} from '../../components/AgentReadinessCell';
import { Button } from '../../components/Button';
import { AgentIcon } from '../../components/icons/AgentIcon';
import { AgentGlyph } from '../../components/icons/Glyph';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import type { AgentData } from '../../contexts/AgentsContext';

export function AgentEditorLoadingState() {
  return <SkeletonBlock count={3} label="Loading agent" />;
}

export function AgentEditorNotFoundState({
  selectedSlug,
  onDeselect,
}: {
  selectedSlug: string | null;
  onDeselect: () => void;
}) {
  return (
    <Empty
      variant="prominent"
      icon={
        <span className="agent-editor__state-icon" aria-hidden="true">
          <AgentGlyph />
        </span>
      }
      label="Agent not found"
      description={`The agent "${selectedSlug}" doesn't exist or was deleted.`}
      action={
        <Button variant="primary" onClick={onDeselect}>
          Back to agents
        </Button>
      }
    />
  );
}

export function AgentEditorLoadFailureState({
  selectedSlug,
  error,
  onRetry,
  onDeselect,
}: {
  selectedSlug: string | null;
  error: string;
  onRetry: () => void;
  onDeselect: () => void;
}) {
  return (
    <ErrorState
      title="Couldn’t load agent"
      description={
        <>
          Station couldn’t load “{selectedSlug}”. {error}
        </>
      }
      action={
        <div className="agent-editor__state-actions">
          <Button variant="primary" onClick={onRetry}>
            Retry
          </Button>
          <Button variant="secondary" onClick={onDeselect}>
            Back to agents
          </Button>
        </div>
      }
    />
  );
}

/**
* A detected engine that has no Agent file yet. The list row says the
 * same two words with the same reason — both read `agentRunnability`.
 *
 * This is deliberately NOT a disabled editor. The previous shape rendered all
 * six tabs greyed out with a Save button styled as an active primary that
 * could never save; a state the user cannot act on must not be dressed as one
 * they can. There is exactly one action here, and it is the one that works.
 */
export function AgentEditorNotSetUpState({
  name,
  reason,
  actionLabel,
  onAction,
  actionPending,
  error,
  onDeselect,
}: {
  name: string;
  reason: string;
/** Absent when nothing this pane can do would fix it. */
  actionLabel?: string;
  onAction?: () => void;
  actionPending?: boolean;
  error?: string | null;
  onDeselect: () => void;
}) {
  return (
    <Empty
      variant="prominent"
      icon={
        <span className="agent-editor__state-icon" aria-hidden="true">
          <AgentGlyph />
        </span>
      }
      label={`${name} is not set up`}
      description={
        <>
          {reason}
          {error ? (
            <>
              {' '}
              <span role="alert">{error}</span>
            </>
          ) : null}
        </>
      }
      action={
        <div className="agent-editor__state-actions">
          {actionLabel && onAction && (
            <Button
              variant="primary"
              onClick={onAction}
              pending={actionPending}
              pendingLabel="Setting up…"
            >
              {actionLabel}
            </Button>
          )}
          <Button variant="secondary" onClick={onDeselect}>
            Back to agents
          </Button>
        </div>
      }
    />
  );
}

/**
 * DESIGN.md §4 — creation starts from a STARTING POINT, not a blank form and
 * not a grid of content templates. Each card answers the engine question (P1),
 * which is what every field below it depends on; shot 17's failure mode — pick
 * a template, fill the form, press Create, get "engine required" — is
 * structurally impossible now because the engine is what you picked first.
 */
export function AgentEditorStartingPoints({
  onStartModel,
  onStartCli,
  onCopy,
  copyDisabled,
}: {
  onStartModel: () => void;
  onStartCli: () => void;
  onCopy: () => void;
/** No agent exists to copy yet. */
  copyDisabled: boolean;
}) {
  return (
    <div className="agent-editor__template-picker">
      <h3 className="agent-editor__template-title">Choose a starting point</h3>
      <p className="agent-editor__template-desc">
        What runs this agent decides everything else, so it is the first
        question.
      </p>
      <div className="template-grid">
        <button type="button" className="template-card" onClick={onStartModel}>
          <strong>Chat with a model</strong>
          <small>
            Station’s own engine runs it on a Model connection you choose.
          </small>
        </button>
        <button type="button" className="template-card" onClick={onStartCli}>
          <strong>Wrap an installed agent CLI</strong>
          <small>
            Claude Code, Codex or another CLI on this machine runs itself.
          </small>
        </button>
        <button
          type="button"
          className="template-card"
          onClick={onCopy}
          disabled={copyDisabled}
        >
          <strong>Copy an existing agent</strong>
          <small>
            {copyDisabled
              ? 'You have no agents to copy yet.'
              : 'Start from one of yours and change what differs.'}
          </small>
        </button>
      </div>
    </div>
  );
}

/**
 * DESIGN.md §4 — "Copy an existing agent → pick one". The rows are the SAME
 * readiness rows the list and the New Chat picker render (`AgentReadinessCell`),
 * so an agent this picker calls Ready is one every other surface calls Ready.
 */
export function AgentEditorCopySourcePicker({
  agents,
  onPick,
  onBack,
  onFix,
}: {
  agents: AgentData[];
  onPick: (agent: AgentData) => void;
  onBack: () => void;
  onFix: (agent: AgentData, route: AgentFixRoute) => void;
}) {
  return (
    <div className="agent-editor__template-picker">
      <h3 className="agent-editor__template-title">Copy an existing agent</h3>
      <p className="agent-editor__template-desc">
        Everything is copied, including its engine. The copy is named
        “&lt;original&gt; copy”.
      </p>
      <ul className="agent-editor__copy-list">
        {agents.map((agent) => (
          <li key={agent.slug} className="agent-editor__copy-row">
            <button
              type="button"
              className="agent-editor__copy-pick"
              onClick={() => onPick(agent)}
            >
              <AgentIcon agent={agent as any} size="small" />
              <span className="agent-editor__copy-name">{agent.name}</span>
            </button>
            <span className="agent-editor__copy-state">
              <AgentReadinessCell
                agent={agent}
                onFix={(route) => onFix(agent, route)}
              />
            </span>
          </li>
        ))}
      </ul>
      <Button variant="secondary" onClick={onBack}>
        Back
      </Button>
    </div>
  );
}
