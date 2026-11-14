/**
 * Translates Copilot runtime session events into Station runtime events.
 *
 * The input is `SessionEvent` from `@github/copilot-sdk` (1.0.32,
 * `dist/generated/session-events.d.ts`; github/copilot-sdk
 * `nodejs/src/generated/session-events.ts`). The translator holds only what
 * one session needs to stay consistent (which assistant messages streamed,
 * which tools and subagents are open) and performs no I/O; the adapter stamps
 * the common event fields and owns turn settlement.
 *
 * Root vs subagent: an event carrying `agentId`, or a tool event carrying
 * `parentToolCallId`, belongs to a subagent. Subagent text and tool calls are
 * not shown in the parent's transcript; a subagent appears as child work
 * (`subagent.started` → upsert, `subagent.completed`/`failed` → settle).
 */
import type { SessionEvent } from '@github/copilot-sdk';
import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import {
  ENGINE_MCP_ERROR_MAX_CHARS,
  ENGINE_MCP_SERVER_NAME_MAX_CHARS,
  ENGINE_MCP_STATUS_MAX_SERVERS,
  type EngineMcpServerState,
  type EngineMcpServerStatus,
  type EngineToolKind,
  type ProviderRuntimeEvent,
} from '@kontourai/station-contracts/runtime-events';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * A Station event without the fields the adapter stamps on every event. The
 * adapter also adds the running turn's id where a body leaves it out.
 */
export type CopilotEventBody = DistributiveOmit<
  ProviderRuntimeEvent,
  'eventId' | 'provider' | 'threadId' | 'createdAt'
>;

const COPILOT_TOOL_OUTPUT_MAX_CHARS = 64_000;

function boundedText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function toolKindOf(
  data: Extract<SessionEvent, { type: 'tool.execution_start' }>['data'],
): EngineToolKind {
  if (data.shellToolInfo) return 'execute';
  if (data.readOnly) return 'read';
  return 'other';
}

const MCP_STATES: Partial<Record<string, EngineMcpServerState>> = {
  connected: 'ready',
  pending: 'starting',
  failed: 'failed',
  'needs-auth': 'needs-auth',
  disabled: 'disabled',
  stopped: 'disabled',
};

function mcpServerStatus(
  name: string,
  status: string,
  error: string | undefined,
): EngineMcpServerStatus | undefined {
  const state = MCP_STATES[status];
  if (!state) return undefined;
  return {
    name: boundedText(name, ENGINE_MCP_SERVER_NAME_MAX_CHARS),
    state,
    ...(error ? { error: boundedText(error, ENGINE_MCP_ERROR_MAX_CHARS) } : {}),
    scope: 'session',
  };
}

function rerouteTrigger(
  cause: string | undefined,
): 'refusal' | 'availability' | 'other' {
  if (!cause) return 'other';
  if (/refus/i.test(cause)) return 'refusal';
  if (/rate|limit|unavailab|capacity|quota|overload/i.test(cause))
    return 'availability';
  return 'other';
}

interface CopilotTranslatorContext {
  threadId: string;
  /** Station's id for the turn now running, if any. */
  turnId: string | undefined;
}

export class CopilotSdkEventTranslator {
  /** Assistant messages that streamed deltas; their final event adds nothing. */
  private readonly streamedMessages = new Set<string>();
  private readonly openTools = new Map<
    string,
    { toolName: string; toolKind: EngineToolKind }
  >();
  private readonly openChildren = new Map<string, ChildWorkItem>();

  /** Subagents still running (for settling them when their turn ends). */
  openChildIds(): string[] {
    return [...this.openChildren.keys()];
  }

  translate(
    event: SessionEvent,
    context: CopilotTranslatorContext,
  ): CopilotEventBody[] {
    switch (event.type) {
      case 'assistant.message_delta': {
        if (event.agentId || event.data.parentToolCallId) return [];
        this.streamedMessages.add(event.data.messageId);
        return [
          {
            method: 'content.text-delta',
            itemId: event.data.messageId,
            delta: event.data.deltaContent,
          },
        ];
      }
      case 'assistant.message': {
        if (event.agentId || event.data.parentToolCallId) return [];
        // A runtime that does not stream (or a message it chose not to
        // stream) delivers the whole text here, once.
        if (this.streamedMessages.delete(event.data.messageId)) return [];
        if (!event.data.content) return [];
        return [
          {
            method: 'content.text-delta',
            itemId: event.data.messageId,
            delta: event.data.content,
          },
        ];
      }
      case 'assistant.reasoning_delta': {
        if (event.agentId) return [];
        return [
          {
            method: 'content.reasoning-delta',
            itemId: event.data.reasoningId,
            delta: event.data.deltaContent,
          },
        ];
      }
      case 'tool.execution_start': {
        if (event.agentId || event.data.parentToolCallId) return [];
        const toolKind = toolKindOf(event.data);
        this.openTools.set(event.data.toolCallId, {
          toolName: event.data.toolName,
          toolKind,
        });
        return [
          {
            method: 'tool.started',
            itemId: event.data.toolCallId,
            toolCallId: event.data.toolCallId,
            toolName: event.data.toolName,
            toolKind,
            ...(event.data.arguments !== undefined
              ? { arguments: event.data.arguments }
              : {}),
          },
        ];
      }
      case 'tool.execution_complete': {
        const open = this.openTools.get(event.data.toolCallId);
        if (!open) return [];
        this.openTools.delete(event.data.toolCallId);
        const output = event.data.result?.content;
        return [
          {
            method: 'tool.completed',
            itemId: event.data.toolCallId,
            toolCallId: event.data.toolCallId,
            toolName: open.toolName,
            toolKind: open.toolKind,
            status: event.data.success ? 'success' : 'error',
            ...(output !== undefined
              ? { output: boundedText(output, COPILOT_TOOL_OUTPUT_MAX_CHARS) }
              : {}),
            ...(!event.data.success && event.data.error
              ? { error: event.data.error.message }
              : {}),
          },
        ];
      }
      case 'assistant.usage': {
        // One event per model call, a subagent's calls included, never a
        // running total: the fold sums them into the parent turn
        // (`PROVIDER_USAGE_SCOPE` 'per-turn').
        const input = event.data.inputTokens;
        const output = event.data.outputTokens;
        return [
          {
            method: 'token-usage.updated',
            ...(input !== undefined ? { promptTokens: input } : {}),
            ...(output !== undefined ? { completionTokens: output } : {}),
            ...(input !== undefined || output !== undefined
              ? { totalTokens: (input ?? 0) + (output ?? 0) }
              : {}),
            ...(event.data.cacheReadTokens !== undefined
              ? { cacheReadTokens: event.data.cacheReadTokens }
              : {}),
            ...(event.data.cacheWriteTokens !== undefined
              ? { cacheWriteTokens: event.data.cacheWriteTokens }
              : {}),
            ...(event.data.reasoningTokens !== undefined
              ? { reasoningTokens: event.data.reasoningTokens }
              : {}),
          },
        ];
      }
      case 'subagent.started': {
        const item: ChildWorkItem = {
          producer: 'engine-subagent',
          reporterThreadId: context.threadId,
          childId: event.data.toolCallId,
          status: 'running',
          workKind: 'agent',
          title: event.data.agentDescription || event.data.agentDisplayName,
          kindLabel: event.data.agentDisplayName,
          parent: {
            threadId: context.threadId,
            ...(context.turnId ? { turnId: context.turnId } : {}),
            toolCallId: event.data.toolCallId,
          },
          depth: 1,
          startedAt: event.timestamp,
        };
        this.openChildren.set(item.childId, item);
        return [
          { method: 'child-work.updated', delta: { kind: 'upsert', item } },
        ];
      }
      case 'subagent.completed':
      case 'subagent.failed': {
        const childId = event.data.toolCallId;
        if (!this.openChildren.delete(childId)) return [];
        const failed = event.type === 'subagent.failed';
        const cancelled =
          event.type === 'subagent.completed' && event.data.cancelled === true;
        return [
          {
            method: 'child-work.updated',
            delta: {
              kind: 'settle',
              producer: 'engine-subagent',
              reporterThreadId: context.threadId,
              childId,
              status: failed ? 'failed' : cancelled ? 'cancelled' : 'completed',
              ...(event.type === 'subagent.failed'
                ? {
                    result: {
                      summary: boundedText(event.data.error, 2_000),
                      source: 'provider-error' as const,
                    },
                  }
                : {}),
              usage: {
                ...(event.data.totalTokens !== undefined
                  ? { totalTokens: event.data.totalTokens }
                  : {}),
                ...(event.data.totalToolCalls !== undefined
                  ? { toolUses: event.data.totalToolCalls }
                  : {}),
                ...(event.data.durationMs !== undefined
                  ? { durationMs: event.data.durationMs }
                  : {}),
              },
            },
          },
        ];
      }
      case 'session.model_change': {
        if (event.data.source !== 'automatic' || !event.data.previousModel)
          return [];
        return [
          {
            method: 'model.rerouted',
            fromModel: event.data.previousModel,
            toModel: event.data.newModel,
            trigger: rerouteTrigger(event.data.cause),
            scope: 'session',
          },
        ];
      }
      case 'session.mcp_servers_loaded': {
        const servers = event.data.servers
          .map((server) =>
            mcpServerStatus(server.name, server.status, server.error),
          )
          .filter((server): server is EngineMcpServerStatus => !!server)
          .slice(0, ENGINE_MCP_STATUS_MAX_SERVERS);
        return [
          {
            method: 'engine-mcp.status',
            servers,
            complete: true,
            reconnect: true,
          },
        ];
      }
      case 'session.mcp_server_status_changed': {
        const server = mcpServerStatus(
          event.data.serverName,
          event.data.status,
          event.data.error,
        );
        if (!server) return [];
        return [
          {
            method: 'engine-mcp.status',
            servers: [server],
            complete: false,
            reconnect: true,
          },
        ];
      }
      default:
        return [];
    }
  }

  /**
   * Settles every subagent still open when its turn ends without the
   * runtime reporting an outcome for it.
   */
  settleOpenChildren(threadId: string): CopilotEventBody[] {
    const bodies: CopilotEventBody[] = [];
    for (const childId of this.openChildren.keys()) {
      bodies.push({
        method: 'child-work.updated',
        delta: {
          kind: 'settle',
          producer: 'engine-subagent',
          reporterThreadId: threadId,
          childId,
          status: 'unresolved',
        },
      });
    }
    this.openChildren.clear();
    this.openTools.clear();
    this.streamedMessages.clear();
    return bodies;
  }
}
