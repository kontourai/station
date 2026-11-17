import type {
  TaskLaneDerivation,
  TaskLaneTone,
} from '@kontourai/station-contracts/task-lane';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import type { AgentSummary } from '../../types';
import { sessionWorkStatus } from '../sessions/sessions-lane-model';

/** Rungs whose words come from the run itself, refined by the ladder. */
const SESSION_RUNGS: ReadonlySet<TaskLaneDerivation['rung']> = new Set([
  'approval',
  'answer',
  'interrupted',
  'blocked',
  'waiting',
  'failed',
  'running',
  'elsewhere',
]);

/** A Task's one status, as every view of the Tasks section prints it. */
export interface TaskStatusPresentation {
  word: string;
  detail?: string;
  tone: TaskLaneTone;
  /** The longer form: why it failed, which PR, why nothing can answer. */
  reason?: string;
}

/**
 * The single place a Task's status words are chosen, for the board card and
 * the list badge alike. The lane is always the derivation's; on the run's
 * own rungs the words are the status ladder's (`sessionWorkStatus`), which
 * knows the running tool, sub-agents and a failure's cause.
 */
export function taskStatusPresentation(
  derivation: TaskLaneDerivation,
  session: OrchestrationSessionSummary | undefined,
  agents: AgentSummary[],
  now: number,
): TaskStatusPresentation {
  const ladder =
    session && SESSION_RUNGS.has(derivation.rung)
      ? sessionWorkStatus(session, agents, now)
      : undefined;
  const running = derivation.rung === 'running';
  const reason = ladder?.reason ?? derivation.reason;
  const detail = ladder ? ladder.detail : derivation.detail;
  return {
    word: ladder?.word ?? derivation.word,
    ...(detail ? { detail } : {}),
    // A quiet run is the ladder's caution; the lane's own tone otherwise.
    tone: ladder && running ? ladder.tone : derivation.tone,
    ...(reason ? { reason } : {}),
  };
}

/**
 * THE one tone map for the Tasks section: the colour a status draws in on a
 * board card and lane dot, and the badge tone a list row wears. Needs-you
 * colours only its glyph and dot, with the inbox's attention accent; its
 * word stays in the text colour, as an inbox row's does, so its badge is
 * neutral (a badge has no accent tone).
 */
export const TASK_TONE: Record<
  TaskLaneTone,
  {
    color: string;
    colorsWord: boolean;
    badge: 'positive' | 'caution' | 'negative' | 'active' | 'neutral';
  }
> = {
  attention: {
    color: 'var(--accent-primary)',
    colorsWord: false,
    badge: 'neutral',
  },
  caution: { color: 'var(--k-caution)', colorsWord: true, badge: 'caution' },
  active: { color: 'var(--k-active)', colorsWord: true, badge: 'active' },
  positive: {
    color: 'var(--k-positive)',
    colorsWord: true,
    badge: 'positive',
  },
  broken: { color: 'var(--k-negative)', colorsWord: true, badge: 'negative' },
  neutral: {
    color: 'var(--k-text-muted)',
    colorsWord: false,
    badge: 'neutral',
  },
};

/** Each lane's dot: the tone of what the lane holds. */
export const TASK_LANE_TONE = {
  needs_you: 'attention',
  running: 'active',
  in_review: 'neutral',
  ready_to_merge: 'positive',
  idle: 'neutral',
} as const satisfies Record<string, TaskLaneTone>;
