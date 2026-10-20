import crypto from 'node:crypto';
import { domainToASCII } from 'node:url';
import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import { sniffChatImageMimeType } from '@kontourai/station-contracts/chat-attachment';
import type { ProviderSessionSourceAffinity } from '@kontourai/station-contracts/provider';
import type {
  RequestOpenedEvent,
  RequestResolvedEvent,
} from '@kontourai/station-contracts/runtime-events';
import {
  boundedJoinedLines,
  displayLines,
  displayText as sharedDisplayText,
} from '@kontourai/station-shared/display-text';
import type { ProviderSession } from '../adapter-shape.js';
import {
  addWorkspaceImageFile,
  HOST_IMAGE_READ_TIMEOUT_MARKER,
  type HostImageReadScope,
  ModelImageCollector,
  type ModelImageOutcome,
} from '../model-image-attachments.js';
import { isSessionSourceAffinity } from '../sessions/session-source-affinity.js';
import { codexInputRequest } from './harness-questions.js';

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
    case 'item/tool/requestUserInput': {
      const inputRequest = codexInputRequest(payload);
      if (!inputRequest) return null;
      return {
        eventId: crypto.randomUUID(),
        provider: 'codex',
        threadId,
        createdAt,
        requestId,
        method: 'request.opened',
        requestType: 'approval',
        ...(payload.isBlocking === false ? { blocking: false } : {}),
        title: inputRequest.message,
        payload: { ...payload, inputRequest },
      };
    }
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
        // #2911: every approval surface renders the title (strip card name,
        // toast, inbox row, a delegating agent's snapshot), so it names what
        // is being allowed: the host for a managed-network prompt, input to a
        // running process for a stdin write, otherwise the command.
        title: commandApprovalTitle(payload),
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
    // #2909: `PermissionsRequestApprovalResponse` is `{permissions, scope}`
    // with no decision field, so the granted profile IS the answer. A denial
    // grants the empty profile (every `GrantedPermissionProfile` field is
    // optional). Its scope is `turn`, matching Codex's own denial (the
    // default, empty profile with scope Turn): an empty grant has nothing to
    // remember for the session.
    case 'item/tool/requestUserInput':
      if (decision === 'accept' || decision === 'acceptForSession')
        throw new Error('Question answers are required.');
      return { decision, result: { answers: {} } };
    case 'item/permissions/requestApproval': {
      const granted = decision === 'accept' || decision === 'acceptForSession';
      return {
        decision,
        result: {
          permissions: granted ? (payload.permissions ?? {}) : {},
          scope: decision === 'acceptForSession' ? 'session' : 'turn',
        },
      };
    }
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

/**
 * Every `commandExecution` title fits in this many code points, so no
 * downstream cut (the delegation snapshot keeps 200) can remove the part that
 * matters: a host's registrable domain or a command's tail.
 */
const MAX_COMMAND_APPROVAL_TITLE_LENGTH = 200;
/**
 * Room for the host in a network title. A longer host keeps its END, where
 * the registrable domain is (`…aaaa.evil.example`), behind a leading "…".
 */
const MAX_TITLE_HOST_LENGTH = 120;
const MAX_TITLE_PROTOCOL_LENGTH = 16;
const ELLIPSIS = '\u2026';

/**
 * The title of a `commandExecution` approval. A noun phrase, because each
 * surface wraps it in its own sentence ("Use …" on the card, "… wants to use
 * …" on the toast). The title is also the only text a delegating agent's
 * snapshot carries.
 *
 * - Network prompt (any non-null `networkApprovalContext`): "network access
 *   to <host> (<protocol>) for: <command>", or "network access to an unnamed
 *   host" when no host survives. Never the plain command title: the prompt
 *   is about the network.
 * - Stdin write: "input to a running command[: <command>]". Codex's stdin
 *   approvals refer to the existing parent command, so the bare command
 *   would read as approval to START it.
 * - Otherwise the command.
 *
 * Host, protocol and command are engine-supplied text: each is made one
 * line and stripped of control and format characters (bidi overrides and
 * isolates, zero-width characters). The whole title is bounded; a cut
 * command ends in "…". Only the title is rewritten: the payload keeps the
 * raw command.
 */
function commandApprovalTitle(payload: Record<string, unknown>): string {
  const command = commandLines(payload.command);
  if (payload.networkApprovalContext != null) {
    const context = isRecord(payload.networkApprovalContext)
      ? payload.networkApprovalContext
      : {};
    const target = `network access to ${hostLabel(displayText(context.host))}${protocolLabel(displayText(context.protocol))}`;
    return withCommand(target, ' for: ', command);
  }
  if (payload.kind === 'writeStdin') {
    return withCommand('input to a running command', ': ', command);
  }
  return command
    ? boundedJoinedLines(command, MAX_COMMAND_APPROVAL_TITLE_LENGTH)
    : 'Approve command execution';
}

/**
 * #3382: a command's lines, each made one visible line. Every surface shows
 * this title, so a multi-line command must not collapse into one: joined by a
 * space, `echo a` then `rm -rf /` read as `echo a rm -rf /`, with no sign a
 * second command runs. The title joins them with " ⏎ " and says how many a
 * cut hides (`boundedJoinedLines`), as the approval preview does.
 */
function commandLines(value: unknown): string[] | undefined {
  const text = extractString(value);
  if (!text) return undefined;
  const lines = displayLines(text).map(sharedDisplayText).filter(Boolean);
  return lines.length > 0 ? lines : undefined;
}

/**
 * The hosts shown bare, all ASCII: dot-separated labels of letters, digits,
 * hyphen and underscore with an optional trailing dot (which covers IPv4 and
 * punycode), or a bracketed IPv6 address whose zone is ASCII. No character
 * in them can pass for the title's own separators (spaces, brackets, colons,
 * quotes) or be invisible.
 */
const BARE_HOST_SYNTAX =
  /^(?:\[[0-9A-Fa-f:.]+(?:%[A-Za-z0-9_.-]+)?\]|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?)$/;
const PROTOCOL_SYNTAX = /^[A-Za-z0-9]+$/;
/**
 * A Unicode host name as `domainToASCII` is given it: labels of letters,
 * marks, digits, hyphen and underscore, separated by `.` or an IDNA dot
 * (`。．｡`), with an optional trailing dot, and nothing else. Node's
 * `domainToASCII` parses like a URL hostname setter and silently stops at a
 * URL delimiter (`/ ? # \\ @ :`), so it must never see one.
 */
const UNICODE_HOST_SYNTAX =
  /^[\p{L}\p{M}\p{N}_-]+(?:[.\u3002\uFF0E\uFF61][\p{L}\p{M}\p{N}_-]+)*[.\u3002\uFF0E\uFF61]?$/u;
/** Printable ASCII outside a host label's `[A-Za-z0-9_.-]`. */
const ASCII_NON_LABEL = /[ -,/:-@[-^`{-~]/;
/**
 * Code points kept of an unrecognised host before escaping, "…" included.
 * Escaping at most doubles each kept code point, so the quoted text is at
 * most 1 + 49 × 2 = 99 code points, and even beside an unrecognised
 * protocol the command keeps 30 of the title's 200.
 */
const MAX_QUOTED_HOST_RAW_LENGTH = 50;
/**
 * Quote marks and their lookalikes, each escaped with a backslash in a
 * quoted host (as a double or single quote) so none can pass for the
 * closing delimiter.
 */
const DOUBLE_QUOTE_LIKE =
  '"\u201C\u201D\u201E\u201F\u2033\u2036\uFF02\u05F4\u02BA\u02DD\u02EE\u3003\u301D\u301E\u301F';
const SINGLE_QUOTE_LIKE =
  '\u2018\u2019\u201A\u201B\u2032\u2035\uFF07\u02B9\u02BB\u02BC\u02BD';
const QUOTED_HOST_ESCAPES = new RegExp(
  `[\\\\${DOUBLE_QUOTE_LIKE}${SINGLE_QUOTE_LIKE}]`,
  'gu',
);

function escapeQuotedHostChar(char: string): string {
  if (char === '\\') return '\\\\';
  return DOUBLE_QUOTE_LIKE.includes(char) ? '\\"' : "\\'";
}

/**
 * The host as the title shows it.
 * - An ASCII host matching `BARE_HOST_SYNTAX` is shown bare, cut from the
 *   left so its registrable domain stays.
 * - A host in `UNICODE_HOST_SYNTAX` (with no ASCII outside label characters)
 *   is shown as `domainToASCII` gives it (punycode, with invisible code
 *   points mapped away) when that result is itself a bare host.
 * - Anything else is quoted as "an unrecognised host": cut from the left
 *   FIRST, then backslashes, quotes and quote lookalikes escaped in one
 *   pass, so no cut can split an escape and nothing inside can pass for the
 *   closing quote.
 */
function hostLabel(host: string | undefined): string {
  if (!host) return 'an unnamed host';
  if (BARE_HOST_SYNTAX.test(host)) return keepEnd(host, MAX_TITLE_HOST_LENGTH);
  if (UNICODE_HOST_SYNTAX.test(host) && !ASCII_NON_LABEL.test(host)) {
    const ascii = domainToASCII(host);
    if (ascii && BARE_HOST_SYNTAX.test(ascii))
      return keepEnd(ascii, MAX_TITLE_HOST_LENGTH);
  }
  const escaped = keepEnd(host, MAX_QUOTED_HOST_RAW_LENGTH).replace(
    QUOTED_HOST_ESCAPES,
    escapeQuotedHostChar,
  );
  return `an unrecognised host "${escaped}"`;
}

function protocolLabel(protocol: string | undefined): string {
  if (!protocol) return '';
  return PROTOCOL_SYNTAX.test(protocol)
    ? ` (${keepStart(protocol, MAX_TITLE_PROTOCOL_LENGTH)})`
    : ' (unrecognised protocol)';
}

/** `lead` + `separator` + as much of `command` as fits the title bound. */
function withCommand(
  lead: string,
  separator: string,
  command: readonly string[] | undefined,
): string {
  if (!command) return lead;
  const room =
    MAX_COMMAND_APPROVAL_TITLE_LENGTH - codePoints(lead + separator).length;
  return `${lead}${separator}${boundedJoinedLines(command, room)}`;
}

function codePoints(text: string): string[] {
  return Array.from(text);
}

/** At most `max` code points, keeping the start; a cut ends in "…". */
function keepStart(text: string, max: number): string {
  const points = codePoints(text);
  if (points.length <= max) return text;
  const kept = points
    .slice(0, Math.max(0, max - 1))
    .join('')
    .trimEnd();
  return `${kept}${ELLIPSIS}`;
}

/** At most `max` code points, keeping the end; a cut starts with "…". */
function keepEnd(text: string, max: number): string {
  const points = codePoints(text);
  if (points.length <= max) return text;
  const kept = points
    .slice(points.length - (max - 1))
    .join('')
    .trimStart();
  return `${ELLIPSIS}${kept}`;
}

/** Engine-supplied text made one visible line, unbounded (callers bound). */
function displayText(value: unknown): string | undefined {
  const text = extractString(value);
  // The display form every approval surface uses (#3382): a C1 control
  // reads as a space, as in the preview, and an emoji keeps its ZWJ.
  return text ? sharedDisplayText(text) || undefined : undefined;
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
 * call the engine asked about. `resolveApprovalOutcome` passes the user's
 * decision to Codex unchanged for `commandExecution`/`fileChange`
 * (`acceptForSession` included); this grant is Station's own, and only it
 * lets a later, different call through without a prompt.
 * `mcpServer/elicitation/request` degrades `acceptForSession` to a one-call
 * `accept` on the wire. Returns null for
 * methods with no stable tool identity (nothing is granted or remembered).
 */
export function deriveApprovalToolName(
  method: string,
  payload: Record<string, unknown>,
): string | null {
  switch (method) {
    // #2911: a request that asks for more than "run this command" never
    // matches or mints a tool grant, so it always prompts. The user's own
    // decision still reaches Codex unchanged (`acceptForSession` included),
    // so whatever Codex remembers for the session is Codex's call.
    // - `networkApprovalContext` asks to reach a host through the managed
    //   network proxy; a `shell_exec` grant would cover every host.
    // - `kind: 'writeStdin'` writes to an already-running process (a shell,
    //   a REPL, a sudo prompt): a grant would allow any later input to any
    //   process, and the request carries neither the input nor the process,
    //   so it can be neither shown nor narrowed.
    // - Only a kind Station knows as "start a command" (absent on older
    //   servers, or `command`) is `shell_exec`; an unknown kind fails closed.
    // - `grantRoot` asks to allow writes under a root "for the remainder of
    //   the session" (codex app-server types). An auto-accept under an
    //   `apply_patch` grant would answer it without the user seeing it.
    case 'item/commandExecution/requestApproval':
      if (payload.networkApprovalContext != null) return null;
      return payload.kind === undefined || payload.kind === 'command'
        ? 'shell_exec'
        : null;
    case 'item/fileChange/requestApproval':
      return payload.grantRoot != null ? null : 'apply_patch';
    // #2911: a permissions request is an escalation, not a tool. Its
    // `acceptForSession` reply already carries `scope: 'session'`, so Codex
    // remembers that grant itself; a Station-side grant would only matter for
    // a DIFFERENT (possibly broader) request, which must prompt.
    case 'item/permissions/requestApproval':
      return null;
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
 * A generated image's inline bytes. Codex reports them as base64 (`result`)
 * with no type beside them, so the type is read from the decoded bytes; a data
 * URL is accepted as well. `undefined` means there were no inline bytes.
 */
function addGeneratedInlineImage(
  collector: ModelImageCollector,
  item: Record<string, unknown>,
): ModelImageOutcome | undefined {
  const result = extractString(item.result);
  if (!result) return undefined;
  if (result.startsWith('data:')) return collector.addDataUrl(result);
  const mimeType = sniffChatImageMimeType(
    Buffer.from(result.slice(0, 16), 'base64'),
  );
  if (!mimeType) {
    return {
      kind: 'omitted',
      marker:
        '[image not shown: the generated image is not a supported image type]',
    };
  }
  return collector.addBase64(mimeType, result);
}

type ToolOutputAndImages = {
  output: unknown;
  attachments?: ChatAttachmentInput[];
};

/**
 * Whether this item's image must be read from the host filesystem — an
 * `imageView` (a path, never bytes), or a generated image reported only by
 * the file Codex saved. Those reads are asynchronous; every other item maps
 * synchronously through {@link deriveToolOutputAndImages}.
 */
export function needsHostImageRead(item: Record<string, unknown>): boolean {
  return (
    item.type === 'imageView' ||
    (item.type === 'imageGeneration' &&
      !extractString(item.result) &&
      Boolean(extractString(item.savedPath)))
  );
}

/**
 * The host-read half of {@link deriveToolOutputAndImages}, bounded to the
 * session's workspace (`addWorkspaceImageFile`). A refusal is a marker in the
 * output, never the file's contents.
 */
export async function deriveHostToolOutputAndImages(
  item: Record<string, unknown>,
  scope: HostImageReadScope,
): Promise<ToolOutputAndImages> {
  const collector = new ModelImageCollector();
  const path = item.type === 'imageView' ? item.path : item.savedPath;
  const outcome = await addWorkspaceImageFile(collector, path, scope);
  const revisedPrompt =
    item.type === 'imageGeneration'
      ? extractString(item.revisedPrompt)
      : undefined;
  return {
    output: [revisedPrompt, outcome.marker].filter(Boolean).join('\n'),
    attachments: collector.result(),
  };
}

/**
 * The outcome of a host image read that ran out of time — the same output
 * {@link deriveHostToolOutputAndImages} produces when its deadline passes,
 * available synchronously for a caller that cannot wait for it.
 */
export function hostImageReadTimedOut(
  item: Record<string, unknown>,
): ToolOutputAndImages {
  const revisedPrompt =
    item.type === 'imageGeneration'
      ? extractString(item.revisedPrompt)
      : undefined;
  return {
    output: [revisedPrompt, HOST_IMAGE_READ_TIMEOUT_MARKER]
      .filter(Boolean)
      .join('\n'),
  };
}

/**
 * The tool's output with every inline image lifted out as an attachment.
 *
 * Image bytes never stay in `output`: that field is bounded to a text tail
 * (`projectBoundedToolOutput`, which also replaces any data URL or
 * image-shaped payload left elsewhere in the result), which would have kept a
 * meaningless slice of base64 — and before this, image generation was not
 * surfaced at all. Each image is replaced in place by a short marker naming
 * the attachment it became, or saying why it was not kept. Items that need a
 * host read go through {@link deriveHostToolOutputAndImages} instead.
 */
export function deriveToolOutputAndImages(
  item: Record<string, unknown>,
): ToolOutputAndImages {
  const collector = new ModelImageCollector();
  switch (item.type) {
    case 'imageGeneration': {
      const outcome = addGeneratedInlineImage(collector, item) ?? {
        kind: 'omitted',
        marker: '[image not shown: no image was returned]',
      };
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
