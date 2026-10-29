import type { AgentJobProposalJob } from '@kontourai/station-contracts/agent-schedule';
import { clockTime } from '../../utils/relativeTime';

/** "Every 60 min", "Every 3 h", "Every day". */
export function everyText(everyMs: number): string {
  const minutes = Math.round(everyMs / 60_000);
  if (minutes < 120) return `Every ${Math.max(1, minutes)} min`;
  const hours = everyMs / 3_600_000;
  if (hours === 24) return 'Every day';
  if (Number.isInteger(hours)) return `Every ${hours} h`;
  return `Every ${minutes} min`;
}

/**
 * A proposed job's schedule in the reader's local time. A cron schedule is
 * read through its next run (`nextRun`, from the scheduler's own preview),
 * since the expression is written in its own zone.
 */
export function scheduleText(
  schedule: AgentJobProposalJob['schedule'],
  now: number,
  nextRun?: string,
): string {
  switch (schedule.kind) {
    case 'at':
      return `Once at ${clockTime(schedule.timeMs, now)}`;
    case 'every':
      return everyText(schedule.everyMs);
    case 'cron': {
      const next = nextRun ? Date.parse(nextRun) : Number.NaN;
      return Number.isFinite(next)
        ? `Next at ${clockTime(next, now)}`
        : schedule.expr;
    }
  }
}
