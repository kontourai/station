/**
 * WorkflowStatusLine — compact "Workflow" row surfaced in task/session detail
 * panes when a flow-agents durable sidecar (`.kontourai/flow-agents/<slug>/
* state.json`) is joined to the subject (archive#582). Renders nothing
 * when there is no state to show — callers own the absence check.
 *
 * `matchKind: 'title-heuristic'` is a fixed-forward honesty requirement from
 * the archive#582: a title-slugified join is never presented as verified
 * identity, so it always carries a visible "matched by title" qualifier.
 * `'workItemRef'` (or omitted, for the project-level fallback list) renders
 * without that qualifier.
 */
import './WorkflowStatusLine.css';

export type WorkflowMatchKind = 'workItemRef' | 'title-heuristic';

export interface WorkflowStatusLineEntry {
  taskSlug: string;
  status: string;
  phase: string;
  currentStep?: string;
  openGateIds?: string[];
  matchKind?: WorkflowMatchKind;
}

export function WorkflowStatusLine({
  entry,
  showSlug = false,
}: {
  entry: WorkflowStatusLineEntry;
/** Show the task_slug label — used by the multi-entry project fallback. */
  showSlug?: boolean;
}) {
  return (
    <div className="workflow-status-line" data-testid="workflow-status-line">
      <span className="workflow-status-line__label">Workflow</span>
      {showSlug && (
        <span className="workflow-status-line__slug">{entry.taskSlug}</span>
      )}
      <span className="workflow-status-line__badge">{entry.status}</span>
      <span className="workflow-status-line__badge workflow-status-line__badge--phase">
        {entry.phase}
      </span>
      {entry.currentStep && (
        <span className="workflow-status-line__step">
          step: {entry.currentStep}
        </span>
      )}
      {entry.openGateIds && entry.openGateIds.length > 0 && (
        <span className="workflow-status-line__gates">
          {entry.openGateIds.length === 1 ? 'gate' : 'gates'}:{' '}
          {entry.openGateIds.join(', ')}
        </span>
      )}
      {entry.matchKind === 'title-heuristic' && (
        <span
          className="workflow-status-line__hint"
          data-testid="workflow-status-line-hint"
        >
          matched by title
        </span>
      )}
    </div>
  );
}

export function WorkflowStatusLineList({
  entries,
  moreCount = 0,
}: {
  entries: WorkflowStatusLineEntry[];
/** Count of additional entries beyond `entries` that were truncated —
* rendered as a trailing "+N more" line rather than silently dropped. */
  moreCount?: number;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="workflow-status-line-list">
      {entries.map((entry) => (
        <WorkflowStatusLine key={entry.taskSlug} entry={entry} showSlug />
      ))}
      {moreCount > 0 && (
        <span className="workflow-status-line-list__more">
          +{moreCount} more
        </span>
      )}
    </div>
  );
}
