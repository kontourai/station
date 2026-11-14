/**
 * Session actions an ACP engine may offer beyond prompting: rewind in place,
 * native fork, and reconnecting one MCP server. Each is a binding
 * keyed on what the live session's `initialize` answer says (ADR 0013), never
 * a static claim about "ACP": the ACP adapter runs many engines, so its
 * adapter-level continuity stays `none` and these are per-session
 * observations ({@link acpSessionContinuity}).
 *
 * Engines name their rewind and fork points two ways. Kiro names a turn by
 * the id it assigned the turn's user message; Grok Build names it by the
 * prompt's index in the conversation, listed by `x.ai/rewind/points` with
 * the time the point was made (`created_at`). Grok 1.0.77 gives every prompt
 * it runs an index, a wake included, and lists points only for prompts a
 * client sent (live: points 0, 1, 2 and 4 after a wake ran as 3). Each
 * binding says which, and the adapter resolves a Station turn to that point.
 */

import {
  type AcpHandshakeIdentity,
  type AcpIdentityHandshake,
  matchesAcpHandshakeIdentity,
} from '../../services/acp/acp-handshake-facts.js';
import type { InitializeResult } from '../../services/acp/acp-process.js';
import { isRecord } from '../../utils/is-record.js';

type Handshake = Pick<
  InitializeResult,
  'agentInfo' | 'agentCapabilities' | '_meta'
>;

function vendorFlag(
  handshake: Handshake | null | undefined,
  namespace: string,
  flag: string,
): boolean {
  const meta = handshake?.agentCapabilities?._meta;
  if (!isRecord(meta)) return false;
  const vendor = meta[namespace];
  return isRecord(vendor) && vendor[flag] === true;
}

function sessionCapability(
  handshake: Handshake | null | undefined,
  name: string,
): Record<string, unknown> | undefined {
  const capabilities: unknown =
    handshake?.agentCapabilities?.sessionCapabilities;
  if (!isRecord(capabilities)) return undefined;
  const value = capabilities[name];
  return isRecord(value) ? value : undefined;
}

/**
 * Rewind in place to before a user message, gated on a declared flag rather
 * than a declared method: Kiro's agent service announces its checkpoint verbs
 * as `_meta.kiro.checkpoints` and does not list them in `extensionMethods`.
 * Answer `{success, affectedFiles, totalFiles}`; refused while a turn runs
 * ("Cannot revert while the agent is still running"). It hides the message
 * and everything after it from the model and restores files write tools
 * changed in that range.
 */
const REWIND_BINDINGS: ReadonlyArray<
  {
    gate:
      | { namespace: string; flag: string }
      | { identity: AcpHandshakeIdentity };
    evidence: string;
  } & AcpRewindTarget
> = [
  {
    gate: { namespace: 'kiro', flag: 'checkpoints' },
    target: 'message-id',
    method: '_kiro/checkpoint/revertMultiple',
    evidence:
      'kiro-cli 3.3.0 `acp --agent-engine v3` live probe (2026-11-13): {sessionId, messageId} -> {success: true, affectedFiles: [], totalFiles: 0}; kirocrew acp/types.py METHOD_KAS_CHECKPOINT_REVERT',
  },
  {
    // Grok Build declares no rewind at `initialize`; its handshake identity
    // is the key. `x.ai/rewind/execute {sessionId, targetPromptIndex, force,
    // mode}` restores the state from before that prompt: `force: false` is a
    // dry run naming the files it would restore and any changed outside the
    // engine since (`conflicts`); `force: true` applies it, overwriting
    // those. Its answer is `{success, reverted_files, conflicts, error}`.
    gate: { identity: { initializeMetaFlag: 'grokShell' } },
    target: 'prompt-index',
    method: '_x.ai/rewind/execute',
    pointsMethod: '_x.ai/rewind/points',
    evidence:
      'grok 1.0.77 live captures (grok-1.0.77-session-frames.jsonl): `rewind-preview-commit` (one point per client prompt, none for a mid-turn interject; each point created_at 10-22 ms after the first queue/changed naming that prompt running, measured on the raw capture, whose relative times the scrubbed fixture does not keep; force:false answered success:false with clean_files and no conflicts; force:true answered success:true reverted_files and removed the file) and `rewind-points-after-wake` (points 0, 1, 2, 4: the wake ran as index 3 with no point). xai-org/grok-build session/acp_session_impl/rewind.rs, helpers/rewind_preview.rs',
  },
];

/**
 * How a session's engine names the point a rewind or fork is taken at:
 * `message-id` (the engine's id for a turn's user message) or
 * `prompt-index` (the prompt's 0-based index, read from `pointsMethod`).
 */
export type AcpRewindTarget =
  | { target: 'message-id'; method: string }
  | { target: 'prompt-index'; method: string; pointsMethod: string };

/**
 * Fork at a user message: core `session/fork` with the fork point in the
 * vendor's `_meta`, declared as `sessionCapabilities.fork._meta.<ns>.messageId`.
 * The fork keeps the named message's whole turn (@kiro/agent 0.66.102
 * `forkSession`; live: answered a new sessionId and its configOptions).
 */
const FORK_AT_MESSAGE_NAMESPACES = ['kiro'] as const;

export type AcpRewindBinding = AcpRewindTarget & { readonly evidence: string };

function gateOpen(
  handshake: Handshake | null | undefined,
  gate:
    | { namespace: string; flag: string }
    | { identity: AcpHandshakeIdentity },
): boolean {
  if ('identity' in gate)
    return !!handshake && matchesAcpHandshakeIdentity(handshake, gate.identity);
  return vendorFlag(handshake, gate.namespace, gate.flag);
}

export function resolveAcpRewind(
  handshake: Handshake | null | undefined,
): AcpRewindBinding | undefined {
  const binding = REWIND_BINDINGS.find(({ gate }) => gateOpen(handshake, gate));
  if (!binding) return undefined;
  const { gate: _gate, ...rest } = binding;
  return rest;
}

/** Bound on one restored path the engine reports; a longer one is dropped. */
const REWIND_PATH_MAX_CHARS = 4096;

/**
 * The engine's answer to a rewind: `{success, affectedFiles?, message?}`
 * (Kiro, live: `{success: true, affectedFiles: [], totalFiles: 0}`) or
 * `{success, reverted_files?, error?}` (Grok, live). The restored files are
 * read only when they are an array: their count is the array's length, and
 * at most `pathsMax` of the string entries are kept. Anything else is not a
 * success.
 */
export function readAcpRewindAnswer(
  result: unknown,
  pathsMax: number,
):
  | { success: true; affectedFiles?: { count: number; paths: string[] } }
  | { success: false; message?: string } {
  if (!isRecord(result) || result.success !== true) {
    const said = isRecord(result)
      ? (result.message ?? result.error)
      : undefined;
    const message =
      typeof said === 'string' && said ? said.slice(0, 1024) : undefined;
    return { success: false, ...(message ? { message } : {}) };
  }
  const restored = result.affectedFiles ?? result.reverted_files;
  if (!Array.isArray(restored)) return { success: true };
  const paths = restored
    .filter(
      (path): path is string =>
        typeof path === 'string' &&
        path.length > 0 &&
        path.length <= REWIND_PATH_MAX_CHARS,
    )
    .slice(0, pathsMax);
  return {
    success: true,
    affectedFiles: { count: restored.length, paths },
  };
}

/** Bound on the rewind points one answer is read for. */
const REWIND_POINTS_MAX = 10_000;
const REWIND_PREVIEW_MAX_CHARS = 1024;

/**
 * `x.ai/rewind/points` as the client prompts the engine lists, in order:
 * `{rewind_points: [{prompt_index, prompt_preview?, created_at?}]}`. The
 * indexes are the engine's own and need not be consecutive (a wake takes one
 * and lists no point), but they must rise; anything else is unreadable
 * (`undefined`). `createdAt` is when the engine made the point, in epoch ms;
 * a point copied into a fork carries none.
 */
export function readAcpRewindPoints(
  result: unknown,
): Array<{ index: number; preview?: string; createdAt?: number }> | undefined {
  if (!isRecord(result) || !Array.isArray(result.rewind_points))
    return undefined;
  const points = result.rewind_points;
  if (points.length > REWIND_POINTS_MAX) return undefined;
  const read: Array<{ index: number; preview?: string; createdAt?: number }> =
    [];
  for (const point of points) {
    if (!isRecord(point)) return undefined;
    const index = point.prompt_index;
    if (
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index <= (read.at(-1)?.index ?? -1)
    )
      return undefined;
    const preview =
      typeof point.prompt_preview === 'string' &&
      point.prompt_preview.length <= REWIND_PREVIEW_MAX_CHARS
        ? point.prompt_preview
        : undefined;
    const createdAt =
      typeof point.created_at === 'string'
        ? Date.parse(point.created_at)
        : Number.NaN;
    read.push({
      index,
      ...(preview ? { preview } : {}),
      ...(Number.isFinite(createdAt) ? { createdAt } : {}),
    });
  }
  return read;
}

/** Grok's rewind-point preview cut: lines longer than this end in `...`. */
const REWIND_PREVIEW_LINE_MAX_CHARS = 60;

/**
 * The preview the engine lists for a prompt of this text: its first
 * non-empty trimmed line, cut to 57 characters plus `...` when longer than
 * 60 (xai-org/grok-build `helpers/rewind_preview.rs`, characters counted as
 * code points). `undefined` for a blank prompt, which lists none. Grok first
 * strips some tag blocks (`extract_user_query`); a prompt that opens with one
 * gets a different preview there, so it never matches here and its rewind is
 * refused, never misdirected.
 */
function acpRewindPreviewOf(promptText: string): string | undefined {
  const line = promptText
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return undefined;
  const chars = Array.from(line);
  return chars.length > REWIND_PREVIEW_LINE_MAX_CHARS
    ? `${chars.slice(0, REWIND_PREVIEW_LINE_MAX_CHARS - 3).join('')}...`
    : line;
}

/**
 * Whether a point's preview is the one the engine would list for a prompt of
 * this text. A point with no preview, or a turn with no text, cannot be
 * checked and does not match. Station puts the same ambient line (the
 * timezone) first in every prompt, so previews alone rarely tell turns
 * apart; the adapter locates a turn's point by its start time and uses this
 * only as a second check.
 */
export function acpRewindPointMatches(
  point: { preview?: string },
  promptText: string | undefined,
): boolean {
  if (!point.preview || !promptText) return false;
  return acpRewindPreviewOf(promptText) === point.preview;
}

/**
 * A rewind dry run's answer: the files changed outside the engine since the
 * point (`conflicts[{path}]`), which applying it would overwrite. An answer
 * without a `conflicts` array is unreadable (`undefined`).
 */
export function readAcpRewindConflicts(result: unknown): string[] | undefined {
  if (!isRecord(result) || !Array.isArray(result.conflicts)) return undefined;
  return result.conflicts
    .map((conflict) => (isRecord(conflict) ? conflict.path : undefined))
    .filter(
      (path): path is string =>
        typeof path === 'string' &&
        path.length > 0 &&
        path.length <= REWIND_PATH_MAX_CHARS,
    );
}

/** The `_meta` namespace the fork point goes under, when native fork-at-message is declared. */
function resolveAcpForkAtMessage(
  handshake: Handshake | null | undefined,
): string | undefined {
  const fork = sessionCapability(handshake, 'fork');
  if (!fork || !isRecord(fork._meta)) return undefined;
  const forkMeta = fork._meta;
  return FORK_AT_MESSAGE_NAMESPACES.find(
    (namespace) =>
      isRecord(forkMeta[namespace]) &&
      (forkMeta[namespace] as Record<string, unknown>).messageId === true,
  );
}

/**
 * Fork at a prompt index: Grok Build's `x.ai/session/fork {sourceSessionId,
 * sourceCwd, newCwd, targetPromptIndex}` copies the conversation through
 * that prompt, inclusive, into a new session it answers as `newSessionId`,
 * which a later `session/load` opens. Not declared at `initialize`, so keyed
 * on the handshake identity.
 */
const FORK_AT_PROMPT_INDEX_ENGINES: ReadonlyArray<{
  identity: AcpHandshakeIdentity;
  method: string;
  evidence: string;
}> = [
  {
    identity: { initializeMetaFlag: 'grokShell' },
    method: '_x.ai/session/fork',
    evidence:
      'grok 1.0.77 live capture (grok-1.0.77-session-frames.jsonl `fork-at-prompt`): a fork at index 0 of a two-prompt session loaded with one rewind point, at index 1 with two. xai-org/grok-build session/storage/jsonl/copy.rs ("the cut keeps the target prompt inclusive")',
  },
];

/** How this session's engine forks after a turn, when it can. */
export type AcpForkBinding =
  | { kind: 'core-meta'; namespace: string }
  | { kind: 'prompt-index'; method: string; pointsMethod: string };

export function resolveAcpFork(
  handshake: Handshake | null | undefined,
): AcpForkBinding | undefined {
  const namespace = resolveAcpForkAtMessage(handshake);
  if (namespace) return { kind: 'core-meta', namespace };
  const engine = handshake
    ? FORK_AT_PROMPT_INDEX_ENGINES.find(({ identity }) =>
        matchesAcpHandshakeIdentity(handshake, identity),
      )
    : undefined;
  // The fork point is read from the same points list a rewind reads.
  const rewind = resolveAcpRewind(handshake);
  if (!engine || rewind?.target !== 'prompt-index') return undefined;
  return {
    kind: 'prompt-index',
    method: engine.method,
    pointsMethod: rewind.pointsMethod,
  };
}

/**
 * This live session's continuity, as its own handshake declares it. Rewind
 * and fork are `none` unless the binding above applies.
 */
export function acpSessionContinuity(handshake: Handshake | null | undefined): {
  fork: 'native' | 'none';
  rewind: 'in-place' | 'none';
} {
  return {
    fork: resolveAcpFork(handshake) ? 'native' : 'none',
    rewind: resolveAcpRewind(handshake) ? 'in-place' : 'none',
  };
}

/**
 * The engine's id for the prompt a turn sent, from a `session_info_update`
 * whose `_meta.kiro.kind` is `user_message_id_assigned` (live, v3 turn
 * captures 2026-11-13). The rewind and fork points are these ids.
 */
export function readAcpUserMessageId(update: unknown): string | undefined {
  if (!isRecord(update) || update.sessionUpdate !== 'session_info_update')
    return undefined;
  const meta = update._meta;
  const kiro = isRecord(meta) ? meta.kiro : undefined;
  if (!isRecord(kiro) || kiro.kind !== 'user_message_id_assigned')
    return undefined;
  const id = kiro.userMessageId;
  return typeof id === 'string' && id.length > 0 && id.length <= 256
    ? id
    : undefined;
}

/**
 * Reconnect one MCP server the engine runs, two ways:
 *
 * - `reset-server`: Kiro's agent service answers `_kiro/mcp/resetServer
 *   {sessionId, serverName, startOAuth}` without listing it in
 *   `extensionMethods`; with `startOAuth: true` it keeps its OAuth callback
 *   listener open for the attempt and sends the consent link as
 *   `_kiro/openExternalUrl`. A server the session did not declare is refused
 *   `-32602` naming it.
 * - `replace-list`: Grok Build's `x.ai/session/update_mcp_servers
 *   {sessionId, mcpServers}` replaces the servers the client passed. Sent
 *   once without the server and once with the session's list again, it
 *   stops and restarts that one server (live: `unavailable`
 *   `config_removed`, then `initializing` `config_added`). Only a server
 *   Station passed can be reconnected so; it has no OAuth step.
 */
const MCP_RECONNECT_ENGINES: ReadonlyArray<{
  identity: AcpHandshakeIdentity;
  kind: 'reset-server' | 'replace-list';
  method: string;
  vendor: string;
  evidence: string;
}> = [
  {
    identity: { capabilityMetaNamespace: 'kiro' },
    kind: 'reset-server',
    method: '_kiro/mcp/resetServer',
    vendor: 'Kiro',
    evidence:
      'kirocrew acp/types.py METHOD_KAS_MCP_RESET_SERVER; kiro-cli 3.3.0 v3 live probe (2026-11-13): an undeclared server answers -32602 McpServerNotDeclaredError',
  },
  {
    identity: { initializeMetaFlag: 'grokShell' },
    kind: 'replace-list',
    method: '_x.ai/session/update_mcp_servers',
    vendor: 'Grok Build',
    evidence:
      'grok 1.0.77 live capture (grok-1.0.77-session-frames.jsonl `mcp-reconnect`): update without the server -> {ok: true} and server_status unavailable config_removed; with it again -> {ok: true} and server_status initializing config_added',
  },
];

export function resolveAcpMcpReconnect(
  handshake: AcpIdentityHandshake | null | undefined,
):
  | { kind: 'reset-server' | 'replace-list'; method: string; vendor: string }
  | undefined {
  if (!handshake) return undefined;
  const engine = MCP_RECONNECT_ENGINES.find(({ identity }) =>
    matchesAcpHandshakeIdentity(handshake, identity),
  );
  return engine
    ? { kind: engine.kind, method: engine.method, vendor: engine.vendor }
    : undefined;
}
