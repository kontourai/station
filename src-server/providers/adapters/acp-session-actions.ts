/**
 * Session actions an ACP engine may offer beyond prompting: rewind in place,
 * native fork, and reconnecting one MCP server. Each is a binding
 * keyed on what the live session's `initialize` answer says (ADR 0013), never
 * a static claim about "ACP": the ACP adapter runs many engines, so its
 * adapter-level continuity stays `none` and these are per-session
 * observations ({@link acpSessionContinuity}).
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
const REWIND_BINDINGS = [
  {
    namespace: 'kiro',
    flag: 'checkpoints',
    method: '_kiro/checkpoint/revertMultiple',
    evidence:
      'kiro-cli 3.3.0 `acp --agent-engine v3` live probe (2026-11-13): {sessionId, messageId} -> {success: true, affectedFiles: [], totalFiles: 0}; kirocrew acp/types.py METHOD_KAS_CHECKPOINT_REVERT',
  },
] as const;

/**
 * Fork at a user message: core `session/fork` with the fork point in the
 * vendor's `_meta`, declared as `sessionCapabilities.fork._meta.<ns>.messageId`.
 * The fork keeps the named message's whole turn (@kiro/agent 0.66.102
 * `forkSession`; live: answered a new sessionId and its configOptions).
 */
const FORK_AT_MESSAGE_NAMESPACES = ['kiro'] as const;

export interface AcpRewindBinding {
  readonly method: string;
  readonly evidence: string;
}

export function resolveAcpRewind(
  handshake: Handshake | null | undefined,
): AcpRewindBinding | undefined {
  const binding = REWIND_BINDINGS.find(({ namespace, flag }) =>
    vendorFlag(handshake, namespace, flag),
  );
  return binding
    ? { method: binding.method, evidence: binding.evidence }
    : undefined;
}

/** Bound on one restored path the engine reports; a longer one is dropped. */
const REWIND_PATH_MAX_CHARS = 4096;

/**
 * The engine's answer to a rewind: `{success, affectedFiles?, message?}`
 * (live: `{success: true, affectedFiles: [], totalFiles: 0}`). `affectedFiles`
 * is read only when it is an array: its count is the array's length, and at
 * most `pathsMax` of its string entries are kept. Anything else is not a
 * success.
 */
export function readAcpRewindAnswer(
  result: unknown,
  pathsMax: number,
):
  | { success: true; affectedFiles?: { count: number; paths: string[] } }
  | { success: false; message?: string } {
  if (!isRecord(result) || result.success !== true) {
    const message =
      isRecord(result) && typeof result.message === 'string'
        ? result.message.slice(0, 1024)
        : undefined;
    return { success: false, ...(message ? { message } : {}) };
  }
  if (!Array.isArray(result.affectedFiles)) return { success: true };
  const paths = result.affectedFiles
    .filter(
      (path): path is string =>
        typeof path === 'string' &&
        path.length > 0 &&
        path.length <= REWIND_PATH_MAX_CHARS,
    )
    .slice(0, pathsMax);
  return {
    success: true,
    affectedFiles: { count: result.affectedFiles.length, paths },
  };
}

/** The `_meta` namespace the fork point goes under, when native fork-at-message is declared. */
export function resolveAcpForkAtMessage(
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
 * This live session's continuity, as its own handshake declares it. Rewind
 * and fork are `none` unless the binding above applies.
 */
export function acpSessionContinuity(handshake: Handshake | null | undefined): {
  fork: 'native' | 'none';
  rewind: 'in-place' | 'none';
} {
  return {
    fork: resolveAcpForkAtMessage(handshake) ? 'native' : 'none',
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
 * Reconnect one MCP server the engine runs. Kiro's agent service answers
 * `_kiro/mcp/resetServer {sessionId, serverName, startOAuth}` without listing
 * it in `extensionMethods`; with `startOAuth: true` it keeps its OAuth
 * callback listener open for the attempt and sends the consent link as
 * `_kiro/openExternalUrl`. A server the session did not declare is refused
 * `-32602` naming it.
 */
const MCP_RECONNECT_ENGINES: ReadonlyArray<{
  identity: AcpHandshakeIdentity;
  method: string;
  vendor: string;
  evidence: string;
}> = [
  {
    identity: { capabilityMetaNamespace: 'kiro' },
    method: '_kiro/mcp/resetServer',
    vendor: 'Kiro',
    evidence:
      'kirocrew acp/types.py METHOD_KAS_MCP_RESET_SERVER; kiro-cli 3.3.0 v3 live probe (2026-11-13): an undeclared server answers -32602 McpServerNotDeclaredError',
  },
];

export function resolveAcpMcpReconnect(
  handshake: AcpIdentityHandshake | null | undefined,
): { method: string; vendor: string } | undefined {
  if (!handshake) return undefined;
  const engine = MCP_RECONNECT_ENGINES.find(({ identity }) =>
    matchesAcpHandshakeIdentity(handshake, identity),
  );
  return engine ? { method: engine.method, vendor: engine.vendor } : undefined;
}
