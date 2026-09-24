import crypto from 'node:crypto';
import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import type { ProviderSessionSourceAffinity } from '@kontourai/station-contracts/provider';
import type {
  RequestOpenedEvent,
  RequestResolvedEvent,
} from '@kontourai/station-contracts/runtime-events';
import type { ProviderSession } from '../adapter-shape.js';
import {
  addHostImageFile,
  ModelImageCollector,
  type ModelImageOutcome,
  sniffImageMimeType,
} from '../model-image-attachments.js';
import { isSessionSourceAffinity } from '../sessions/session-source-affinity.js';

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

/** Extracts a non-negative finite token figure from an unknown value. */
export function extractTokenFigure(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function isResumeCursor(value: unknown): value is {
  codexThreadId: string;
  sourceAffinity?: ProviderSessionSourceAffinity;
} {
  return (
    isRecord(value) &&
    typeof value.codexThreadId === 'string' &&
    value.codexThreadId.length > 0 &&
    Buffer.byteLength(value.codexThreadId) <= 512 &&
    (value.sourceAffinity === undefined ||
      isSessionSourceAffinity(value.sourceAffinity))
  );
}

export function codexResumeCursor(
  codexThreadId: string,
  previous: unknown,
  turnId?: string,
): {
  codexThreadId: string;
  turnId?: string;
  sourceAffinity?: ProviderSessionSourceAffinity;
} {
  const prior = isResumeCursor(previous) ? previous : undefined;
  return {
    codexThreadId,
    ...(turnId ? { turnId } : {}),
    ...(prior?.sourceAffinity
      ? { sourceAffinity: { ...prior.sourceAffinity } }
      : {}),
  };
}

export interface CodexForkedThread {
  id: string;
  forkedFromId: string;
  threadSource: string;
  turns: unknown[];
}

export function extractForkedThread(result: unknown): CodexForkedThread {
  if (!isRecord(result) || !isRecord(result.thread)) {
    throw new Error('Codex fork response did not include a thread.');
  }
  const thread = result.thread;
  if (
    typeof thread.id !== 'string' ||
    typeof thread.forkedFromId !== 'string' ||
    typeof thread.threadSource !== 'string' ||
    !Array.isArray(thread.turns)
  ) {
    throw new Error('Codex fork response did not include child lineage.');
  }
  return {
    id: thread.id,
    forkedFromId: thread.forkedFromId,
    threadSource: thread.threadSource,
    turns: thread.turns,
  };
}

export function endsAtCompletedCodexTurn(
  turns: readonly unknown[],
  turnId: string,
): boolean {
  const finalTurn = turns.at(-1);
  return (
    isRecord(finalTurn) &&
    finalTurn.id === turnId &&
    finalTurn.status === 'completed'
  );
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

/**
 * Tool-level session-grant identity for an inbound Codex approval request.
 * Mirrors `deriveToolName`'s vocabulary (`shell_exec`/`apply_patch`) so a
 * Station-side `acceptForSession` grant covers the whole tool, not the one
 * call the engine asked about: Codex's `commandExecution`/`fileChange`
 * wire responses carry no session scope, and `mcpServer/elicitation/request`
 * degrades `acceptForSession` to a one-call `accept`. Returns null for
 * methods with no stable tool identity (nothing is granted or remembered).
 */
export function deriveApprovalToolName(
  method: string,
  payload: Record<string, unknown>,
): string | null {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return 'shell_exec';
    case 'item/fileChange/requestApproval':
      return 'apply_patch';
    case 'item/permissions/requestApproval':
      return 'permissions';
    case 'mcpServer/elicitation/request': {
      const serverName = extractString(payload.serverName) ?? 'server';
      return `mcp/${serverName}`;
    }
    default:
      return null;
  }
}

/**
 * The wire result Station may send WITHOUT prompting when a tool-level
 * session grant covers this approval request, or null when no truthful
 * auto-acceptance exists. A data-collecting MCP elicitation needs
 * user-supplied content this approval surface does not collect, so it must
 * re-prompt rather than accept with `undefined` (same reason
 * `resolveApprovalOutcome` declines it on the wire).
 */
export function resolveSessionGrantAutoApproval(
  method: string,
  payload: Record<string, unknown>,
): unknown | null {
  const outcome = resolveApprovalOutcome(method, payload, 'accept');
  if (
    method === 'mcpServer/elicitation/request' &&
    (!isRecord(outcome.result) || outcome.result.action !== 'accept')
  ) {
    return null;
  }
  return outcome.result;
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
    // Codex's own vocabulary for these tools (`view_image`, `image_gen`
    // → image generation). Both put an image in front of the model; surfacing
    // them as tool rows is what gives that image somewhere to appear.
    case 'imageView':
      return 'view_image';
    case 'imageGeneration':
      return 'image_generation';
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
    case 'imageView':
      return { path: extractString(item.path) };
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

/**
 * A generated image's bytes. Codex reports them as base64 (`result`), with no
 * type beside them, so the type is read from the decoded bytes themselves; a
 * data URL is accepted as well. With no inline bytes, the file Codex saved is
 * read instead.
 */
function addGeneratedImage(
  collector: ModelImageCollector,
  item: Record<string, unknown>,
): ModelImageOutcome {
  const result = extractString(item.result);
  if (result?.startsWith('data:')) return collector.addDataUrl(result);
  if (result) {
    const head = Buffer.from(result.slice(0, 16), 'base64');
    const mimeType = sniffImageMimeType(head);
    if (!mimeType) {
      return {
        kind: 'omitted',
        marker:
          '[image not shown: the generated image is not a supported image type]',
      };
    }
    return collector.addBase64(mimeType, result);
  }
  if (extractString(item.savedPath))
    return addHostImageFile(collector, item.savedPath);
  return {
    kind: 'omitted',
    marker: '[image not shown: no image was returned]',
  };
}

/**
 * The tool's output with every image lifted out as an attachment.
 *
 * Image bytes never stay in `output`: that field is bounded to a text tail
 * (`projectBoundedToolOutput`), which would have kept a meaningless slice of
 * base64 — and before this, `imageView` and image generation were not
 * surfaced at all. Each image is replaced in place by a short marker naming
 * the attachment it became, or saying why it was not kept.
 */
export function deriveToolOutputAndImages(item: Record<string, unknown>): {
  output: unknown;
  attachments?: ChatAttachmentInput[];
} {
  const collector = new ModelImageCollector();
  switch (item.type) {
    case 'imageView': {
      const outcome = addHostImageFile(collector, item.path);
      return { output: outcome.marker, attachments: collector.result() };
    }
    case 'imageGeneration': {
      const outcome = addGeneratedImage(collector, item);
      const revisedPrompt = extractString(item.revisedPrompt);
      return {
        output: [revisedPrompt, outcome.marker].filter(Boolean).join('\n'),
        attachments: collector.result(),
      };
    }
    case 'mcpToolCall': {
      const result = item.result;
      if (!isRecord(result) || !Array.isArray(result.content)) {
        return { output: deriveToolOutput(item) };
      }
      const content = result.content.map((block) =>
        isRecord(block) && block.type === 'image'
          ? {
              type: 'text',
              text: collector.addBase64(block.mimeType, block.data).marker,
            }
          : block,
      );
      return {
        output: { ...result, content },
        attachments: collector.result(),
      };
    }
    case 'dynamicToolCall': {
      if (!Array.isArray(item.contentItems)) {
        return { output: deriveToolOutput(item) };
      }
      const contentItems = item.contentItems.map((entry) =>
        isRecord(entry) && entry.type === 'inputImage'
          ? {
              type: 'inputText',
              text: collector.addDataUrl(entry.imageUrl).marker,
            }
          : entry,
      );
      return { output: contentItems, attachments: collector.result() };
    }
    default:
      return { output: deriveToolOutput(item) };
  }
}

export function extractToolStatus(item: Record<string, unknown>): unknown {
  // An `imageView` item carries no status: it is reported once the image is
  // in front of the model, which is its success.
  if (item.type === 'imageView') return 'completed';
  if (item.type === 'imageGeneration') {
    if (item.failure != null) return 'failed';
    return item.status === 'completed' || extractString(item.result)
      ? 'completed'
      : item.status;
  }
  return item.status;
}

export function extractToolError(
  item: Record<string, unknown>,
): string | undefined {
  if (item.type === 'mcpToolCall' && isRecord(item.error)) {
    return extractString(item.error.message) ?? undefined;
  }
  if (item.type === 'imageGeneration' && isRecord(item.failure)) {
    return item.failure.type === 'usageLimitExceeded'
      ? 'Image generation usage limit reached.'
      : 'Image generation failed.';
  }
  return undefined;
}
