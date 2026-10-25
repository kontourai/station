import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { TaskRoomAttachment } from '@kontourai/station-contracts/project-task-room';
import {
  type CanonicalRuntimeEvent,
  isDeferredRetriableTurnError,
} from '@kontourai/station-contracts/runtime-events';
import { taskStatusLabel } from '@kontourai/station-contracts/task-graph';
import type { TaskRoomWorkRecord } from '@kontourai/station-contracts/task-room-work';
import {
  INTERNAL_SESSION_READ_SCOPE,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import type { OrchestrationService } from '../orchestration/orchestration-service.js';
import type { ProjectTaskRoomRuntime } from '../orchestration/project-task-room-runtime.js';
import { ReceiverExecutionRefusal } from './project-contribution-service.js';
import type { TaskGraphService } from './task-graph-service.js';
import type {
  TaskRoomInvocationAdmission,
  TaskRoomWorkModule,
  TaskRoomWorkScope,
} from './task-room-work-module.js';

interface Dependencies {
  graph: Pick<TaskGraphService, 'startTaskRoomWork'>;
  readAgentLabel?(agentId: string): Promise<string | undefined>;
  work: TaskRoomWorkModule;
  room(): ProjectTaskRoomRuntime | undefined;
  authorize(
    taskId: string,
    request: Request,
    principal: PrincipalRef,
  ): Promise<TaskRoomWorkScope | undefined>;
  sessions: Pick<
    OrchestrationService,
    'readSession' | 'sessionQueries' | 'currentConversationSessionId'
  >;
  readBinding(
    sessionId: string,
  ): { taskId: string; projectId: string } | undefined | null;
  authorityForOwner(ownerId: string): SessionReadAuthority;
}

/** Room conversation effects compose TaskGraph, the request journal, and canonical Sessions. */
export class TaskRoomConversationModule {
  private readonly publications = new Map<
    string,
    { again: boolean; done: Promise<void> }
  >();
  private readonly publicationHolds = new Map<
    string,
    {
      count: number;
      ready: Promise<void>;
      finish(): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  holdPublication(taskId: string): () => void {
    let held = this.publicationHolds.get(taskId);
    if (!held) {
      let finish!: () => void;
      const ready = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const timer = setTimeout(() => {
        if (this.publicationHolds.get(taskId) === held) {
          this.publicationHolds.delete(taskId);
          finish();
        }
      }, 30_000);
      timer.unref?.();
      held = { count: 0, ready, finish, timer };
      this.publicationHolds.set(taskId, held);
    }
    held.count += 1;
    const lease = held;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lease.count -= 1;
      if (lease.count === 0) {
        clearTimeout(lease.timer);
        if (this.publicationHolds.get(taskId) === lease)
          this.publicationHolds.delete(taskId);
        lease.finish();
      }
    };
  }

  constructor(private readonly deps: Dependencies) {}

  async waitForPublication(taskId: string): Promise<void> {
    await this.publications.get(taskId)?.done;
  }

  reconcile(taskId: string): Promise<void> {
    const held = this.publicationHolds.get(taskId);
    if (held) return held.ready.then(() => this.reconcile(taskId));
    const current = this.publications.get(taskId);
    if (current) {
      current.again = true;
      return current.done;
    }
    const pending = { again: true, done: Promise.resolve() };
    pending.done = Promise.resolve().then(async () => {
      try {
        while (pending.again) {
          pending.again = false;
          await this.deps.room()?.reconcileAgentLifecycles([taskId]);
        }
      } finally {
        if (this.publications.get(taskId) === pending)
          this.publications.delete(taskId);
      }
    });
    this.publications.set(taskId, pending);
    return pending.done;
  }

  async observe(event: CanonicalRuntimeEvent): Promise<void> {
    const terminalError =
      event.method === 'runtime.error' &&
      event.turnId &&
      !isDeferredRetriableTurnError(event);
    if (
      !['turn.completed', 'turn.aborted'].includes(event.method) &&
      !terminalError
    )
      return;
    const binding = this.deps.readBinding(event.threadId);
    if (binding) await this.reconcile(binding.taskId);
  }

  async recorded(
    record: TaskRoomWorkRecord,
    request: Request,
    principal: PrincipalRef,
  ): Promise<void> {
    await this.waitForPublication(record.taskId);
    const scope = await this.deps.authorize(record.taskId, request, principal);
    const room = this.deps.room();
    if (!scope || scope.taskCreatedAt !== record.taskCreatedAt || !room) return;
    await room.message({
      taskId: record.taskId,
      request,
      proposalId: `room-request:${record.operationId}:${record.requesterId}`,
      occurredAt: record.createdAt,
      expectedTaskCreatedAt: record.taskCreatedAt,
      ...(record.attachments?.length
        ? { attachments: record.attachments }
        : {}),
      text: `**@${(await this.deps.readAgentLabel?.(record.agentId)) ?? record.agentId}** ${record.prompt}`,
    });
    const current = await this.deps.authorize(
      record.taskId,
      request,
      principal,
    );
    if (
      !current ||
      current.taskCreatedAt !== record.taskCreatedAt ||
      current.projectId !== scope.projectId ||
      current.requesterId !== scope.requesterId
    )
      return;
    const started = await this.deps.graph.startTaskRoomWork(
      record.taskId,
      record.taskCreatedAt,
    );
    if (started.changed)
      await room.message({
        taskId: record.taskId,
        request,
        expectedTaskCreatedAt: record.taskCreatedAt,
        proposalId: `room-status:${record.taskId}:${started.task.updatedAt}`,
        occurredAt: started.task.updatedAt,
        correlationId: 'room-status',
        text: `Status → ${taskStatusLabel(started.task.status)}`,
      });
  }

  async reply(
    input: {
      taskId: string;
      sessionId: string;
      taskCreatedAt: string;
      operationId: string;
      message: string;
      attachments?: TaskRoomAttachment[];
    },
    request: Request,
    principal: PrincipalRef,
  ): Promise<boolean> {
    await this.waitForPublication(input.taskId);
    const authorize = () =>
      this.deps.authorize(input.taskId, request, principal);
    const scope = await authorize();
    const room = this.deps.room();
    if (!scope || scope.taskCreatedAt !== input.taskCreatedAt || !room)
      return false;
    const binding = this.deps.readBinding(input.sessionId);
    if (
      !binding ||
      binding.taskId !== input.taskId ||
      binding.projectId !== scope.roomProjectId
    )
      return false;
    const list = await this.deps.work.list(input.taskId, authorize);
    if (
      list.kind !== 'available' ||
      !list.records.some(
        (record) =>
          record.sessionId === input.sessionId &&
          record.taskCreatedAt === input.taskCreatedAt,
      )
    )
      return false;
    const result = await room.message({
      taskId: input.taskId,
      request,
      proposalId: `room-thread:${input.operationId}`,
      text: input.message,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      expectedTaskCreatedAt: input.taskCreatedAt,
      correlationId: `room-thread:${input.sessionId}`,
    });
    return result.kind === 'committed' || result.kind === 'duplicate';
  }

  async admission(
    input: {
      taskId: string;
      taskCreatedAt: string;
      sessionId: string;
      operationId: string;
    },
    request: Request,
    principal: PrincipalRef,
  ): Promise<TaskRoomInvocationAdmission | undefined> {
    await this.waitForPublication(input.taskId);
    const admitted = await this.deps.authorize(
      input.taskId,
      request,
      principal,
    );
    if (!admitted || admitted.taskCreatedAt !== input.taskCreatedAt)
      return undefined;
    const recheck = async () => {
      const current = await this.deps.authorize(
        input.taskId,
        request,
        principal,
      );
      const requests = await this.deps.work.list(input.taskId, () =>
        this.deps.authorize(input.taskId, request, principal),
      );
      if (
        requests.kind !== 'available' ||
        !requests.records.some(
          (record) =>
            record.sessionId === input.sessionId &&
            record.taskCreatedAt === input.taskCreatedAt,
        )
      )
        throw new ReceiverExecutionRefusal(
          'receiver_execution_authority_changed',
          'This agent Session no longer belongs to this Task request.',
        );
      const binding = this.deps.readBinding(input.sessionId);
      if (
        !current ||
        current.taskCreatedAt !== admitted.taskCreatedAt ||
        current.projectId !== admitted.projectId ||
        current.roomProjectId !== admitted.roomProjectId ||
        current.projectSlug !== admitted.projectSlug ||
        current.requesterId !== admitted.requesterId ||
        !binding ||
        binding.projectId !== admitted.roomProjectId ||
        binding.taskId !== input.taskId ||
        this.deps.sessions.currentConversationSessionId(input.sessionId) !==
          input.sessionId
      )
        throw new ReceiverExecutionRefusal(
          'receiver_execution_authority_changed',
          'Task authority or agent Session changed before reply invocation.',
        );
      const session = await this.deps.sessions.readSession(
        input.sessionId,
        this.deps.authorityForOwner(principal.id),
      );
      if (!session)
        throw new ReceiverExecutionRefusal(
          'receiver_execution_authority_changed',
          'Agent Session access changed before reply invocation.',
        );
    };
    const releasePublication = this.holdPublication(input.taskId);
    let clientTurnId: string;
    try {
      await this.waitForPublication(input.taskId);
      await recheck();
      clientTurnId = await this.deps.work.admitReply({
        ...input,
        scope: admitted,
      });
      await recheck();
    } catch (error) {
      releasePublication();
      throw error;
    }
    return {
      releasePublication,
      expectedSessionId: input.sessionId,
      clientTurnId,
      roomBinding: { projectId: admitted.roomProjectId, taskId: input.taskId },
      recheck,
    };
  }

  async answers({
    sessionId,
    ownerOperatorId,
  }: {
    sessionId: string;
    ownerOperatorId: string;
  }) {
    const detail = await this.deps.sessions.readSession(
      sessionId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    if (!detail) return [];
    const starts = detail.events.filter(
      (event) => event.method === 'turn.started',
    );
    const admittedReplies = new Set(
      await this.deps.work.readReplyAdmissions(sessionId),
    );
    const roomTurns = new Set(
      starts
        .filter(
          (event, index) =>
            index === 0 ||
            (event.clientTurnId !== undefined &&
              admittedReplies.has(event.clientTurnId)),
        )
        .map((event) => event.turnId),
    );
    const completions = detail.events.filter(
      (event) =>
        event.method === 'turn.completed' &&
        event.turnId &&
        roomTurns.has(event.turnId) &&
        event.finishReason !== 'cancelled',
    );
    const answers = [];
    for (const event of completions) {
      const answer = await this.deps.sessions.sessionQueries.readAssistantTurn(
        { type: 'assistant-turn', threadId: sessionId, turnId: event.turnId! },
        this.deps.authorityForOwner(ownerOperatorId),
      );
      if (answer.status === 'unavailable')
        throw new Error('Completed Task answer is unavailable.');
      if (answer.status !== 'found') continue;
      const text = answer.message.parts
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('\n');
      if (text.trim())
        answers.push({
          turnId: answer.turnId,
          text,
          occurredAt: event.createdAt,
        });
    }
    return answers;
  }
}
