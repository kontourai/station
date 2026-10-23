import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import {
  PROJECT_ROOM_LIMITS,
  type ProjectRoomActor,
  type ProjectRoomAgentRequest,
  type ProjectRoomAgentRequestInput,
  parseProjectRoomAgentRequestInput,
} from '@kontourai/station-contracts/project-room';
import { z } from 'zod/v3';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';
import {
  type ProjectRoomTaskContext,
  ROOM_TASK_CONTEXT_LIMITS,
  type RoomTaskSnapshot,
  roomTaskSnapshotSchema,
  sameRoomTaskScope,
} from './project-room-agent-task-context.js';
import { ProjectRoomStore } from './project-room-store.js';

export interface ProjectRoomAgentAuthority {
  scope: ProjectMembershipScope;
  requester: ProjectRoomActor;
  executionRoot: string;
  taskContext?: ProjectRoomTaskContext;
  /** Must reject changed incarnation, membership execute, compute grant, or root. Synchronous at SQLite commit. */
  assertCurrent(): void;
  /** Refresh request/account authority after asynchronous provider work. */
  refresh?(): Promise<void>;
}
export interface ProjectRoomAgentCapture {
  scope: ProjectMembershipScope;
  requester: ProjectRoomActor;
  executionRoot: string;
  sessionId: string;
  correlationId: string;
  agentId: string;
  agentLabel: string;
  checkpoint: { roomId: string; lastSeq: number };
  context: string;
  /** Missing on legacy captures means unavailable, never an empty inventory. */
  taskSnapshot?: RoomTaskSnapshot;
  digest: string;
}
export interface ProjectRoomAgentExecution {
  prepare(
    agentId: string,
    authority: ProjectRoomAgentAuthority,
  ): Promise<{ label: string }>;
  launch(
    capture: ProjectRoomAgentCapture,
    recheck: () => void,
    refresh?: () => Promise<void>,
  ): Promise<void>;
  answer(
    capture: ProjectRoomAgentCapture,
  ): Promise<{ turnId: string; text: string } | { failed: true } | null>;
  cancel(capture: ProjectRoomAgentCapture): Promise<void>;
}
export type ProjectRoomAgentFailure =
  | 'agent_unavailable'
  | 'launch_uncertain'
  | 'execution_failed'
  | 'publication_failed';
const failureSchema = z.enum([
  'agent_unavailable',
  'launch_uncertain',
  'execution_failed',
  'publication_failed',
]);
export type ProjectRoomAgentHandle = {
  failure?: ProjectRoomAgentFailure;
} & Omit<ProjectRoomAgentRequest, 'sessionId' | 'executionCorrelationId'>;
const publicHandle = ({
  sessionId: _session,
  executionCorrelationId: _correlation,
  ...handle
}: ProjectRoomAgentRequest): ProjectRoomAgentHandle => handle;
const stableIntent = (requestId: string, turnId: string) => {
  const hex = createHash('sha256')
    .update(JSON.stringify([requestId, turnId]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const captureSchema = z
  .object({
    scope: z
      .object({
        stationId: z.string().min(1),
        localProjectId: z.string().min(1),
        localProjectSlug: z.string().min(1),
        portableProjectId: z.string().min(1),
      })
      .strict(),
    requester: z
      .object({
        kind: z.literal('person'),
        id: z.string().min(1),
        displayName: z.string().min(1),
      })
      .strict(),
    executionRoot: z.string().min(1),
    sessionId: z.string().uuid(),
    correlationId: z.string().uuid(),
    agentId: z.string().min(1),
    agentLabel: z.string().min(1),
    checkpoint: z
      .object({
        roomId: z.string().uuid(),
        lastSeq: z.number().int().nonnegative(),
      })
      .strict(),
    context: z
      .string()
      .refine(
        (value) => Buffer.byteLength(value) <= PROJECT_ROOM_LIMITS.textBytes,
      ),
    taskSnapshot: roomTaskSnapshotSchema.optional(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const captureDigest = ({ digest: _, ...payload }: ProjectRoomAgentCapture) =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex');
export class ProjectRoomAgentModule {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: ProjectRoomStore,
    private readonly execution: ProjectRoomAgentExecution,
  ) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS project_room_agent_captures (request_id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT',
    );
    db.exec(
      'CREATE TABLE IF NOT EXISTS project_room_agent_failures (request_id TEXT PRIMARY KEY, code TEXT NOT NULL) STRICT',
    );
  }
  private failure(id: string, code: ProjectRoomAgentFailure): void {
    this.db
      .prepare(
        'INSERT INTO project_room_agent_failures VALUES (?, ?) ON CONFLICT(request_id) DO UPDATE SET code=excluded.code',
      )
      .run(id, code);
  }
  private capture(
    authority: ProjectRoomAgentAuthority,
    id: string,
  ): ProjectRoomAgentCapture | null {
    this.check(authority);
    const row = this.db
      .prepare(
        'SELECT record FROM project_room_agent_captures WHERE request_id=?',
      )
      .get(id);
    if (!row) return null;
    const capture = captureSchema.parse(JSON.parse(String(row.record)));
    const request = this.store.getRequest(authority.scope, id);
    if (
      JSON.stringify(capture) !== row.record ||
      capture.digest !== captureDigest(capture) ||
      capture.sessionId !== request.sessionId ||
      capture.correlationId !== request.executionCorrelationId ||
      capture.agentId !== request.agentId ||
      capture.requester.kind !== request.actor.kind ||
      capture.requester.id !== request.actor.id ||
      capture.requester.displayName !== request.actor.displayName ||
      capture.checkpoint.roomId !== request.roomId
    )
      throw new Error('Project room agent capture unavailable');
    const frame = JSON.parse(capture.context.split('\n')[0]!);
    if (
      capture.taskSnapshot
        ? !sameRoomTaskScope(capture.scope, capture.taskSnapshot.project) ||
          JSON.stringify(frame.tasks) !== JSON.stringify(capture.taskSnapshot)
        : frame.tasks !== undefined
    )
      throw new Error('Project room agent capture unavailable');
    this.check(authority, capture);
    return capture;
  }

  private check(
    authority: ProjectRoomAgentAuthority,
    capture?: ProjectRoomAgentCapture,
  ) {
    const result: unknown = authority.assertCurrent();
    if (result !== undefined)
      throw new Error('Project room agent authority unavailable');
    if (
      authority.requester.kind !== 'person' ||
      (capture &&
        (Object.entries(capture.scope).some(
          ([key, value]) =>
            authority.scope[key as keyof ProjectMembershipScope] !== value,
        ) ||
          capture.requester.id !== authority.requester.id ||
          capture.executionRoot !== authority.executionRoot))
    )
      throw new Error('Project room agent authority unavailable');
  }
  private evidence(
    authority: ProjectRoomAgentAuthority,
    capture: ProjectRoomAgentCapture,
  ) {
    if (!capture.taskSnapshot) return;
    if (!authority.taskContext) {
      if (capture.taskSnapshot.items.length)
        throw new Error('Project room Task evidence unavailable');
      return;
    }
    const result: unknown = authority.taskContext.assertCurrent(
      capture.taskSnapshot,
    );
    if (result !== undefined)
      throw new Error('Project room Task authority unavailable');
  }
  private async refreshEvidence(
    authority: ProjectRoomAgentAuthority,
    capture: ProjectRoomAgentCapture,
  ) {
    await authority.refresh?.();
    if (capture.taskSnapshot)
      await authority.taskContext?.refresh(capture.taskSnapshot);
    this.check(authority, capture);
    this.evidence(authority, capture);
  }
  private async withEvidence<T>(
    authority: ProjectRoomAgentAuthority,
    capture: ProjectRoomAgentCapture,
    operation: () => T,
  ): Promise<T> {
    const publish = () => {
      this.check(authority, capture);
      this.evidence(authority, capture);
      return operation();
    };
    return capture.taskSnapshot && authority.taskContext
      ? authority.taskContext.withCurrent(capture.taskSnapshot, publish)
      : publish();
  }
  inspect(
    authority: ProjectRoomAgentAuthority,
    id: string,
  ): ProjectRoomAgentHandle {
    this.check(authority);
    const request = this.store.getRequest(authority.scope, id);
    // Handles are shared; private Session coordinates never cross this seam.
    const storedFailure = this.db
      .prepare(
        'SELECT code FROM project_room_agent_failures WHERE request_id=?',
      )
      .get(id)?.code;
    const failure =
      storedFailure === undefined
        ? undefined
        : failureSchema.safeParse(storedFailure);
    if (failure && !failure.success)
      throw new Error('Project room failure unavailable');
    return {
      ...publicHandle(request),
      ...(failure &&
      request.state !== 'published' &&
      request.state !== 'cancelled'
        ? { failure: failure.data }
        : {}),
    };
  }
  /** Validated private coordinate for the completion observer; never expose in handles. */
  publicationSession(
    authority: ProjectRoomAgentAuthority,
    id: string,
  ): string | null {
    this.check(authority);
    const capture = this.capture(authority, id);
    const handle = this.inspect(authority, id);
    return capture &&
      ['started', 'uncertain'].includes(handle.state) &&
      (!handle.failure || handle.failure === 'launch_uncertain')
      ? capture.sessionId
      : null;
  }
  async request(
    authority: ProjectRoomAgentAuthority,
    input: ProjectRoomAgentRequestInput,
  ): Promise<ProjectRoomAgentHandle> {
    this.check(authority);
    // Serialize the mandatory request/frame before reserving or preparing an effect.
    // The wire budget is independent of the raw-text admission limit (JSON may expand).
    const value = parseProjectRoomAgentRequestInput(input);
    const first = this.store.history(authority.scope, 0, 100);
    const note = this.store.getNote(authority.scope);
    const messages = [...first.messages];
    let after = first.nextAfter;
    while (after !== null && after < first.checkpoint.lastSeq) {
      const page = this.store.history(authority.scope, after, 100);
      messages.push(
        ...page.messages.filter((m) => m.seq <= first.checkpoint.lastSeq),
      );
      after = page.nextAfter;
      if (page.messages.length === 0) break;
    }
    const throughCheckpoint = new Set(
      messages.map((message) => message.messageId),
    );
    const reviewedNote = note?.sourceMessageIds.every((id) =>
      throughCheckpoint.has(id),
    )
      ? note
      : null;
    const frame: {
      request: string;
      note: null | {
        markdown: string;
        revision: number;
        sourceMessageIds: string[];
      };
      checkpoint: ProjectRoomAgentCapture['checkpoint'];
      coverage: { note: string; history: string };
      tasks: RoomTaskSnapshot;
    } = {
      request: value.text,
      tasks: {
        version: 1,
        observedAt: new Date().toISOString(),
        project: structuredClone(authority.scope),
        coverage: 'omitted_budget',
        items: [],
      },
      note: null,
      checkpoint: first.checkpoint,
      coverage: {
        note: reviewedNote
          ? 'omitted_budget'
          : note
            ? 'omitted_unreviewed'
            : 'absent',
        history: 'bounded_recent_suffix',
      },
    };
    const serialize = (selected: unknown[]) =>
      `${JSON.stringify(frame)}\n${JSON.stringify(selected)}`;
    if (Buffer.byteLength(serialize([])) > PROJECT_ROOM_LIMITS.textBytes)
      throw new Error('Project room agent context exceeds limit');
    if (reviewedNote) {
      frame.note = {
        markdown: reviewedNote.markdown,
        revision: reviewedNote.revision,
        sourceMessageIds: reviewedNote.sourceMessageIds,
      };
      frame.coverage.note = 'included';
      if (Buffer.byteLength(serialize([])) > PROJECT_ROOM_LIMITS.textBytes) {
        frame.note = null;
        frame.coverage.note = 'omitted_budget';
      }
    }
    const request = this.store.reserveRequest(
      authority.scope,
      authority.requester,
      value,
      () => this.check(authority),
    );
    if (request.state !== 'reserved')
      return this.inspect(authority, request.requestId);
    let agent: { label: string };
    try {
      agent = await this.execution.prepare(request.agentId, authority);
    } catch {
      this.failure(request.requestId, 'agent_unavailable');
      return this.inspect(authority, request.requestId);
    }
    await authority.refresh?.();
    this.check(authority);

    const summaries = await authority.taskContext?.capture();
    frame.tasks.observedAt = new Date().toISOString();
    frame.tasks.coverage = summaries ? 'shared_subset' : 'unavailable';
    if (summaries) {
      for (const summary of summaries) {
        if (!sameRoomTaskScope(summary.project, authority.scope))
          throw new Error('Project room Task scope unavailable');
        const item = {
          shareId: summary.shareId,
          taskId: summary.task.id,
          taskCreatedAt: summary.task.createdAt,
          title: summary.task.title,
          status: summary.task.status,
        };
        // Budget using the longer coverage spelling before admitting a row.
        const candidate: RoomTaskSnapshot = {
          ...frame.tasks,
          coverage: 'bounded_subset',
          items: [...frame.tasks.items, item],
        };
        const previous = frame.tasks;
        frame.tasks = candidate;
        if (
          frame.tasks.items.length > ROOM_TASK_CONTEXT_LIMITS.items ||
          Buffer.byteLength(JSON.stringify(candidate)) >
            ROOM_TASK_CONTEXT_LIMITS.bytes ||
          Buffer.byteLength(serialize([])) > PROJECT_ROOM_LIMITS.textBytes
        ) {
          frame.tasks = {
            ...previous,
            coverage: previous.items.length
              ? 'bounded_subset'
              : 'omitted_budget',
          };
          break;
        }
        frame.tasks.coverage = 'shared_subset';
      }
    }
    frame.tasks = roomTaskSnapshotSchema.parse(frame.tasks);
    const selected: unknown[] = [];
    for (const message of messages.reverse()) {
      const candidate = {
        actor: message.actor,
        text: message.text,
        messageId: message.messageId,
        seq: message.seq,
      };
      if (
        Buffer.byteLength(serialize([candidate, ...selected])) >
        PROJECT_ROOM_LIMITS.textBytes
      )
        break;
      selected.unshift(candidate);
    }
    const context = serialize(selected);
    const capture: ProjectRoomAgentCapture = {
      scope: captureSchema.shape.scope.parse(authority.scope),
      requester: captureSchema.shape.requester.parse(authority.requester),
      executionRoot: authority.executionRoot,
      sessionId: randomUUID(),
      correlationId: request.executionCorrelationId,
      agentId: request.agentId,
      agentLabel: agent.label,
      checkpoint: first.checkpoint,
      context,
      taskSnapshot: frame.tasks,
      digest: '',
    };
    capture.digest = captureDigest(capture);
    captureSchema.parse(capture);
    // The unique capture is a durable launch fence. A crash before markStarted
    // leaves a reserved handle requiring operator reconciliation, never automatic replay.
    const recheck = () => {
      this.check(authority, capture);
      this.evidence(authority, capture);
      const current = this.store.getRequest(authority.scope, request.requestId);
      if (current.state !== 'started' && current.state !== 'uncertain')
        throw new Error('Project room agent request unavailable');
    };
    const inserted = await this.withEvidence(authority, capture, () => {
      const inserted = this.db
        .prepare(
          'INSERT OR IGNORE INTO project_room_agent_captures VALUES (?, ?)',
        )
        .run(request.requestId, JSON.stringify(capture));
      if (!inserted.changes) return false;
      this.store.markStarted(authority.scope, request.requestId, () =>
        this.check(authority, capture),
      );
      this.store.bindSession(
        authority.scope,
        request.requestId,
        capture.sessionId,
        recheck,
      );
      return true;
    });
    if (!inserted) return this.inspect(authority, request.requestId);
    try {
      await this.refreshEvidence(authority, capture);
      recheck();
      await this.execution.launch(capture, recheck, () =>
        this.refreshEvidence(authority, capture),
      );
    } catch {
      this.failure(request.requestId, 'launch_uncertain');
      const current = this.store.getRequest(authority.scope, request.requestId);
      if (current.state === 'started')
        this.store.markUncertain(authority.scope, request.requestId, () => {});
    }
    return this.inspect(authority, request.requestId);
  }
  async reconcile(
    authority: ProjectRoomAgentAuthority,
    id: string,
  ): Promise<ProjectRoomAgentHandle> {
    this.check(authority);
    const request = this.store.getRequest(authority.scope, id);
    const capture = this.capture(authority, id);
    this.check(authority, capture ?? undefined);
    const handle = this.inspect(authority, id);
    if (
      !capture ||
      !['started', 'uncertain'].includes(request.state) ||
      handle.failure === 'publication_failed'
    )
      return handle;
    let answer: Awaited<ReturnType<ProjectRoomAgentExecution['answer']>>;
    try {
      answer = await this.execution.answer(capture);
    } catch {
      throw new Error('Project room answer unavailable');
    }
    const current = () => {
      this.capture(authority, id);
      this.check(authority, capture);
      this.evidence(authority, capture);
      if (
        !['started', 'uncertain'].includes(
          this.store.getRequest(authority.scope, id).state,
        )
      )
        throw new Error('Project room agent request unavailable');
    };
    await this.refreshEvidence(authority, capture);
    current();
    if (answer && 'failed' in answer) {
      this.failure(id, 'execution_failed');
      if (request.state === 'started')
        this.store.markUncertain(authority.scope, id, current);
      return this.inspect(authority, id);
    }
    if (answer) {
      // Publish only a representable selected answer, never a private transcript
      // excerpt or provider diagnostic. This durable refusal fences future retries.
      if (
        !answer.text.trim() ||
        Buffer.byteLength(answer.text) > PROJECT_ROOM_LIMITS.textBytes
      ) {
        this.failure(id, 'publication_failed');
        if (request.state === 'started')
          this.store.markUncertain(authority.scope, id, current);
        return this.inspect(authority, id);
      }
      await this.withEvidence(authority, capture, () => {
        const message = this.store.append(
          authority.scope,
          {
            kind: 'agent',
            id: capture.agentId,
            displayName: capture.agentLabel,
          },
          {
            intentId: stableIntent(id, answer.turnId),
            text: answer.text,
            ...(request.replyTo ? { replyTo: request.replyTo } : {}),
          },
          current,
        );
        this.store.finishPublished(
          authority.scope,
          id,
          message.messageId,
          current,
        );
      });
    }
    return this.inspect(authority, id);
  }
  async cancel(
    authority: ProjectRoomAgentAuthority,
    id: string,
  ): Promise<ProjectRoomAgentHandle> {
    this.check(authority);
    const capture = this.capture(authority, id);
    this.check(authority, capture ?? undefined);
    const request = this.store.getRequest(authority.scope, id);
    if (request.actor.id !== authority.requester.id)
      throw new Error('Project room agent authority unavailable');
    if (request.state === 'cancelled' || request.state === 'published')
      return publicHandle(request);
    const cancelled = this.store.cancelRequest(authority.scope, id, () =>
      this.check(authority, capture ?? undefined),
    );
    if (capture) {
      try {
        await this.execution.cancel(capture);
      } catch {
        /* Durable cancellation fences publication even if interruption is unavailable. */
      }
    }
    return publicHandle(cancelled);
  }
}
export function createProjectRoomAgentRuntime(
  home: string,
  store: ProjectRoomStore,
  execution: ProjectRoomAgentExecution,
) {
  const db = openPrivateSqlite(
    join(home, 'security', 'project-room-agent.sqlite'),
    'Project room agent requests',
  );
  try {
    return {
      module: new ProjectRoomAgentModule(db, store, execution),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
