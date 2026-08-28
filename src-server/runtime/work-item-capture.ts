/** Runtime-owned managed-MCP capture before canonical terminal publication. */
import { createHash } from 'node:crypto';
import type { EventStore } from '../services/orchestration/event-store.js';
import {
  mintWorkItemResultProjectorProvenanceForReviewedLoader,
  WorkItemResultProjector,
} from '../services/orchestration/work-item-result-projector.js';
import type {
  InvocationContext,
  ToolCallContext,
  ToolCallResult,
} from './types.js';

function associationId(input: {
  sessionId: string;
  conversationId: string;
  turnId: string;
  toolCallId: string;
  workItemRef: string;
  nativeId: string;
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'station.work-item-capture/v1',
        input.sessionId,
        input.conversationId,
        input.turnId,
        input.toolCallId,
        input.workItemRef,
        input.nativeId,
      ]),
    )
    .digest('hex');
  return `swia:v1:${digest}`;
}

/** The sole production caller of EventStore's staged work-item admission. */
export class WorkItemCapture {
  private readonly projector = new WorkItemResultProjector();

  constructor(
    private readonly eventStore: EventStore,
    private readonly isPrincipalCurrent?: (input: {
      sessionId: string;
      principalId: string;
      userId: string;
      tenantId?: string;
    }) => boolean,
  ) {}

  capture(input: {
    tool: ToolCallContext;
    result: ToolCallResult;
    invocation: InvocationContext;
    /** Binds the staged candidate to its runtime generation/config/principal. */
    current: () => boolean;
  }): void {
    try {
      const { tool, result, invocation } = input;
      if (
        result.error ||
        !tool.mcp ||
        !result.mcp ||
        !invocation.sessionId ||
        !invocation.turnId ||
        !invocation.conversationId ||
        !invocation.principalId ||
        !invocation.userId ||
        !tool.toolCallId ||
        !input.current() ||
        !this.isPrincipalCurrent
      )
        return;
      const lineage = this.eventStore.conversationForSession(
        invocation.sessionId,
      );
      // The adapter-owned conversation field is only proof that this is the
      // exact executing Session. The durable Conversation identity belongs to
      // immutable lineage and can differ for a continuation child Session.
      if (!lineage || invocation.conversationId !== invocation.sessionId)
        return;
      const tenantId = this.eventStore.readSessionByThread(invocation.sessionId)
        ?.tenantExecutionContext?.tenantId;
      const principal = {
        sessionId: invocation.sessionId,
        principalId: invocation.principalId,
        userId: invocation.userId,
        ...(tenantId ? { tenantId } : {}),
      };
      const current = () =>
        input.current() && this.isPrincipalCurrent?.(principal) === true;
      if (!current()) return;
      const provenance = mintWorkItemResultProjectorProvenanceForReviewedLoader(
        tool.mcp.provenance,
      );
      if (!provenance) return;
      const base = {
        sessionId: invocation.sessionId,
        conversationId: lineage.conversationId,
        turnId: invocation.turnId,
        toolCallId: tool.toolCallId,
        terminalStatus: 'success' as const,
        provenance,
        githubArguments: tool.mcp.trustedArguments as {
          owner: string;
          repo: string;
          title: string;
        },
        content: result.mcp.trustedContent,
      };
      const projected = this.projector.project({
        ...base,
        associationId: 'swia:pending',
      });
      if (!projected) return;
      const candidate = this.projector.project({
        ...base,
        associationId: associationId(projected),
      });
      if (!candidate) return;
      this.eventStore.stageSessionWorkItemCandidate({
        candidate,
        current,
      });
    } catch {
      // Malformed, cancelled, revoked, and foreign material is non-observable.
    }
  }
}

/** Runtime-owned liveness/ACL recheck for both staging and terminal append. */
export function createEventStoreWorkItemPrincipalLiveness(
  eventStore: EventStore,
) {
  return (input: {
    sessionId: string;
    principalId: string;
    userId: string;
    tenantId?: string;
  }): boolean => {
    if (!input.principalId || !input.userId) return false;
    const session = eventStore.readSessionByThread(input.sessionId);
    if (
      !session ||
      eventStore.findSessionOwnerUserId(input.sessionId) !== input.userId
    )
      return false;
    return session.tenantExecutionContext?.tenantId === input.tenantId;
  };
}
