import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import type {
  ProjectRoomActor,
  ProjectRoomAgentRequest,
  ProjectRoomAgentRequestInput,
} from '@kontourai/station-contracts/project-room';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';
import { ProjectRoomStore } from './project-room-store.js';

export interface ProjectRoomAgentAuthority {
  scope: ProjectMembershipScope;
  requester: ProjectRoomActor;
  executionRoot: string;
  /** Must reject changed incarnation, membership execute, compute grant, or root. Synchronous at SQLite commit. */
  assertCurrent(): void;
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
  digest: string;
}
export interface ProjectRoomAgentExecution {
  prepare(
    agentId: string,
    authority: ProjectRoomAgentAuthority,
  ): Promise<{ label: string }>;
  launch(capture: ProjectRoomAgentCapture, recheck: () => void): Promise<void>;
  answer(
    capture: ProjectRoomAgentCapture,
  ): Promise<{ turnId: string; text: string } | null>;
  cancel(capture: ProjectRoomAgentCapture): Promise<void>;
}
export type ProjectRoomAgentHandle = Omit<
  ProjectRoomAgentRequest,
  'sessionId' | 'executionCorrelationId'
>;
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
export class ProjectRoomAgentModule {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: ProjectRoomStore,
    private readonly execution: ProjectRoomAgentExecution,
  ) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS project_room_agent_captures (request_id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT',
    );
  }
  private capture(id: string): ProjectRoomAgentCapture | null {
    const row = this.db
      .prepare(
        'SELECT record FROM project_room_agent_captures WHERE request_id=?',
      )
      .get(id);
    return row
      ? (JSON.parse(String(row.record)) as ProjectRoomAgentCapture)
      : null;
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
        (JSON.stringify(capture.scope) !== JSON.stringify(authority.scope) ||
          capture.requester.id !== authority.requester.id ||
          capture.executionRoot !== authority.executionRoot))
    )
      throw new Error('Project room agent authority unavailable');
  }
  inspect(
    authority: ProjectRoomAgentAuthority,
    id: string,
  ): ProjectRoomAgentHandle {
    this.check(authority);
    const request = this.store.getRequest(authority.scope, id);
    // Handles are shared; private Session coordinates never cross this seam.
    return publicHandle(request);
  }
  async request(
    authority: ProjectRoomAgentAuthority,
    input: ProjectRoomAgentRequestInput,
  ): Promise<ProjectRoomAgentHandle> {
    this.check(authority);
    const request = this.store.reserveRequest(
      authority.scope,
      authority.requester,
      input,
      () => this.check(authority),
    );
    if (request.state !== 'reserved') return publicHandle(request);
    let agent: { label: string };
    try {
      agent = await this.execution.prepare(request.agentId, authority);
    } catch {
      throw new Error('Project room Agent unavailable');
    }
    this.check(authority);
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
    const reviewedNote =
      note && note.sourceMessageIds.every((id) => throughCheckpoint.has(id))
        ? note
        : null;
    const prefix = JSON.stringify({
      request: request.text,
      note: reviewedNote
        ? {
            markdown: reviewedNote.markdown,
            revision: reviewedNote.revision,
            sourceMessageIds: reviewedNote.sourceMessageIds,
          }
        : null,
      checkpoint: first.checkpoint,
    });
    const selected: unknown[] = [];
    for (const message of messages.reverse()) {
      const candidate = {
        actor: message.actor,
        text: message.text,
        messageId: message.messageId,
        seq: message.seq,
      };
      if (
        Buffer.byteLength(
          `${prefix}\n${JSON.stringify([candidate, ...selected])}`,
        ) >
        16 * 1024
      )
        break;
      selected.unshift(candidate);
    }
    const context = `${prefix}\n${JSON.stringify(selected)}`;
    if (Buffer.byteLength(context) > 16 * 1024)
      throw new Error('Project room agent context exceeds limit');
    const capture: ProjectRoomAgentCapture = {
      scope: { ...authority.scope },
      requester: { ...authority.requester },
      executionRoot: authority.executionRoot,
      sessionId: randomUUID(),
      correlationId: request.executionCorrelationId,
      agentId: request.agentId,
      agentLabel: agent.label,
      checkpoint: first.checkpoint,
      context,
      digest: createHash('sha256')
        .update(
          JSON.stringify([
            authority.scope,
            authority.requester.id,
            authority.executionRoot,
            request.executionCorrelationId,
            context,
          ]),
        )
        .digest('hex'),
    };
    // The unique capture is a durable launch fence. A crash before markStarted
    // leaves a reserved handle requiring operator reconciliation, never automatic replay.
    const inserted = this.db
      .prepare(
        'INSERT OR IGNORE INTO project_room_agent_captures VALUES (?, ?)',
      )
      .run(request.requestId, JSON.stringify(capture));
    if (!inserted.changes) return this.inspect(authority, request.requestId);
    const recheck = () => {
      this.check(authority, capture);
      const current = this.store.getRequest(authority.scope, request.requestId);
      if (current.state !== 'started' && current.state !== 'uncertain')
        throw new Error('Project room agent request unavailable');
    };
    this.store.markStarted(authority.scope, request.requestId, () =>
      this.check(authority, capture),
    );
    this.store.bindSession(
      authority.scope,
      request.requestId,
      capture.sessionId,
      recheck,
    );
    try {
      await this.execution.launch(capture, recheck);
    } catch {
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
    const request = this.store.getRequest(authority.scope, id);
    const capture = this.capture(id);
    this.check(authority, capture ?? undefined);
    if (!capture || !['started', 'uncertain'].includes(request.state))
      return publicHandle(request);
    let answer: Awaited<ReturnType<ProjectRoomAgentExecution['answer']>>;
    try {
      answer = await this.execution.answer(capture);
    } catch {
      throw new Error('Project room answer unavailable');
    }
    const current = () => {
      this.check(authority, capture);
      if (
        !['started', 'uncertain'].includes(
          this.store.getRequest(authority.scope, id).state,
        )
      )
        throw new Error('Project room agent request unavailable');
    };
    current();
    if (answer) {
      const message = this.store.append(
        authority.scope,
        { kind: 'agent', id: capture.agentId, displayName: capture.agentLabel },
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
    }
    return this.inspect(authority, id);
  }
  async cancel(
    authority: ProjectRoomAgentAuthority,
    id: string,
  ): Promise<ProjectRoomAgentHandle> {
    this.check(authority);
    const capture = this.capture(id);
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
  return {
    module: new ProjectRoomAgentModule(db, store, execution),
    close: () => db.close(),
  };
}
