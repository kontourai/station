import crypto from 'node:crypto';
import type {
  RequestOpenedEvent,
  RequestResolvedEvent,
} from '@kontourai/station-contracts/runtime-events';
import type { ProviderSession } from '../adapter-shape.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function hasMethod(
  value: unknown,
): value is { method: string; params?: unknown } {
  return isRecord(value) && typeof value.method === 'string';
}

export function hasId(value: unknown): value is { id: string | number } {
  return (
    isRecord(value) &&
    (typeof value.id === 'string' || typeof value.id === 'number')
  );
}

export function extractThreadId(params: unknown): string | undefined {
  if (!isRecord(params) || typeof params.threadId !== 'string') {
    return undefined;
  }
  return params.threadId;
}

export function extractString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function extractStringField(
  value: unknown,
  field: string,
): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return extractString(value[field]);
}

export function extractNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

export function isResumeCursor(
  value: unknown,
): value is { codexThreadId: string } {
  return isRecord(value) && typeof value.codexThreadId === 'string';
}

export function extractThread(result: unknown): { id: string } {
  if (
    !isRecord(result) ||
    !isRecord(result.thread) ||
    typeof result.thread.id !== 'string'
  ) {
    throw new Error('Codex thread response did not include a thread id');
  }
  return { id: result.thread.id };
}

export function extractTurn(result: unknown): { id: string } {
  if (
    !isRecord(result) ||
    !isRecord(result.turn) ||
    typeof result.turn.id !== 'string'
  ) {
    throw new Error('Codex turn response did not include a turn id');
  }
  return { id: result.turn.id };
}

export function mapSessionStatus(
  state: 'idle' | 'running' | 'errored',
): ProviderSession['status'] {
  if (state === 'running') {
    return 'running';
  }
  if (state === 'errored') {
    return 'error';
  }
  return 'ready';
}

export function mapThreadStatusToState(
  status: unknown,
): 'idle' | 'running' | 'errored' {
  if (!isRecord(status) || typeof status.type !== 'string') {
    return 'idle';
  }
  if (status.type === 'active') {
    return 'running';
  }
  if (status.type === 'systemError') {
    return 'errored';
  }
  return 'idle';
}

export function mapTurnFinishReason(
  status: unknown,
): 'stop' | 'cancelled' | 'other' {
  if (status === 'completed') {
    return 'stop';
  }
  if (status === 'interrupted') {
    return 'cancelled';
  }
  return 'other';
}

export function mapToolCompletionStatus(
  status: unknown,
): 'success' | 'error' | 'cancelled' {
  if (status === 'completed') {
    return 'success';
  }
  if (status === 'declined') {
    return 'cancelled';
  }
  return 'error';
}

export function mapServerRequestToEvent(
  threadId: string,
  requestId: string,
  method: string,
  params: unknown,
  createdAt: string,
): RequestOpenedEvent | null {
  const payload = isRecord(params) ? params : {};
  switch (method) {
    case 'item/permissions/requestApproval':
      return {
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId,
        createdAt,
        requestId,
        method: 'request.opened',
        requestType: 'permission',
        title: 'Approve permissions',
        description:
          extractString(payload.reason) ??
          'Codex requested additional permissions.',
        payload,
      };
    case 'item/commandExecution/requestApproval':
      return {
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId,
        createdAt,
        requestId,
        method: 'request.opened',
        requestType: 'approval',
        title: extractString(payload.command) ?? 'Approve command execution',
        description: extractString(payload.reason) ?? undefined,
        payload,
      };
    case 'item/fileChange/requestApproval':
      return {
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId,
        createdAt,
        requestId,
        method: 'request.opened',
        requestType: 'approval',
        title: 'Approve file changes',
        description: extractString(payload.reason) ?? undefined,
        payload,
      };
    // archive#1195: the app-server's OWN "may I invoke this MCP tool" gate
    // (and, more generally, any MCP `elicitation/create` request a
    // connected server issues) rides this SAME method regardless of which
    // MCP server or tool triggered it — `_meta.codex_approval_kind ===
    // 'mcp_tool_call'` names the common case (an empty-schema gate before
    // the FIRST call to a newly-connected server in a thread), tagged with
    // `tool_title`/`tool_description`. Before archive#1195, Codex had NO
    // toolServers delivery at all, so this method was never reachable —
    // wiring toolServers delivery (this ticket) makes it reachable for the
    // very first time, and an unhandled server request gets an immediate
    // error response (codex-adapter-transport.ts's `sendErrorResponse`),
    // which would silently fail EVERY MCP tool call including
    // station-control's. Mapped to the same 'approval' vocabulary as the
    // command/file-change gates above — one inbox surface, no new UI.
    case 'mcpServer/elicitation/request': {
      const meta = isRecord(payload._meta) ? payload._meta : {};
      const toolTitle = extractString(meta.tool_title);
      const serverName = extractString(payload.serverName) ?? 'an MCP server';
      return {
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId,
        createdAt,
        requestId,
        method: 'request.opened',
        requestType: 'approval',
        title: toolTitle
          ? `Allow ${serverName} to run "${toolTitle}"`
          : `Allow ${serverName} MCP request`,
        description: extractString(payload.message) ?? undefined,
        payload,
      };
    }
    default:
      return null;
  }
}

export function buildApprovalResult(
  method: string,
  payload: Record<string, unknown>,
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
): unknown {
  return resolveApprovalOutcome(method, payload, decision).result;
}

export function resolveApprovalOutcome(
  method: string,
  payload: Record<string, unknown>,
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
): {
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
  result: unknown;
} {
  switch (method) {
    case 'item/permissions/requestApproval':
      return {
        decision,
        result: {
          permissions: payload.permissions ?? {},
          scope: decision === 'acceptForSession' ? 'session' : 'turn',
        },
      };
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision, result: { decision } };
    // archive#1195: the app-server's `McpServerElicitationRequestResponse`
    // shape is `{action: 'accept'|'decline'|'cancel', content?}` — distinct
    // vocabulary from the `decision`-keyed shapes above. `acceptForSession`
    // has no wire equivalent (codex has no "remember for this thread"
    // response field), so it degrades to 'accept' for THIS call only — the
    // next tool call on the same server re-prompts, a friction regression
    // from zero (Codex had no toolServers delivery at all before this
    // ticket), not a broken one. `content` is intentionally omitted. The
    // only content-free acceptance that Station can truthfully make is
    // Codex's empty-object tool-call gate. A data-collecting elicitation
    // needs user-supplied content, which this approval surface does not
    // collect, so it must be declined rather than accepted with `undefined`.
    case 'mcpServer/elicitation/request':
      if (
        (decision === 'accept' || decision === 'acceptForSession') &&
        !isEmptyElicitationSchema(payload.requestedSchema)
      ) {
        return { decision: 'decline', result: { action: 'decline' } };
      }
      return {
        decision,
        result: {
          action:
            decision === 'accept' || decision === 'acceptForSession'
              ? 'accept'
              : decision === 'decline'
                ? 'decline'
                : 'cancel',
        },
      };
    default:
      throw new Error(`Unsupported Codex approval request method: ${method}`);
  }
}

function isEmptyElicitationSchema(schema: unknown): boolean {
  if (!isRecord(schema) || schema.type !== 'object') return false;
  if (!isRecord(schema.properties) || Object.keys(schema.properties).length) {
    return false;
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.length)
  ) {
    return false;
  }
  return schema.minProperties === undefined || schema.minProperties === 0;
}

export function mapApprovalResolutionStatus(
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
): RequestResolvedEvent['status'] {
  if (decision === 'accept' || decision === 'acceptForSession') {
    return 'approved';
  }
  if (decision === 'decline') {
    return 'denied';
  }
  return 'cancelled';
}

export function deriveToolName(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case 'commandExecution':
      return 'shell_exec';
    case 'mcpToolCall':
      return `${extractString(item.server) ?? 'mcp'}/${extractString(item.tool) ?? 'tool'}`;
    case 'dynamicToolCall':
      return extractString(item.tool) ?? 'dynamic_tool';
    case 'fileChange':
      return 'apply_patch';
    default:
      return null;
  }
}

export function deriveToolArguments(item: Record<string, unknown>): unknown {
  switch (item.type) {
    case 'commandExecution':
      return {
        command: extractString(item.command),
        cwd: extractString(item.cwd),
      };
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return item.arguments;
    case 'fileChange':
      return {
        changes: item.changes,
      };
    default:
      return undefined;
  }
}

export function deriveToolOutput(item: Record<string, unknown>): unknown {
  switch (item.type) {
    case 'commandExecution':
      return {
        output: item.aggregatedOutput,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
      };
    case 'mcpToolCall':
      return item.result;
    case 'dynamicToolCall':
      return item.contentItems;
    case 'fileChange':
      return item.changes;
    default:
      return undefined;
  }
}

export function extractToolStatus(item: Record<string, unknown>): unknown {
  return item.status;
}

export function extractToolError(
  item: Record<string, unknown>,
): string | undefined {
  if (item.type === 'mcpToolCall' && isRecord(item.error)) {
    return extractString(item.error.message) ?? undefined;
  }
  return undefined;
}
