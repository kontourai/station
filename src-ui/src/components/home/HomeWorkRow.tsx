import { relativeTimeAgo } from '../../utils/relativeTime';
import type { SessionIconAgent } from '../../utils/sessionDisplay';
import type { HomeLaneItem } from '../../views/home/home-lane-model';
import { homeRowIconAgent } from '../../views/home/home-row-icon';
import { AgentIcon } from '../icons/AgentIcon';
import { TimeGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import { hasLifecycleChip, LifecycleStatusChip } from './LifecycleStatusChip';

// Module-level so LazyBoundary's useMemo sees a stable `load` identity across
// renders (a fresh arrow per render would re-create the lazy component).
const loadProgressSilenceObservation = () =>
  import('./ProgressSilenceObservation');

export interface HomeWorkRowProps {
  task: HomeLaneItem;
  isWoken: boolean;
  /**
   * The agent catalog, used only to resolve this row's icon. Passing the
   * catalog rather than a pre-resolved icon keeps the "no icon for an agent
   * this Station does not have" rule in one place (`homeRowIconAgent`).
   */
  agents: readonly SessionIconAgent[];
  onOpen: (task: HomeLaneItem) => void;
  onSnooze?: (task: HomeLaneItem, trigger: HTMLButtonElement) => void;
}

/** Shared Home work-row renderer for active, terminal, and settled lanes. */
export function renderHomeWorkRow({
  task,
  isWoken,
  agents,
  onOpen,
  onSnooze,
}: HomeWorkRowProps) {
  // The catalog entry itself, never a synthesised object: `AgentIcon` takes
  // `agent` by identity, and MessageBubble's station#1424 N4 note records
  // what allocating a fresh one per render costs. `null` means this Station
  // has no agent under this row's slug — see `homeRowIconAgent` for why that
  // renders nothing rather than a guessed engine mark.
  const iconAgent = homeRowIconAgent(task, agents);
  const now = Date.now();
  const lastProgressAt = task.turnProgress?.lastProgressEventAt;
  const progressSilence = task.turnProgress?.progressSilence;
  return (
    <li key={task.stableId}>
      <div className="home-view__row">
        <button
          type="button"
          className="home-view__task-open"
          onClick={() => onOpen(task)}
        >
          <span className="home-view__task-lead">
            {/* Decorative: the row already states the agent in
                `home-view__identity`, so the icon must not repeat it into the
                accessible name. */}
            {iconAgent && (
              <span className="home-view__task-icon" aria-hidden="true">
                <AgentIcon agent={iconAgent} size={20} />
              </span>
            )}
            <span className="home-view__task-copy">
              <strong>{task.title}</strong>
              <small>
                {task.kindLabel} · {task.projectLabel}
                {task.cwdLabel ? ` · ${task.cwdLabel}` : ''}
                {task.updatedAt > 0 &&
                  ` · ${relativeTimeAgo(task.updatedAt, now)}`}
              </small>
              {lastProgressAt && (
                <small>
                  Last progress{' '}
                  {relativeTimeAgo(Date.parse(lastProgressAt), now)}
                </small>
              )}
              {progressSilence && (
                <LazyBoundary
                  load={loadProgressSilenceObservation}
                  pending={null}
                  componentProps={{ observation: progressSilence }}
                  // A quiet-turn observation is auxiliary chrome: if its chunk
                  // rejects, losing the indicator honestly beats an inline
                  // error taking over a Home row.
                  unavailable={() => null}
                />
              )}
              {/* station#1783: the basis for the Unanswerable chip. The chip
                  alone would be a label; this is what computed it. */}
              {task.unanswerableNotice && (
                <small
                  className="home-view__unanswerable"
                  data-testid="home-row-answerability"
                >
                  {task.unanswerableNotice}
                </small>
              )}
              {/* The compact terminal-attribution detail is the basis for a
                  Failed/Stopped chip. It is server-derived and already
                  bounded; omitting it here would leave Home with a label but
                  no visible account of what ended the work. */}
              {(task.lifecycleLabel === 'Failed' ||
                task.lifecycleLabel === 'Stopped') &&
                task.failureNotice && (
                  <small
                    className="home-view__unanswerable"
                    data-testid="home-row-terminal-attribution"
                  >
                    {task.failureNotice}
                  </small>
                )}
            </span>
          </span>
          <span className="home-view__identity">
            {task.agentLabel} · {task.modelLabel}
          </span>
          {(hasLifecycleChip(task.lifecycleLabel) ||
            isWoken ||
            task.environmentLabel) && (
            <span className="home-view__row-status">
              {task.environmentLabel && (
                <span className="home-view__environment-badge">
                  {task.environmentLabel}
                </span>
              )}
              {hasLifecycleChip(task.lifecycleLabel) && (
                <LifecycleStatusChip lifecycle={task.lifecycleLabel} />
              )}
              {isWoken && (
                <span className="home-view__woke-pill">Woke from snooze</span>
              )}
            </span>
          )}
        </button>
        {onSnooze && (
          <div className="home-view__row-actions">
            <button
              type="button"
              className="home-view__row-action"
              aria-label={`Snooze ${task.title}`}
              aria-haspopup="menu"
              onClick={(event) => onSnooze(task, event.currentTarget)}
            >
              <TimeGlyph />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
