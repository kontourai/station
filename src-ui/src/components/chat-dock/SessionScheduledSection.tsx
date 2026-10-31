import type {
  AgentJobProposal,
  AgentWakeUp,
} from '@kontourai/station-contracts/agent-schedule';
import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';
import type { ReactNode } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { schedulerJobDialogStore } from '../../contexts/scheduler-job-dialog-store';
import { useAgentSchedule } from '../../hooks/useAgentSchedule';
import {
  PRESENCE_FALLBACK_MS,
  usePresenceList,
} from '../../hooks/usePresenceList';
import {
  useRunJob,
  useScheduledConversationTargetCapability,
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
  | { kind: 'job'; key: string; name: string };

const rowKey = (row: ScheduledRow) => row.key;

/**
 * The "This chat" card's Automations section: everything that will act on
 * this conversation later, or that it set up. Check-backs the agent
 * scheduled, a usage-limit resume waiting for its reset, job proposals
 * waiting for the person, automations whose runs land in this chat, and
 * older jobs the person approved from here. Each row offers what its own
 * route allows: Cancel, or Run now / on-off / Edit for an automation. When
 * the host runs automations in a chat, it offers a new one for this chat even
 * with nothing listed; otherwise it is hidden when there is nothing to list.
 */
export function SessionScheduledSection({
  conversationId,
  wrap,
}: {
  conversationId: string;
  /** The sheet closes itself before a navigation. */
  wrap: (action: () => void) => void;
}) {
  const { schedule, loaded, cancelWakeUp, holdResume } =
    useAgentSchedule(conversationId);
  const { navigate } = useNavigation();
  const authority = useHostRequestAuthorityScope();
  const targetsSupported =
    useScheduledConversationTargetCapability().data === true;
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
    // An automation targeting this chat and a job approved here before
    // targets existed are the same kind of row; a name is listed once.
    ...[
      ...new Set([
        ...(schedule.automations ?? []).map((automation) => automation.name),
        ...schedule.jobs.map((job) => job.name),
      ]),
    ].map((name) => ({ kind: 'job' as const, key: `job:${name}`, name })),
  ];
  const shown = usePresenceList(rows, rowKey, PRESENCE_FALLBACK_MS, loaded);
  if (shown.list.length === 0 && !targetsSupported) return null;
  const now = Date.now();
  return (
    <section
      className="session-scheduled"
      aria-labelledby="session-scheduled-title"
    >
      <div className="session-scheduled__header">
        <h3 id="session-scheduled-title" className="session-scheduled__title">
          Automations
        </h3>
        {targetsSupported && authority ? (
          <button
            type="button"
            className="session-context-card__link session-scheduled__all"
            onClick={() =>
              wrap(() =>
                schedulerJobDialogStore.open({
                  authority,
                  prefill: { conversationId },
                }),
              )
            }
          >
            New automation
          </button>
        ) : null}
        <button
          type="button"
          className="session-context-card__link session-scheduled__all"
          onClick={() => wrap(() => navigate('/automations'))}
        >
          All automations
        </button>
      </div>
      {shown.list.length === 0 ? null : (
        <ul className="session-scheduled__rows">
          {shown.list.map(({ item, key, phase }) => (
            <li
              key={key}
              className="session-scheduled__item"
              data-phase={phase}
              inert={phase === 'exiting' || undefined}
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget) shown.settle(key);
              }}
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
                    when={
                      item.wakeUp.state === 'needs_approval'
                        ? 'Needs your approval'
                        : `Check-back at ${clockTime(Date.parse(item.wakeUp.dueAt), now)}`
                    }
                    actions={
                      item.wakeUp.state === 'needs_approval' ? undefined : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={cancelWakeUp.isPending}
                          onClick={() => cancelWakeUp.mutate(item.wakeUp.id)}
                        >
                          Cancel
                        </Button>
                      )
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
                    glyph={
                      <CalendarGlyph className="session-scheduled__glyph" />
                    }
                    name={item.proposal.job.name}
                    when="Needs your approval"
                  />
                ) : (
                  <JobRow
                    name={item.name}
                    now={now}
                    onEdit={() =>
                      wrap(() => navigate('/automations', { job: item.name }))
                    }
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
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
  const failing = job.consecutiveFailures
    ? ` · ${job.consecutiveFailures} failed`
    : '';
  return job.enabled ? `${cadence}${failing}` : `${cadence} · paused${failing}`;
}

/** An automation for this chat, read from the scheduler's own list. */
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
