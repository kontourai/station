import type {
  AgentJobProposal,
  AgentWakeUp,
  ConversationScheduledJob,
} from '@kontourai/station-contracts/agent-schedule';
import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';
import type { ReactNode } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { useAgentSchedule } from '../../hooks/useAgentSchedule';
import {
  PRESENCE_FALLBACK_MS,
  usePresenceList,
} from '../../hooks/usePresenceList';
import {
  useRunJob,
  useSchedulerJobs,
  useToggleJob,
} from '../../hooks/useScheduler';
import { clockTime } from '../../utils/relativeTime';
import { Button } from '../Button';
import { CalendarGlyph, EditGlyph, PlayGlyph, TimeGlyph } from '../icons/Glyph';
import { Toggle } from '../Toggle';
import { everyText } from './agentScheduleText';
import './SessionScheduledSection.css';

type ScheduledRow =
  | { kind: 'wake-up'; key: string; wakeUp: AgentWakeUp }
  | { kind: 'resume'; key: string; threadId: string; dueAt: string }
  | { kind: 'proposal'; key: string; proposal: AgentJobProposal }
  | { kind: 'job'; key: string; job: ConversationScheduledJob };

const rowKey = (row: ScheduledRow) => row.key;

/**
 * The "This chat" card's Scheduled section: everything that will act on this
 * conversation later, or that it set up. Check-backs the agent scheduled, a
 * usage-limit resume waiting for its reset, job proposals waiting for the
 * person, and the jobs the person approved from here. Each row offers what
 * its own route allows: Cancel, or Run now / on-off / Edit for a job. Hidden
 * when there is nothing to list.
 */
export function SessionScheduledSection({
  conversationId,
  wrap,
}: {
  conversationId: string;
  /** The sheet closes itself before a navigation. */
  wrap: (action: () => void) => void;
}) {
  const { schedule, cancelWakeUp, holdResume } =
    useAgentSchedule(conversationId);
  const { navigate } = useNavigation();
  const rows: ScheduledRow[] = [
    ...schedule.wakeUps.map((wakeUp) => ({
      kind: 'wake-up' as const,
      key: `wake-up:${wakeUp.id}`,
      wakeUp,
    })),
    ...(schedule.usageLimitResume?.autoResume
      ? [
          {
            kind: 'resume' as const,
            key: `resume:${schedule.usageLimitResume.threadId}`,
            threadId: schedule.usageLimitResume.threadId,
            dueAt: schedule.usageLimitResume.dueAt,
          },
        ]
      : []),
    ...schedule.jobProposals.map((proposal) => ({
      kind: 'proposal' as const,
      key: `proposal:${proposal.id}`,
      proposal,
    })),
    ...schedule.jobs.map((job) => ({
      kind: 'job' as const,
      key: `job:${job.name}`,
      job,
    })),
  ];
  const shown = usePresenceList(rows, rowKey, PRESENCE_FALLBACK_MS);
  if (shown.list.length === 0) return null;
  const now = Date.now();
  return (
    <section
      className="session-scheduled"
      aria-labelledby="session-scheduled-title"
    >
      <div className="session-scheduled__header">
        <h3 id="session-scheduled-title" className="session-scheduled__title">
          Scheduled
        </h3>
        <button
          type="button"
          className="session-context-card__link session-scheduled__all"
          onClick={() => wrap(() => navigate('/schedule'))}
        >
          Schedule
        </button>
      </div>
      <ul className="session-scheduled__rows">
        {shown.list.map(({ item, key, phase }) => (
          <li
            key={key}
            className="session-scheduled__item"
            data-phase={phase}
            inert={phase === 'exiting' || undefined}
            onTransitionEnd={(event) => {
              if (
                event.target === event.currentTarget &&
                event.propertyName === 'opacity'
              )
                shown.settle(key);
            }}
          >
            <div className="session-scheduled__clip">
              {item.kind === 'wake-up' ? (
                <Row
                  glyph={<TimeGlyph className="session-scheduled__glyph" />}
                  name={item.wakeUp.note}
                  when={`Once at ${clockTime(Date.parse(item.wakeUp.dueAt), now)}`}
                  actions={
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={cancelWakeUp.isPending}
                      onClick={() => cancelWakeUp.mutate(item.wakeUp.id)}
                    >
                      Cancel
                    </Button>
                  }
                />
              ) : item.kind === 'resume' ? (
                <Row
                  glyph={<TimeGlyph className="session-scheduled__glyph" />}
                  name="Resume after usage limit"
                  when={`At ${clockTime(Date.parse(item.dueAt), now)}`}
                  actions={
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={holdResume.isPending}
                      onClick={() => holdResume.mutate(item.threadId)}
                    >
                      Cancel
                    </Button>
                  }
                />
              ) : item.kind === 'proposal' ? (
                <Row
                  glyph={<CalendarGlyph className="session-scheduled__glyph" />}
                  name={item.proposal.job.name}
                  when="Needs your approval"
                />
              ) : (
                <JobRow
                  name={item.job.name}
                  now={now}
                  onEdit={() =>
                    wrap(() => navigate('/schedule', { job: item.job.name }))
                  }
                />
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({
  glyph,
  name,
  when,
  live,
  actions,
}: {
  glyph: ReactNode;
  name: string;
  when: string;
  live?: boolean;
  actions?: ReactNode;
}) {
  return (
    <div className="session-scheduled__row">
      <span className="session-scheduled__icon" data-live={live || undefined}>
        {glyph}
      </span>
      <span className="session-scheduled__text">
        <span className="session-scheduled__name" title={name}>
          {name}
        </span>
        <span className="session-scheduled__when">{when}</span>
      </span>
      {actions ? (
        <span className="session-scheduled__actions">{actions}</span>
      ) : null}
    </div>
  );
}

function jobWhen(job: SchedulerJob, now: number): string {
  const next = job.nextRun ? Date.parse(job.nextRun) : Number.NaN;
  const cadence =
    job.schedule?.kind === 'every'
      ? everyText(job.schedule.everyMs)
      : job.schedule?.kind === 'at'
        ? `Once at ${clockTime(job.schedule.timeMs, now)}`
        : Number.isFinite(next)
          ? `Next at ${clockTime(next, now)}`
          : 'Scheduled';
  return job.enabled ? cadence : `${cadence} · paused`;
}

/** A job approved from this chat, read from the scheduler's own list. */
function JobRow({
  name,
  now,
  onEdit,
}: {
  name: string;
  now: number;
  onEdit: () => void;
}) {
  const jobs = useSchedulerJobs();
  const runJob = useRunJob();
  const toggleJob = useToggleJob();
  const job = (jobs.data as SchedulerJob[] | undefined)?.find(
    (candidate) => candidate.name === name,
  );
  // Deleted since, or the list is not readable here: nothing to act on.
  if (!job)
    return (
      <Row
        glyph={<CalendarGlyph className="session-scheduled__glyph" />}
        name={name}
        when={jobs.isError ? 'Unavailable' : jobs.isSuccess ? 'Deleted' : ' '}
      />
    );
  return (
    <Row
      glyph={<CalendarGlyph className="session-scheduled__glyph" />}
      name={job.name}
      when={jobWhen(job, now)}
      live={job.enabled}
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Run ${job.name} now`}
            title="Run now"
            disabled={runJob.isPending}
            onClick={() => runJob.mutate(job.name)}
          >
            <PlayGlyph className="session-scheduled__glyph" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Edit ${job.name}`}
            title="Edit"
            onClick={onEdit}
          >
            <EditGlyph className="session-scheduled__glyph" />
          </Button>
          {/* Wrapped, so the phone touch floor for a row's direct
              controls leaves the switch's own track alone; the wrapper
              carries the 44px target instead. */}
          <span className="session-scheduled__switch">
            <Toggle
              size="sm"
              checked={job.enabled}
              disabled={toggleJob.isPending}
              label={`${job.name} on`}
              onChange={(enabled) =>
                toggleJob.mutate({ target: job.name, enabled })
              }
            />
          </span>
        </>
      }
    />
  );
}
