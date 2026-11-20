/**
 * The coordinator in a Project Room's `#general` channel (#5063).
 *
 * The Agent a person asks in `#general` decides where the message goes
 * (`parseCoordinatorReply`): an answer in place, new Tasks, or an existing
 * Task. This service turns that decision into effects and enforces the
 * Project's limits itself:
 *
 * - **Propose before start.** New Tasks wait on a card until a person
 *   presses Start, unless the Project starts them without asking.
 * - **Concurrency.** A started row waits for a slot; the store claims slots
 *   in one transaction against the Project's limit.
 * - **Pull requests.** A Task may open one only when the person's own
 *   message asked (or the Project allows it); the pre-tool guard
 *   (`guard`) refuses the rest, and the card counts each refusal.
 *
 * Each row's effects are keyed by its id: the Task is created idempotently,
 * the dispatcher refuses a second dispatch of the same Task, and the first
 * turn and the result message carry stable keys. A restart mid-Start-all
 * resumes the rows left `starting` with the same keys, so nothing starts
 * twice and each settled Task posts one result.
 *
 * The picture the coordinator works from is rebuilt for every request from
 * these rows and the room (#3513): a replacement coordinator Session loses
 * nothing.
 */
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import {
  askedForPullRequest,
  COORDINATOR_ROUTING_TAG,
  type CoordinatorTaskState,
  coordinatorTaskIsOpen,
  coordinatorTaskPath,
  PROJECT_ROOM_COORDINATOR_LIMITS,
  type ProjectRoomCoordinatorSettings,
  type ProjectRoomCoordinatorView,
  type ProjectRoomStatusSweep,
  parseCoordinatorReply,
} from '@kontourai/station-contracts/project-room-coordinator';
import type { TaskStatus } from '@kontourai/station-contracts/task-graph';
import { errorMessage } from '../../utils/error-message.js';
import { createLogger } from '../../utils/logger.js';
import { sameRoomTaskScope } from './project-room-agent-task-context.js';
import {
  type CoordinatorRowDraft,
  type CoordinatorRowRecord,
  coordinatorId,
  type ProjectRoomCoordinatorStore,
} from './project-room-coordinator-store.js';
import type { DispatchOutcome } from './task-dispatcher.js';

const logger = createLogger({ name: 'project-room-coordinator' });

const PUBLIC_START_REFUSALS = {
  starterUnavailable: 'The starter is unavailable.',
  projectChanged:
    'The Project changed or the person can no longer start work in it.',
  queueFull: "Its chat's queue is full.",
  firstMessageRefused: 'Station could not send it its first message.',
};

function cardRefusal(reason: string, taskId: string | undefined): string {
  if (Object.values(PUBLIC_START_REFUSALS).includes(reason)) return reason;
  return taskId
    ? 'Open the Task to check its status.'
    : 'Check the selected Agent and placement.';
}

/** The coordinator's actor on the messages Station posts for it. */
export const COORDINATOR_ACTOR = {
  kind: 'agent' as const,
  id: 'station-coordinator',
  displayName: 'Coordinator',
};

/** How a turn ended, read from its stored terminal event. */
export type CoordinatorTurnTerminal =
  | { kind: 'completed' }
  | { kind: 'failed'; reason: string };

export interface ProjectRoomCoordinatorPorts {
  /** The `project-room-coordinator` preview, read at each use. */
  enabled(): boolean;
  settings(projectSlug: string): ProjectRoomCoordinatorSettings;
  /** Where a new Task's Session runs in this Project. */
  placement(projectSlug: string): 'project' | 'worktree';
  /** The Agent's display name, or undefined when this Station lacks it. */
  agentLabel(agentId: string): Promise<string | undefined>;
  /** The Project's identity now; undefined when it is gone. */
  currentScope(projectSlug: string): ProjectMembershipScope | undefined;
  /** Whether this person may still start work (`execute`) in the Project. */
  mayStart(userId: string, localProjectId: string): boolean;
  createTask(
    input: {
      projectId: string;
      title: string;
      description: string;
      agentId: string;
    },
    key: string,
    authorize: () => boolean,
  ): Promise<{ id: string; createdAt: string }>;
  dispatchTask(input: {
    taskId: string;
    agentId: string;
    ownerUserId: string;
  }): Promise<DispatchOutcome>;
  readTask(
    taskId: string,
  ): { status: TaskStatus; sessionId?: string } | undefined;
  conversationForSession(sessionId: string): string | undefined;
  /** Queue one Station-framed turn as `userId`, idempotent per key. */
  submitTurn(input: {
    conversationId: string;
    clientTurnId: string;
    message: string;
    userId: string;
  }): 'queued' | 'conflict' | 'capacity' | 'not-permitted';
  /** The inbox entry under a key: where the turn went. */
  turnEntry(
    conversationId: string,
    clientTurnId: string,
  ):
    | { state: string; sessionId?: string; turnId?: string; reason?: string }
    | undefined;
  turnTerminal(
    sessionId: string,
    turnId: string,
  ): CoordinatorTurnTerminal | undefined;
  /**
   * The Agent's stored answer: one turn's, or the Session's latest when no
   * turn is named. Read as the Task's owner.
   */
  assistantText(input: {
    sessionId: string;
    turnId?: string;
    ownerUserId: string;
  }): Promise<string | undefined>;
  /**
   * Post as the coordinator in the row's room. The runtime rechecks, inside
   * the room's write transaction, that the Project is the same one, the room
   * is the same one and `starterId` may still start work there; otherwise it
   * throws and nothing is posted.
   */
  publishForStarter(input: {
    scope: ProjectMembershipScope;
    roomId: string;
    starterId: string;
    intentId: string;
    text: string;
  }): string;
  now?(): Date;
}

/** What `prepare` hands the room agent module to publish. */
export interface CoordinatorPublication {
  text: string;
  /** Bind the posted message (sync, inside the room's publication). */
  published(messageId: string): void;
  /** Start what the reply started, after it is posted. */
  after(): Promise<void>;
}

/** One coordinator Task as the frame reports it: its state and its result. */
interface FrameTask {
  taskId?: string;
  title: string;
  state: CoordinatorTaskState;
  result?: string;
}

const INSTRUCTIONS = [
  "You are this Project's coordinator in its #general channel. Decide where the person's newest request goes, then say so in one or two sentences.",
  '- Answer in place when you can answer from this conversation, the Project brief, its memory or the coordinator Tasks listed here. Start nothing for it.',
  '- Propose new Tasks for work that needs its own session (changes, investigations, anything long): one Task per independent piece, each prompt self-contained.',
  "- Send it to an existing Task when it adds to, corrects or asks about that Task's work.",
  'Do not do the work yourself and do not start Tasks with tools: Station starts them.',
  `End your reply with exactly one routing block, one of:`,
  `<${COORDINATOR_ROUTING_TAG}>{"route":"answer"}</${COORDINATOR_ROUTING_TAG}>`,
  `<${COORDINATOR_ROUTING_TAG}>{"route":"tasks","tasks":[{"title":"short title","prompt":"what the Task should do","pullRequest":false}]}</${COORDINATOR_ROUTING_TAG}>`,
  `<${COORDINATOR_ROUTING_TAG}>{"route":"task","taskId":"an id from tasks","message":"what to tell that Task"}</${COORDINATOR_ROUTING_TAG}>`,
  'Set pullRequest true only when the person asked for a pull request.',
].join('\n');

/** Markdown link text without brackets that would end it early. */
function linkText(text: string): string {
  return text.replace(/[[\]]/g, '');
}

function taskLink(row: Pick<CoordinatorRowRecord, 'title' | 'taskId'>) {
  return row.taskId
    ? `[${linkText(row.title)}](${coordinatorTaskPath(row.taskId)})`
    : `**${linkText(row.title)}**`;
}

function settledTaskNotice(
  row: Pick<CoordinatorRowRecord, 'title' | 'taskId'>,
  outcome: NonNullable<CoordinatorRowRecord['outcome']>,
): string {
  return `**Task ${outcome === 'completed' ? 'finished' : 'stopped'}:** ${taskLink(row)}`;
}

/** The first turn a coordinator Task receives. */
function coordinatorTaskMessage(row: CoordinatorRowRecord): string {
  return [
    `[Station] ${row.starterName ?? 'A person'} started this Task from the Project's #general channel. This message is from Station, not the person.`,
    row.mayOpenPullRequest
      ? 'You may open a pull request if the work calls for one.'
      : 'Do not open a pull request: the person did not ask for one, and Station refuses it. Report what you changed in your answer instead.',
    '',
    row.prompt,
  ].join('\n');
}

const FIRST_TURN_PREFIX = 'coordinator:';
const firstTurnKey = (rowId: string) => `${FIRST_TURN_PREFIX}${rowId}`;
/** UUID-shaped stable intent for a room message, as the room store requires. */
function intentFor(...parts: string[]): string {
  const hex = coordinatorId('intent', ...parts);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class ProjectRoomCoordinator {
  private readonly rowRuns = new Map<string, Promise<void>>();
  private readonly pumps = new Map<
    string,
    { again: boolean; run: Promise<void> }
  >();
  private closed = false;

  constructor(
    private readonly store: ProjectRoomCoordinatorStore,
    private readonly ports: ProjectRoomCoordinatorPorts,
  ) {}

  enabled(): boolean {
    return !this.closed && this.ports.enabled();
  }

  /**
   * What the coordinator works from besides the room's recent messages and
   * the Project brief and memory its Session starts with: its instructions
   * and a report per coordinator Task (state and result, never its steps).
   */
  frame(
    scope: ProjectMembershipScope,
    roomId: string,
  ): {
    instructions: string;
    tasks: FrameTask[];
  } {
    const rows = this.store
      .proposals(scope.localProjectId, roomId, 12)
      .flatMap((proposal) => proposal.rows)
      .filter((row) => row.state !== 'proposed')
      .slice(0, 12);
    return {
      instructions: INSTRUCTIONS,
      tasks: rows.map((row) => ({
        ...(row.taskId ? { taskId: row.taskId } : {}),
        title: row.title,
        state: row.state,
        ...(row.refusal
          ? { result: 'Start refused' }
          : row.outcome
            ? { result: row.outcome }
            : {}),
      })),
    };
  }

  /**
   * Route one coordinator reply. Every effect is keyed by the request, so a
   * replayed publication repeats nothing.
   */
  async prepare(input: {
    scope: ProjectMembershipScope;
    roomId: string;
    requestId: string;
    requester: { id: string; displayName: string };
    askedAgentId: string;
    askedAgentLabel: string;
    requestText: string;
    answerText: string;
  }): Promise<CoordinatorPublication> {
    const parsed = parseCoordinatorReply(input.answerText);
    const body = parsed.text;
    const plain = (line: string): CoordinatorPublication => ({
      text: [body, line].filter(Boolean).join('\n\n'),
      published: () => {},
      after: async () => {},
    });
    if (!this.enabled()) return plain('');
    const routing = parsed.routing;
    if (routing.kind === 'answer')
      return plain('_Answered here; no Task started._');
    if (routing.kind === 'existing-task') {
      const row = this.store.rowForTask(
        input.scope.localProjectId,
        routing.taskId,
      );
      if (!row?.taskId || !row.conversationId || row.roomId !== input.roomId)
        return plain(
          "_Answered here: that Task wasn't started from #general, so nothing was sent to it._",
        );
      const outcome = this.ports.submitTurn({
        conversationId: row.conversationId,
        clientTurnId: `${FIRST_TURN_PREFIX}route:${input.requestId}`,
        message: [
          `[Station] ${input.requester.displayName} wrote in #general, and the coordinator sent it to this Task. This message is from Station.`,
          '',
          routing.message,
        ].join('\n'),
        userId: input.requester.id,
      });
      return outcome === 'queued'
        ? plain(`_Sent to Task ${taskLink(row)}._`)
        : plain(
            `_Answered here: ${taskLink(row)} could not take the message (${outcome === 'not-permitted' ? 'you cannot send to its chat' : 'its queue is full'})._`,
          );
    }
    const projectSlug = input.scope.localProjectSlug;
    const settings = this.ports.settings(projectSlug);
    const placement = this.ports.placement(projectSlug);
    const asked =
      settings.pullRequests === 'allowed' ||
      askedForPullRequest(input.requestText);
    const drafts: CoordinatorRowDraft[] = [];
    for (const task of routing.tasks) {
      const agentId = task.agentId ?? input.askedAgentId;
      const label =
        agentId === input.askedAgentId
          ? input.askedAgentLabel
          : await this.ports.agentLabel(agentId);
      drafts.push({
        title: task.title,
        prompt: task.prompt,
        agentId: label ? agentId : input.askedAgentId,
        agentLabel: label ?? input.askedAgentLabel,
        placement,
        mayOpenPullRequest:
          settings.pullRequests === 'allowed' || (asked && task.pullRequest),
      });
    }
    const startNow =
      settings.startWithoutAsking &&
      this.ports.mayStart(input.requester.id, input.scope.localProjectId);
    const proposal = this.store.recordProposal({
      requestId: input.requestId,
      scope: input.scope,
      roomId: input.roomId,
      rows: drafts,
      ...(startNow
        ? {
            startAs: {
              id: input.requester.id,
              name: input.requester.displayName,
            },
          }
        : {}),
    });
    // From the recorded card, not the live settings: a replayed publication
    // must post the same text under the same intent.
    const count = proposal.rows.length;
    const noun = count === 1 ? 'Task' : 'Tasks';
    const line = proposal.autoStart
      ? `_Starting ${count} new ${noun}. Each links from the card below._`
      : `_Proposed ${count} new ${noun}. Start them from the card below._`;
    return {
      text: [body, line].filter(Boolean).join('\n\n'),
      published: (messageId) =>
        this.store.attachMessage(proposal.proposalId, messageId),
      after: () =>
        proposal.autoStart
          ? this.pump(input.scope.localProjectId)
          : Promise.resolve(),
    };
  }

  /** The card view for one Project's `#general`. */
  view(
    scope: ProjectMembershipScope,
    roomId: string,
  ): ProjectRoomCoordinatorView {
    const proposals = this.store.proposals(
      scope.localProjectId,
      roomId,
      PROJECT_ROOM_COORDINATOR_LIMITS.viewProposals,
    );
    return {
      projectSlug: scope.localProjectSlug,
      settings: this.ports.settings(scope.localProjectSlug),
      working: this.store.holding(scope.localProjectId),
      waiting: this.store.rowsIn(['waiting'], scope.localProjectId).length,
      proposals: proposals.map((proposal) => ({
        proposalId: proposal.proposalId,
        ...(proposal.messageId ? { messageId: proposal.messageId } : {}),
        createdAt: proposal.createdAt,
        tasks: proposal.rows.map((row) => ({
          rowId: row.rowId,
          title: row.title,
          prompt: row.prompt,
          agentId: row.agentId,
          agentLabel: row.agentLabel,
          placement: row.placement,
          mayOpenPullRequest: row.mayOpenPullRequest,
          pullRequestRefusals: row.pullRequestRefusals,
          state: row.state,
          ...(row.taskId ? { taskId: row.taskId } : {}),
          ...(row.refusal
            ? { refusal: cardRefusal(row.refusal, row.taskId) }
            : {}),
          ...(row.resultMessageId
            ? { resultMessageId: row.resultMessageId }
            : {}),
          updatedAt: row.updatedAt,
        })),
      })),
    };
  }

  /**
   * Start: a person presses Start (some rows) or Start all. The rows wait
   * for a slot; the pump starts as many as the Project's limit allows.
   */
  async start(input: {
    scope: ProjectMembershipScope;
    roomId: string;
    proposalId: string;
    rowIds?: readonly string[];
    starter: { id: string; displayName: string };
  }): Promise<ProjectRoomCoordinatorView> {
    const proposal = this.store.proposal(input.proposalId);
    if (
      !proposal ||
      proposal.localProjectId !== input.scope.localProjectId ||
      proposal.roomId !== input.roomId
    )
      throw new CoordinatorRefusal('not_found');
    this.store.queue(input.proposalId, input.rowIds, {
      id: input.starter.id,
      name: input.starter.displayName,
    });
    await this.pump(input.scope.localProjectId);
    return this.view(input.scope, input.roomId);
  }

  /**
   * Fill free slots in one Project. Single-flight per Project: a call while
   * one runs asks it to go round again.
   */
  pump(localProjectId: string): Promise<void> {
    const running = this.pumps.get(localProjectId);
    if (running) {
      running.again = true;
      return running.run;
    }
    const entry = { again: true, run: Promise.resolve() };
    entry.run = (async () => {
      try {
        while (entry.again && !this.closed) {
          entry.again = false;
          if (!this.ports.enabled()) return;
          const sample = this.store.rowsIn(['waiting'], localProjectId)[0];
          if (!sample) return;
          const limit = this.ports.settings(
            sample.scope.localProjectSlug,
          ).maxConcurrentTasks;
          const claimed = this.store.claimSlots(localProjectId, limit);
          await Promise.all(claimed.map((row) => this.runRow(row.rowId)));
        }
      } finally {
        this.pumps.delete(localProjectId);
      }
    })();
    this.pumps.set(localProjectId, entry);
    return entry.run;
  }

  /** One step of a row, never two at once for the same row. */
  private runRow(rowId: string): Promise<void> {
    const running = this.rowRuns.get(rowId);
    if (running) return running;
    const run = (async () => {
      try {
        const row = this.store.row(rowId);
        if (row?.state === 'starting') await this.startRow(row);
        else if (row?.state === 'working') await this.settleRow(row);
      } catch (error) {
        logger.warn('Coordinator Task step did not finish; it is retried', {
          rowId,
          error: errorMessage(error),
        });
      } finally {
        this.rowRuns.delete(rowId);
      }
    })();
    this.rowRuns.set(rowId, run);
    return run;
  }

  private refuse(row: CoordinatorRowRecord, refusal: string): void {
    if (
      this.store.transition(row.rowId, ['starting'], {
        state: 'refused',
        refusal,
      })
    )
      void this.pump(row.scope.localProjectId);
  }

  /** Create, dispatch and brief one Task. Every step is keyed by the row. */
  private async startRow(row: CoordinatorRowRecord): Promise<void> {
    if (!this.ports.enabled()) return;
    const starter = row.starterId;
    if (!starter)
      return this.refuse(row, PUBLIC_START_REFUSALS.starterUnavailable);
    const projectScope = row.scope;
    const authorize = () => {
      const current = this.ports.currentScope(projectScope.localProjectSlug);
      return (
        Boolean(current && sameRoomTaskScope(current, projectScope)) &&
        this.ports.mayStart(starter, projectScope.localProjectId)
      );
    };
    const refused = () =>
      this.refuse(row, PUBLIC_START_REFUSALS.projectChanged);
    if (!authorize()) return refused();
    let taskId = row.taskId;
    if (!taskId) {
      try {
        const task = await this.ports.createTask(
          {
            projectId: projectScope.localProjectSlug,
            title: row.title,
            description: row.prompt,
            agentId: row.agentId,
          },
          row.rowId,
          authorize,
        );
        taskId = task.id;
      } catch (error) {
        return this.refuse(
          row,
          `Could not create its Task: ${errorMessage(error)}`,
        );
      }
      const updated = this.store.transition(row.rowId, ['starting'], {
        taskId,
      });
      if (!updated) return;
      row = updated;
    }
    if (!authorize()) return refused();
    let sessionId = row.sessionId ?? this.ports.readTask(taskId)?.sessionId;
    if (!sessionId) {
      const outcome = await this.ports.dispatchTask({
        taskId,
        agentId: row.agentId,
        ownerUserId: starter,
      });
      if (outcome.kind === 'dispatched')
        sessionId = outcome.result.session.threadId;
      else if (outcome.kind === 'contended' || outcome.kind === 'terminal')
        // Dispatched already (a restart after the start): the Task names it.
        sessionId = this.ports.readTask(taskId)?.sessionId;
      else if (
        outcome.kind === 'failed' ||
        outcome.kind === 'forbidden' ||
        outcome.kind === 'not-found' ||
        (outcome.kind === 'unavailable' && !outcome.retryable)
      )
        return this.refuse(row, `Its Task did not start: ${outcome.reason}`);
      // Indeterminate or retryable: stays `starting`; the next pass retries
      // with the same Task, which the dispatcher never starts twice.
      if (!sessionId) return;
    }
    const conversationId = this.ports.conversationForSession(sessionId);
    if (!conversationId) return;
    if (!authorize()) return refused();
    const submitted = this.ports.submitTurn({
      conversationId,
      clientTurnId: firstTurnKey(row.rowId),
      message: coordinatorTaskMessage(row),
      userId: starter,
    });
    if (submitted === 'not-permitted' || submitted === 'capacity')
      return this.refuse(
        row,
        submitted === 'capacity'
          ? PUBLIC_START_REFUSALS.queueFull
          : PUBLIC_START_REFUSALS.firstMessageRefused,
      );
    if (submitted === 'conflict') return;
    this.store.transition(row.rowId, ['starting'], {
      state: 'working',
      taskId,
      sessionId,
      conversationId,
    });
  }

  private taskOutcome(
    taskId: string,
    conversationId: string,
    rowId: string,
  ): CoordinatorRowRecord['outcome'] {
    const status = this.ports.readTask(taskId)?.status;
    if (status === 'done') return 'completed';
    if (status === 'canceled') return 'failed';
    const entry = this.ports.turnEntry(conversationId, firstTurnKey(rowId));
    if (entry?.state === 'refused') return 'failed';
    if (
      entry?.state === 'sent' &&
      entry.sessionId &&
      entry.turnId &&
      this.ports.turnTerminal(entry.sessionId, entry.turnId)?.kind === 'failed'
    )
      return 'failed';
    return undefined;
  }

  /** Persist the exact room payload before attempting its idempotent write. */
  private async settleRow(row: CoordinatorRowRecord): Promise<void> {
    const { conversationId, sessionId, taskId, starterId } = row;
    if (!conversationId || !sessionId || !taskId || !starterId) return;
    let { outcome, resultText } = row;
    if (!outcome || !resultText) {
      outcome = this.taskOutcome(taskId, conversationId, row.rowId);
      if (!outcome) return;
      resultText = settledTaskNotice(row, outcome);
      if (
        !this.store.transition(row.rowId, ['working'], { outcome, resultText })
      )
        return;
    }
    let resultMessageId: string | undefined;
    let resultWithheld: string | undefined;
    if (resultText !== settledTaskNotice(row, outcome)) {
      // An earlier preview may have prepared a private excerpt. Preserve the
      // stored text without replaying it or replacing an already-posted intent.
      resultWithheld =
        'Earlier Room result withheld. Open the Task for its work.';
    } else {
      try {
        resultMessageId = this.ports.publishForStarter({
          scope: row.scope,
          roomId: row.roomId,
          starterId,
          intentId: intentFor('result', row.rowId),
          text: resultText,
        });
      } catch (error) {
        if (!(error instanceof CoordinatorResultWithheld)) throw error;
        resultWithheld = error.message;
      }
    }
    const settled = this.store.transition(row.rowId, ['working'], {
      state: outcome === 'completed' ? 'done' : 'failed',
      ...(resultMessageId ? { resultMessageId } : {}),
      ...(resultWithheld ? { resultWithheld } : {}),
    });
    if (settled) void this.pump(row.scope.localProjectId);
  }

  /** A turn ended in some Session: settle its row, if it has one. */
  observe(sessionId: string): void {
    if (this.closed) return;
    const row = this.store.rowForSession(sessionId);
    if (row?.state === 'working') void this.runRow(row.rowId);
  }

  /**
   * Boot, reconnect and the periodic fallback: resume rows left `starting`
   * with their original keys, settle `working` rows whose turn ended while
   * nobody listened, and fill free slots.
   */
  async reconcile(): Promise<void> {
    if (this.closed || !this.ports.enabled()) return;
    const open = this.store.rowsIn(['starting', 'working']);
    await Promise.all(open.map((row) => this.runRow(row.rowId)));
    await Promise.all(
      this.store.activeProjects().map((project) => this.pump(project)),
    );
  }

  /**
   * The status sweep checks for a stored answer for each open Task.
   * Room history gets the result link and availability, not private bytes.
   */
  async sweep(input: {
    scope: ProjectMembershipScope;
    roomId: string;
    requesterId: string;
    post(text: string): string;
  }): Promise<ProjectRoomStatusSweep> {
    const rows = this.store
      .rowsIn(['waiting', 'starting', 'working'], input.scope.localProjectId)
      .filter(
        (row) =>
          row.roomId === input.roomId && coordinatorTaskIsOpen(row.state),
      )
      .slice(0, PROJECT_ROOM_COORDINATOR_LIMITS.sweepTasks);
    const lines: string[] = [];
    for (const row of rows) {
      let output = 'No output yet.';
      let waiting = 'nothing';
      if (row.state === 'waiting') waiting = 'a free slot';
      else if (row.state === 'starting') waiting = 'Station to start it';
      if (row.sessionId && row.starterId) {
        const text = await this.ports.assistantText({
          sessionId: row.sessionId,
          ownerUserId: row.starterId,
        });
        if (text) output = 'A written answer is available in the Task.';
        const status = row.taskId
          ? this.ports.readTask(row.taskId)?.status
          : undefined;
        const entry = row.conversationId
          ? this.ports.turnEntry(row.conversationId, firstTurnKey(row.rowId))
          : undefined;
        if (status === 'blocked') waiting = 'you: it is blocked';
        else if (status === 'review') waiting = 'your review';
        else if (entry?.state === 'queued')
          waiting = 'its turn in the chat queue';
      }
      lines.push(
        `- ${taskLink(row)}. Reported: ${output} Waiting on: ${waiting}.`,
      );
    }
    const text = lines.length
      ? [
          `**Status of ${lines.length} open ${lines.length === 1 ? 'Task' : 'Tasks'}**`,
          ...lines,
        ].join('\n')
      : '**Status:** no open Tasks were started from #general.';
    const messageId = input.post(text);
    return { messageId, tasks: lines.length };
  }

  /**
   * Pre-tool guard: a coordinator Task whose person did not ask for a pull
   * request may not open one. `opensPullRequest` reads the call.
   */
  guard(input: {
    conversationId: string | undefined;
    opensPullRequest: boolean;
  }): { decision: 'deny'; predicate: string } | undefined {
    if (!input.opensPullRequest || !input.conversationId || this.closed)
      return undefined;
    const row = this.store.rowForSession(input.conversationId);
    if (!row || row.mayOpenPullRequest || !this.ports.enabled())
      return undefined;
    this.store.countPullRequestRefusal(row.rowId);
    return {
      decision: 'deny',
      predicate:
        'was refused: the person did not ask for a pull request, and this Project opens pull requests only when asked. Report the change in your answer instead.',
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([
      ...[...this.rowRuns.values()],
      ...[...this.pumps.values()].map((pump) => pump.run),
    ]);
  }
}

/** A coordinator operation the person can act on. */
export class CoordinatorRefusal extends Error {
  constructor(readonly code: 'not_found' | 'preview_off') {
    super(`Project Room coordinator refused: ${code}`);
  }
}

/** Background publication lost its authority for the recorded room. */
export class CoordinatorResultWithheld extends Error {}
