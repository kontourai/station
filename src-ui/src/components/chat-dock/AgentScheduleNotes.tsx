import type {
  AgentJobProposal,
  AgentWakeUp,
} from '@kontourai/station-contracts/agent-schedule';
import { usePreviewSchedule } from '@kontourai/station-sdk';
import type { ReactNode } from 'react';
import { useAgentSchedule } from '../../hooks/useAgentSchedule';
import {
  PRESENCE_FALLBACK_MS,
  usePresenceList,
} from '../../hooks/usePresenceList';
import { clockTime } from '../../utils/relativeTime';
import { Button } from '../Button';
import { CalendarGlyph, TimeGlyph } from '../icons/Glyph';
import { scheduleText } from './agentScheduleText';
import './AgentScheduleNotes.css';

const wakeUpKey = (wakeUp: AgentWakeUp) => wakeUp.id;
const proposalKey = (proposal: AgentJobProposal) => proposal.id;

/**
 * What an agent scheduled in this chat, above the composer: a quiet note for
 * each check-back it will make, an approval card for each check-back that
 * waits for the person, and one for each job it asked the person to create.
 * Rows that arrive or leave while the chat is open grow and collapse in
 * place; nothing shows when nothing is scheduled.
 */
export function AgentScheduleNotes({
  conversationId,
  refreshKey,
}: {
  conversationId: string;
  refreshKey: string;
}) {
  const {
    schedule,
    loaded,
    cancelWakeUp,
    approveWakeUp,
    declineWakeUp,
    declineProposal,
    approveProposal,
  } = useAgentSchedule(conversationId, refreshKey);
  const wakeUps = usePresenceList(
    schedule.wakeUps,
    wakeUpKey,
    PRESENCE_FALLBACK_MS,
    loaded,
  );
  const proposals = usePresenceList(
    schedule.jobProposals,
    proposalKey,
    PRESENCE_FALLBACK_MS,
    loaded,
  );
  if (wakeUps.list.length === 0 && proposals.list.length === 0) return null;
  const now = Date.now();
  const wakeUpBusy = approveWakeUp.isPending || declineWakeUp.isPending;
  return (
    <ul className="agent-schedule-notes" aria-label="Scheduled in this chat">
      {proposals.list.map(({ item, key, phase }) => (
        <PresenceRow
          key={key}
          phase={phase}
          onSettled={() => proposals.settle(key)}
        >
          <JobProposalCard
            proposal={item}
            now={now}
            busy={approveProposal.isPending || declineProposal.isPending}
            approving={
              approveProposal.isPending &&
              approveProposal.variables?.id === item.id
            }
            declining={
              declineProposal.isPending && declineProposal.variables === item.id
            }
            failed={
              (approveProposal.isError &&
                approveProposal.variables?.id === item.id) ||
              (declineProposal.isError && declineProposal.variables === item.id)
            }
            onApprove={() => approveProposal.mutate(item)}
            onDecline={() => declineProposal.mutate(item.id)}
          />
        </PresenceRow>
      ))}
      {wakeUps.list.map(({ item, key, phase }) => (
        <PresenceRow
          key={key}
          phase={phase}
          onSettled={() => wakeUps.settle(key)}
        >
          {item.state === 'needs_approval' ? (
            <CheckBackApprovalCard
              wakeUp={item}
              now={now}
              busy={wakeUpBusy}
              approving={
                approveWakeUp.isPending && approveWakeUp.variables === item.id
              }
              declining={
                declineWakeUp.isPending && declineWakeUp.variables === item.id
              }
              failed={
                (approveWakeUp.isError &&
                  approveWakeUp.variables === item.id) ||
                (declineWakeUp.isError && declineWakeUp.variables === item.id)
              }
              onApprove={() => approveWakeUp.mutate(item.id)}
              onDecline={() => declineWakeUp.mutate(item.id)}
            />
          ) : (
            <div className="agent-schedule-notes__note" title={item.note}>
              <TimeGlyph className="agent-schedule-notes__glyph" />
              <span className="agent-schedule-notes__text">
                Checking back at{' '}
                <time dateTime={item.dueAt}>
                  {clockTime(Date.parse(item.dueAt), now)}
                </time>
              </span>
              <Button
                size="sm"
                variant="ghost"
                pending={
                  cancelWakeUp.isPending && cancelWakeUp.variables === item.id
                }
                pendingLabel="Canceling…"
                disabled={cancelWakeUp.isPending}
                aria-label={`Cancel check-back at ${clockTime(Date.parse(item.dueAt), now)}`}
                onClick={() => cancelWakeUp.mutate(item.id)}
              >
                Cancel
              </Button>
            </div>
          )}
        </PresenceRow>
      ))}
    </ul>
  );
}

/**
 * One row of a presence list: it grows in only when it arrived after the
 * list first rendered (`entering`, an animation), and collapses in place
 * when it leaves (`exiting`, a transition). Either end settles it.
 */
function PresenceRow({
  phase,
  onSettled,
  children,
}: {
  phase: 'entering' | 'present' | 'exiting';
  onSettled: () => void;
  children: ReactNode;
}) {
  return (
    <li
      className="agent-schedule-notes__item"
      data-phase={phase}
      inert={phase === 'exiting' || undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onSettled();
      }}
      onTransitionEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.propertyName === 'opacity'
        )
          onSettled();
      }}
    >
      <div className="agent-schedule-notes__clip">{children}</div>
    </li>
  );
}

/**
 * A check-back an agent in an unconfined session asked for: nothing is sent
 * unless the person approves it before it is due. The note is what the
 * agent will be sent back, shown whole.
 */
function CheckBackApprovalCard({
  wakeUp,
  now,
  busy,
  approving,
  declining,
  failed,
  onApprove,
  onDecline,
}: {
  wakeUp: AgentWakeUp;
  now: number;
  busy: boolean;
  approving: boolean;
  declining: boolean;
  failed: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const at = clockTime(Date.parse(wakeUp.dueAt), now);
  return (
    <section
      className="agent-schedule-card"
      aria-label={`Check back at ${at}?`}
    >
      <p className="agent-schedule-card__title">
        <TimeGlyph className="agent-schedule-notes__glyph" />
        <strong>
          Check back at <time dateTime={wakeUp.dueAt}>{at}</time>?
        </strong>
      </p>
      <section
        className="agent-schedule-card__note"
        aria-label="Note"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable to be scrolled by keyboard.
        tabIndex={0}
      >
        {wakeUp.note}
      </section>
      {failed ? (
        <p className="agent-schedule-card__error" role="alert">
          That didn't go through. Try again.
        </p>
      ) : null}
      <div className="agent-schedule-card__actions">
        <Button
          variant="primary"
          size="sm"
          pending={approving}
          pendingLabel="Approving…"
          disabled={busy}
          onClick={onApprove}
        >
          Approve
        </Button>
        <Button
          size="sm"
          pending={declining}
          pendingLabel="Declining…"
          disabled={busy}
          onClick={onDecline}
        >
          Decline
        </Button>
      </div>
    </section>
  );
}

function JobProposalCard({
  proposal,
  now,
  busy,
  approving,
  declining,
  failed,
  onApprove,
  onDecline,
}: {
  proposal: AgentJobProposal;
  now: number;
  busy: boolean;
  approving: boolean;
  declining: boolean;
  failed: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const { job } = proposal;
  const cron = job.schedule.kind === 'cron' ? job.schedule : null;
  const preview = usePreviewSchedule(cron?.expr ?? null, cron?.timezone);
  const when = scheduleText(job.schedule, now, preview.data?.[0]);
  return (
    <section
      className="agent-schedule-card"
      aria-label={`Proposed job ${job.name}`}
    >
      <p className="agent-schedule-card__title">
        <CalendarGlyph className="agent-schedule-notes__glyph" />
        <strong>Create this scheduled job?</strong>
      </p>
      <dl className="agent-schedule-card__facts">
        <dt>Name</dt>
        <dd className="agent-schedule-card__name">{job.name}</dd>
        <dt>When</dt>
        <dd
          title={
            cron
              ? `${cron.expr}${cron.timezone ? ` (${cron.timezone})` : ''}`
              : undefined
          }
        >
          {when}
        </dd>
        {job.agent ? (
          <>
            <dt>Agent</dt>
            <dd>{job.agent}</dd>
          </>
        ) : null}
        <dt>Instructions</dt>
        <dd
          className="agent-schedule-card__prompt"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable to be scrolled by keyboard.
          tabIndex={0}
        >
          {job.prompt}
        </dd>
      </dl>
      {proposal.rationale ? (
        <p className="agent-schedule-card__why">{proposal.rationale}</p>
      ) : null}
      {failed ? (
        <p className="agent-schedule-card__error" role="alert">
          That didn't go through. Try again.
        </p>
      ) : null}
      <div className="agent-schedule-card__actions">
        <Button
          variant="primary"
          size="sm"
          pending={approving}
          pendingLabel="Creating…"
          disabled={busy}
          onClick={onApprove}
        >
          Approve
        </Button>
        <Button
          size="sm"
          pending={declining}
          pendingLabel="Declining…"
          disabled={busy}
          onClick={onDecline}
        >
          Decline
        </Button>
      </div>
    </section>
  );
}
