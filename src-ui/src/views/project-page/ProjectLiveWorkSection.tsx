import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { useOrchestrationSessionsQuery } from '@kontourai/station-sdk';
import { useCommandProjectTaskRoomLiveMutation } from '@kontourai/station-sdk/project-task-rooms';
import { type ReactNode, useMemo } from 'react';
import { AgentIcon } from '../../components/icons/AgentIcon';
import { useAgents } from '../../contexts/AgentsContext';
import { openChatsStore } from '../../contexts/open-chats-store';
import {
  useShowSurface,
  useShowSurfacePage,
} from '../../contexts/useShowSurface';
import { relativeTime } from '../../utils/relativeTime';
import {
  type SessionIconAgent,
  sessionIconAgent,
  sessionKindLabel,
  sessionRecency,
  sessionTitle,
} from '../../utils/sessionDisplay';
import {
  ProjectTaskRoomProvider,
  useProjectTaskRoomContext,
} from '../../workspace-panes/ProjectTaskRoomContext';
import {
  focusChatEventDetailForAction,
  isPeerDelegationRecord,
  resolveConversationOpenAction,
} from '../home/work-item-open-policy';
import {
  type SessionLane,
  type SessionLaneId,
  sessionWorkStatus,
} from '../sessions/sessions-lane-model';
import { projectLiveLanes } from './project-live-work-model';

/**
 * The row's second line: whose session it is, then the kind when it
 * distinguishes something (a delegated session), then a relative time when
 * there is a parseable stamp. Every segment is omitted rather than defaulted
 * when its fact is missing.
 *
 * The lifecycle state is deliberately NOT here — it is the state chip, so the
 * urgency is a shape rather than a word buried in a meta line.
 */
function liveWorkMeta(
  session: OrchestrationSessionSummary,
  ownerName: string,
  now: number,
): string {
  const parts: string[] = [ownerName];
  if (session.delegation) parts.push(sessionKindLabel(session));
  const recency = sessionRecency(session);
  if (recency > 0) parts.push(relativeTime(recency, now));
  return parts.join(' · ');
}

/**
 * What the row invites you to do. A "Needs you" row's whole point is that YOU
 * can discharge it, so it says so; a Running or Idle row is something to
 * look at, not something owed. Two words, both already this product's vocabulary.
 */
const LANE_CALL_TO_ACTION: Record<string, string> = {
  needsYou: 'Reply',
  running: 'Open',
  idle: 'Open',
};

/**
 * A paired Station's record is answered on that Station, never here, so its
 * Needs-you row invites opening (Activity), not replying.
 */
function liveWorkCallToAction(
  session: OrchestrationSessionSummary,
  laneId: string,
): string {
  if (isPeerDelegationRecord(session)) return 'Open';
  return LANE_CALL_TO_ACTION[laneId] ?? 'Open';
}

/**
 * What is live in this project right now, at the top of its own page
 * (archive#3202).
 *
 * The sidebar badge named a number and then abandoned the reader: selecting
 * the project landed on a page that surfaced none of the sessions the number
 * stood for. This is that number's destination, on the project the badge is
 * attached to — the page discharges its own badge instead of routing the
 * reader to a differently-scoped surface.
 *
 * SAME POPULATION BY CONSTRUCTION: the badge's count and this list are both
 * `projectLiveLanes` (see `project-live-work-model.ts`), and the badge's
 * tooltip is composed from the same lane labels these headings use. A list of
 * five under a badge reading six is structurally impossible here, not merely
 * unlikely.
 *
 * LIVE WORK ONLY — Needs you, Running and Idle. Recently finished and Earlier are
 * the Activity list's job; "All activity" links out for them. Every lane empty
 * renders NOTHING: no heading, no zero counts, no empty state. A permanent
 * block costs every reader space to tell most of them there is nothing to
 * read.
 *
 * READING IT WITHOUT READING IT: the lanes are told apart by three things
 * before any word is parsed — the left rail's weight and colour, the state
 * chip (filled accent for a request that is yours, quiet outline for work in
 * flight), and the row's own call to action. The agent's icon anchors each row
 * to a face; `AgentIcon`'s seeded identicon means an agent with no brand mark
 * still gets a stable, distinguishable tile rather than a shared grey square.
 * No new colours are introduced — every value below is an existing token.
 */
export function ProjectLiveWorkSection({ slug }: { slug: string }) {
  const { data: sessions = [] } = useOrchestrationSessionsQuery();
  const agents = useAgents();
  const showSurface = useShowSurface();
  // "All activity" is Home's "View Activity" verb: go to the page. A row's
  // session link stays the contextual reveal (`showSurface` with an intent).
  const showSurfacePage = useShowSurfacePage();
  // Read once per render, the same shape `SessionsView` uses: `now` only
  // separates Recently finished from Earlier — neither of which this section
  // renders — so it is not a memo input.
  const now = Date.now();
  const lanes = useMemo(
    () =>
      projectLiveLanes({
        sessions,
        agents,
        projectSlug: slug,
        now: Date.now(),
      }),
    [sessions, agents, slug],
  );
  const taskIds = useMemo(
    () => [
      ...new Set(
        lanes.flatMap((lane) =>
          lane.sessions.flatMap((session) =>
            session.delegation?.taskId ? [session.delegation.taskId] : [],
          ),
        ),
      ),
    ],
    [lanes],
  );

  if (lanes.length === 0) return null;

  /**
   * Opening is the resolution for a waiting row: it reopens the session
   * through the shared open policy — rehydrating into the chat overlay when
   * Station can, revealing Activity when it cannot (a deleted
   * agent, a read-only attached transcript). Both branches are archive#1297's
   * one rule, reused rather than re-decided here.
   */
  function open(session: OrchestrationSessionSummary) {
    const detail = focusChatEventDetailForAction(
      resolveConversationOpenAction({
        threadId: session.threadId,
        agentSlug: session.assignedAgentSlug,
        controlMode: session.controlMode,
        projectSlug: session.projectSlug,
        model: session.model,
        delegationEnvironmentKind: session.delegation?.environmentKind,
      }),
    );
    if (detail) openChatsStore.focus(detail);
    else showSurface('activity', { session: session.threadId });
  }

  function renderLane(lane: SessionLane) {
    return (
      <div
        key={lane.id}
        className={`project-page__live-work-lane project-page__live-work-lane--${lane.id}`}
      >
        <span className="project-page__live-work-eyebrow">{lane.heading}</span>
        <div className="project-page__live-work-rows">
          {lane.sessions.map((session) => (
            <ProjectLiveWorkRow
              key={session.threadId}
              session={session}
              owner={sessionIconAgent(session, agents)}
              now={now}
              laneId={lane.id}
              open={open}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <ProjectLiveWorkRoomProviders taskIds={taskIds}>
      <section
        className="project-page__live-work"
        aria-labelledby="project-live-work-title"
      >
        <div className="project-page__section-header">
          <span
            id="project-live-work-title"
            className="project-page__section-label"
          >
            Live work
          </span>
          {/* Everything this section deliberately does not show — finished runs
            and history — lives on the Activity list. The project filter there
            is component state with no route parameter today, so this lands on
            the unfiltered list; the station#3202 report states what threading
            it would take. */}
          <div className="project-page__live-work-actions">
            <button
              type="button"
              className="project-page__add-btn"
              onClick={() => showSurfacePage('activity')}
            >
              All activity
            </button>
          </div>
        </div>
        {lanes.map(renderLane)}
      </section>
    </ProjectLiveWorkRoomProviders>
  );
}

interface ProjectLiveWorkRowProps {
  session: OrchestrationSessionSummary;
  owner: SessionIconAgent;
  now: number;
  laneId: SessionLaneId;
  open(session: OrchestrationSessionSummary): void;
}

function ProjectLiveWorkRoomProviders({
  taskIds,
  children,
}: {
  taskIds: readonly string[];
  children: ReactNode;
}) {
  if (taskIds.length === 0) return children;
  const [taskId, ...remaining] = taskIds;
  return (
    <ProjectTaskRoomProvider taskId={taskId!}>
      <ProjectLiveWorkRoomProviders taskIds={remaining}>
        {children}
      </ProjectLiveWorkRoomProviders>
    </ProjectTaskRoomProvider>
  );
}

function ProjectLiveWorkRow(props: ProjectLiveWorkRowProps) {
  const taskId = props.session.delegation?.taskId;
  return taskId ? (
    <TaskRoomLiveWorkRow {...props} taskId={taskId} />
  ) : (
    <SessionLiveWorkRow {...props} />
  );
}

function SessionLiveWorkRow({
  session,
  owner,
  now,
  laneId,
  open,
}: ProjectLiveWorkRowProps) {
  const status = sessionWorkStatus(session, useAgents(), now);
  return (
    <button
      type="button"
      className="project-page__live-work-row"
      onClick={() => open(session)}
    >
      <AgentIcon
        agent={owner}
        size="small"
        className="project-page__live-work-icon"
      />
      <span className="project-page__live-work-body">
        <span className="project-page__live-work-title">
          {sessionTitle(session)}
        </span>
        <span className="project-page__live-work-meta">
          {liveWorkMeta(session, owner.name, now)}
        </span>
      </span>
      <span className="project-page__live-work-trailing">
        <span className="project-page__live-work-state">{status.word}</span>
        <span className="project-page__live-work-cta" aria-hidden="true">
          {liveWorkCallToAction(session, laneId)}
        </span>
      </span>
    </button>
  );
}

function TaskRoomLiveWorkRow({
  session,
  owner,
  now,
  laneId,
  open,
  taskId,
}: ProjectLiveWorkRowProps & { taskId: string }) {
  const status = sessionWorkStatus(session, useAgents(), now);
  const room = useProjectTaskRoomContext(taskId);
  const command = useCommandProjectTaskRoomLiveMutation(taskId);
  const target = room?.live?.participants.find(
    (participant) =>
      participant.publication === 'published' &&
      participant.work.sessionId === session.threadId,
  );
  const discovery = room?.discovery.data;
  const canObserve =
    (discovery?.kind === 'opened' || discovery?.kind === 'existing') &&
    discovery.capabilities.live &&
    target !== undefined;
  const title = sessionTitle(session);
  function observe(commandName: 'watch' | 'follow') {
    if (!canObserve || !target) return;
    void command
      .mutateAsync({
        command: commandName,
        paneId: `project-live:${taskId}`,
        targetActorId: target.actor.actorId,
      })
      .catch(() => undefined);
  }
  const presence =
    room?.stream === 'connecting'
      ? 'Checking published task-room presence…'
      : target
        ? `${target.actor.label} published: ${target.work.workName}`
        : 'No published task-room presence';
  return (
    <article className="project-page__live-work-row project-page__live-work-row--room">
      {target ? (
        <span
          className="project-page__live-work-presence"
          role="img"
          aria-label={`${target.actor.label} published live presence`}
        />
      ) : null}
      <AgentIcon
        agent={owner}
        size="small"
        className="project-page__live-work-icon"
      />
      <span className="project-page__live-work-body">
        <span className="project-page__live-work-title">{title}</span>
        <span className="project-page__live-work-meta">
          {liveWorkMeta(session, owner.name, now)}
        </span>
        <span className="project-page__live-work-working-on">{presence}</span>
      </span>
      <span className="project-page__live-work-trailing">
        <span className="project-page__live-work-state">{status.word}</span>
        <span className="project-page__live-work-cta" aria-hidden="true">
          {liveWorkCallToAction(session, laneId)}
        </span>
      </span>
      <span className="project-page__live-work-controls project-page__live-work-row-actions">
        <button
          type="button"
          onClick={() => observe('watch')}
          disabled={!canObserve || command.isPending}
          aria-label={`Watch ${title}`}
        >
          Watch
        </button>
        <button
          type="button"
          onClick={() => observe('follow')}
          disabled={!canObserve || command.isPending}
          aria-label={`Follow ${title}`}
        >
          Follow
        </button>
        <button type="button" onClick={() => open(session)}>
          Jump in
        </button>
        {/* A paired Station's record has no chat here: its conversation is
            the peer's. "Jump in" opens its Activity detail instead. */}
        {!isPeerDelegationRecord(session) && (
          <button type="button" onClick={() => open(session)}>
            Chat
          </button>
        )}
      </span>
    </article>
  );
}
