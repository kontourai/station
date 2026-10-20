import type {
  AgentJobProposal,
  AgentWakeUp,
} from '@kontourai/station-contracts/agent-schedule';
import { usePreviewSchedule } from '@kontourai/station-sdk';
import { useAgentSchedule } from '../../hooks/useAgentSchedule';
import { clockTime } from '../../utils/relativeTime';
import { Button } from '../Button';
import { CalendarGlyph, TimeGlyph } from '../icons/Glyph';
import { scheduleText } from './agentScheduleText';
import { useLeavingItems } from './useLeavingItems';
import './AgentScheduleNotes.css';

const wakeUpKey = (wakeUp: AgentWakeUp) => wakeUp.id;
const proposalKey = (proposal: AgentJobProposal) => proposal.id;

/**
 * What an agent scheduled in this chat, above the composer: a quiet note for
 * each check-back it will make, and an approval card for each job it asked
 * the person to create. Rows grow and collapse in place; nothing shows when
 * nothing is scheduled.
 */
export function AgentScheduleNotes({
  conversationId,
  refreshKey,
}: {
  conversationId: string;
  refreshKey: string;
}) {
  const { schedule, cancelWakeUp, declineProposal, approveProposal } =
    useAgentSchedule(conversationId, refreshKey);
  const wakeUps = useLeavingItems(schedule.wakeUps, wakeUpKey);
  const proposals = useLeavingItems(schedule.jobProposals, proposalKey);
  if (wakeUps.length === 0 && proposals.length === 0) return null;
  const now = Date.now();
  return (
    <ul className="agent-schedule-notes" aria-label="Scheduled in this chat">
      {proposals.map(({ item, key, leaving }) => (
        <li
          key={key}
          className="agent-schedule-notes__item"
          data-leaving={leaving || undefined}
          inert={leaving || undefined}
        >
          <div className="agent-schedule-notes__clip">
            <JobProposalCard
              proposal={item}
              now={now}
              busy={approveProposal.isPending || declineProposal.isPending}
              approving={
                approveProposal.isPending &&
                approveProposal.variables?.id === item.id
              }
              declining={
                declineProposal.isPending &&
                declineProposal.variables === item.id
              }
              failed={
                (approveProposal.isError &&
                  approveProposal.variables?.id === item.id) ||
                (declineProposal.isError &&
                  declineProposal.variables === item.id)
              }
              onApprove={() => approveProposal.mutate(item)}
              onDecline={() => declineProposal.mutate(item.id)}
            />
          </div>
        </li>
      ))}
      {wakeUps.map(({ item, key, leaving }) => (
        <li
          key={key}
          className="agent-schedule-notes__item"
          data-leaving={leaving || undefined}
          inert={leaving || undefined}
        >
          <div className="agent-schedule-notes__clip">
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
          </div>
        </li>
      ))}
    </ul>
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
        <dt>Prompt</dt>
        <dd className="agent-schedule-card__prompt" title={job.prompt}>
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
