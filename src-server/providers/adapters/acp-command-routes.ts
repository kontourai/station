/**
 * How an ACP engine's slash command runs (`EngineCommandRoute`,
 * `packages/contracts/src/engine-commands.ts`).
 *
 * By default a command is prompt text: Station sends `/<name> <args>` as the
 * turn. A command becomes its own request only through an entry below, and
 * only when the live session's `initialize` answer backs it (ADR 0013):
 *
 * - `basis: 'declared'`: the method is in the session's declared extension
 *   methods (`declaredAcpExtensionMethods`). Kiro's agent service lists its
 *   own under `agentCapabilities._meta.kiro.extensionMethods`.
 * - `basis: 'undeclared-engine'`: the engine answers the method without
 *   declaring it, and the entry is keyed on what the handshake says about
 *   itself (`matchesAcpHandshakeIdentity`), as the steer table is
 *   (`acp-steer.ts`). Never on the launch command.
 *
 * Every entry is read-only or the engine's own session housekeeping;
 * Station's knowledge stores stay authoritative, so no memory write, import,
 * export or sync is routed (docs/decisions/agent-extension-bindings.md).
 * Whatever the engine answers is shown as the engine's output, never as
 * Station's.
 */
import {
  ENGINE_COMMAND_OUTCOME_TEXT_MAX,
  type EngineCommandOutcome,
  type EngineCommandRoute,
  engineCommandRequestParams,
} from '@kontourai/station-contracts/engine-commands';
import {
  type AcpHandshakeIdentity,
  type AcpIdentityHandshake,
  declaredAcpExtensionMethods,
  matchesAcpHandshakeIdentity,
} from '../../services/acp/acp-handshake-facts.js';
import { errorMessage } from '../../utils/error-message.js';
import { isAcpMethodNotFound } from './acp-steer.js';

type EngineRequestRoute = Extract<
  EngineCommandRoute,
  { kind: 'engine-request' }
>;

interface AcpCommandRouteEntry {
  /** The slash command's name, without the slash. */
  readonly command: string;
  /**
   * The first argument words this entry takes. Absent: any. `''` stands for
   * no argument at all. A subcommand outside the list is not routed.
   */
  readonly subcommands?: readonly string[];
  /**
   * The param key the argument word after the subcommand is sent under
   * (`/memory get <id>` sends `{ id }`). The entry is not routed without one.
   */
  readonly argumentKey?: string;
  /** Required for `undeclared-engine` entries. */
  readonly identity?: AcpHandshakeIdentity;
  /** Shown beside a declared command the engine did not list itself. */
  readonly description: string;
  readonly route: EngineRequestRoute;
}

const KAS_EVIDENCE =
  'kiro-cli 3.3.0 `acp --agent-engine v3` live probe (2026-11-13): declared in _meta.kiro.extensionMethods and answered';

/** Declared routes: each applies only when its method is in the live declared set. */
const DECLARED_COMMAND_ROUTES: readonly AcpCommandRouteEntry[] = [
  {
    command: 'compact',
    description: "Compact the engine's conversation history",
    route: {
      kind: 'engine-request',
      method: '_kiro/session/compact',
      params: 'session',
      basis: 'declared',
      evidence:
        'kirocrew acp/types.py METHOD_KAS_SESSION_COMPACT and test/fixtures/acp_frames/kas/compact-live.jsonl',
    },
  },
  {
    command: 'context',
    description: "Show what fills the engine's context",
    route: {
      kind: 'engine-request',
      method: '_kiro/session/context',
      params: 'session+subcommand',
      // Without a subcommand the method answers `null`.
      defaultSubcommand: 'show',
      basis: 'declared',
      evidence: `${KAS_EVIDENCE} ({sessionId, subcommand: 'show'} -> {success, entries, breakdown})`,
    },
  },
  {
    command: 'knowledge',
    description: "Show the engine's knowledge bases",
    route: {
      kind: 'engine-request',
      method: '_kiro/knowledge',
      params: 'session+subcommand',
      // Without one it answers `{success: false, "Unknown subcommand"}`.
      defaultSubcommand: 'show',
      basis: 'declared',
      evidence: `${KAS_EVIDENCE} ({sessionId, subcommand: 'show'} -> {success, entries})`,
    },
  },
  {
    command: 'code',
    description: "Show the engine's code intelligence",
    route: {
      kind: 'engine-request',
      method: '_kiro/codeIntelligence',
      params: 'session+subcommand',
      defaultSubcommand: 'status',
      basis: 'declared',
      evidence: `${KAS_EVIDENCE} (answers {success: false, message} when not enabled)`,
    },
  },
  {
    command: 'memory',
    subcommands: ['', 'list'],
    description: "List the engine's own memories (read-only)",
    route: {
      kind: 'engine-request',
      method: '_kiro/memory/list',
      params: 'session',
      basis: 'declared',
      evidence: `${KAS_EVIDENCE} ({sessionId} -> {memories, total, counts})`,
    },
  },
  {
    command: 'memory',
    subcommands: ['get'],
    argumentKey: 'id',
    description: "Show one of the engine's memories (read-only)",
    route: {
      kind: 'engine-request',
      method: '_kiro/memory/get',
      params: 'session',
      basis: 'declared',
      evidence: `${KAS_EVIDENCE} ({sessionId, id}; an unknown id answers -32603 naming it)`,
    },
  },
  {
    command: 'config-template',
    description: "Show the engine's session configuration template",
    route: {
      kind: 'engine-request',
      method: '_kiro/config/template',
      params: 'session',
      basis: 'declared',
      evidence: `${KAS_EVIDENCE} ({sessionId} -> {modes, configOptions})`,
    },
  },
  {
    command: 'permissions',
    subcommands: ['', 'list'],
    description: "List the engine's permission presets (read-only)",
    route: {
      kind: 'engine-request',
      method: '_kiro/permissions/presets/list',
      params: 'session',
      basis: 'declared',
      evidence: `${KAS_EVIDENCE} ({sessionId} -> {presets})`,
    },
  },
  {
    command: 'settings',
    description: "Show the engine's effective settings (read-only)",
    route: {
      kind: 'engine-request',
      method: '_kiro/configuration/getState',
      params: 'session',
      fixedParams: { observer: 'session' },
      basis: 'declared',
      evidence: `${KAS_EVIDENCE} ({observer: 'session', sessionId} -> {view, layers, settings}; without observer -32602)`,
    },
  },
  {
    command: 'export',
    description: "Export the engine's record of this session",
    route: {
      kind: 'engine-request',
      method: '_kiro/session/export',
      params: 'session',
      basis: 'declared',
      evidence: `${KAS_EVIDENCE} ({sessionId} -> {success, filePath})`,
    },
  },
];

/**
 * kiro-cli's own commands (`--agent-engine v2`), which it runs over
 * `_kiro.dev/commands/execute` without declaring it. Reviewed allowlist:
 * commands that read state or are the engine's own housekeeping. Left out on
 * purpose, so they stay prompt text: `quit` (ends the engine process),
 * `chat`, `clear` and `rewind` (change history Station keeps), `agent` and
 * `model` (change what Station reports the session runs), and the
 * interactive ones (`paste`, `voice`, `reply`, `feedback`, `hooks`).
 */
const KIRO_CLI_EXECUTE_COMMANDS: readonly string[] = [
  'help',
  'context',
  'compact',
  'usage',
  'mcp',
  'tools',
  'knowledge',
  'prompts',
  'code',
  'stats',
  'guide',
];

const UNDECLARED_COMMAND_ROUTES: readonly AcpCommandRouteEntry[] =
  KIRO_CLI_EXECUTE_COMMANDS.map((command) => ({
    command,
    identity: { agentInfoName: 'Kiro CLI Agent' },
    description: '',
    route: {
      kind: 'engine-request',
      method: '_kiro.dev/commands/execute',
      params: 'session+command-object',
      basis: 'undeclared-engine',
      evidence:
        'kiro-cli 3.3.0 `acp` live probe (2026-11-13): `help` answered {success: true, message}; the string form and an unknown command answer -32700',
    },
  }));

const PROMPT_TEXT: EngineCommandRoute = { kind: 'prompt-text' };

export interface AcpCommandInvocation {
  readonly name: string;
  readonly args: string;
}

/** A command a person typed, split into its name and argument text. */
export function readAcpSlashCommand(
  text: string | undefined,
): AcpCommandInvocation | undefined {
  const match = /^\/([A-Za-z0-9][\w.:-]*)(?:\s+([\s\S]*))?$/.exec(
    text?.trim() ?? '',
  );
  if (!match?.[1]) return undefined;
  return { name: match[1], args: match[2]?.trim() ?? '' };
}

function words(args: string): string[] {
  return args.split(/\s+/).filter(Boolean);
}

function entryTakes(
  entry: AcpCommandRouteEntry,
  invocation: AcpCommandInvocation,
): boolean {
  if (entry.command !== invocation.name) return false;
  const [subcommand = '', argument] = words(invocation.args);
  if (entry.subcommands && !entry.subcommands.includes(subcommand))
    return false;
  if (entry.argumentKey && !argument) return false;
  return true;
}

function entryApplies(
  entry: AcpCommandRouteEntry,
  handshake: AcpIdentityHandshake,
  declared: ReadonlySet<string>,
): boolean {
  return entry.route.basis === 'declared'
    ? declared.has(entry.route.method)
    : entry.identity !== undefined &&
        matchesAcpHandshakeIdentity(handshake, entry.identity);
}

/** A resolved route, with how to build its request. */
export interface AcpResolvedCommandRoute {
  readonly route: EngineCommandRoute;
  /** Present for an `engine-request` route: the request's params. */
  readonly params?: (sessionId: string) => Record<string, unknown>;
}

/**
 * The route for `invocation` on the session whose `initialize` answer is
 * `handshake`. Prompt text unless an entry applies to this live session.
 */
export function resolveAcpCommandRoute(
  handshake: AcpIdentityHandshake | null | undefined,
  invocation: AcpCommandInvocation,
): AcpResolvedCommandRoute {
  if (!handshake) return { route: PROMPT_TEXT };
  const declared = new Set(
    declaredAcpExtensionMethods(handshake.agentCapabilities),
  );
  const entry = [...DECLARED_COMMAND_ROUTES, ...UNDECLARED_COMMAND_ROUTES].find(
    (candidate) =>
      entryTakes(candidate, invocation) &&
      entryApplies(candidate, handshake, declared),
  );
  if (!entry) return { route: PROMPT_TEXT };
  const { route } = entry;
  return {
    route,
    params: (sessionId) => {
      const built = engineCommandRequestParams(
        route.params,
        sessionId,
        invocation,
        {
          ...(route.defaultSubcommand
            ? { defaultSubcommand: route.defaultSubcommand }
            : {}),
          ...(route.fixedParams ? { fixedParams: route.fixedParams } : {}),
        },
      );
      if (!entry.argumentKey) return built;
      const argument = words(invocation.args)[1];
      return { ...built, [entry.argumentKey]: argument };
    },
  };
}

/**
 * The commands a session's declared methods add beyond what the engine
 * listed itself (Kiro's agent service lists only its custom agents and
 * skills), each with its route.
 */
export function acpDeclaredCommands(
  handshake: AcpIdentityHandshake | null | undefined,
): Array<{ name: string; description: string; route: EngineCommandRoute }> {
  if (!handshake) return [];
  const declared = new Set(
    declaredAcpExtensionMethods(handshake.agentCapabilities),
  );
  const seen = new Set<string>();
  const commands: Array<{
    name: string;
    description: string;
    route: EngineCommandRoute;
  }> = [];
  for (const entry of DECLARED_COMMAND_ROUTES) {
    if (seen.has(entry.command) || !entryApplies(entry, handshake, declared))
      continue;
    seen.add(entry.command);
    commands.push({
      name: entry.command,
      description: entry.description,
      route: entry.route,
    });
  }
  return commands;
}

function bounded(text: string): string {
  return text.length > ENGINE_COMMAND_OUTCOME_TEXT_MAX
    ? `${text.slice(0, ENGINE_COMMAND_OUTCOME_TEXT_MAX)}…`
    : text;
}

/**
 * What an engine's answer says, as an outcome. A `{success: false}` answer is
 * still `answered` (an engine-attributed failure line); a message is shown
 * as the engine wrote it; any other answer is shown as its JSON.
 */
export function acpCommandAnswer(result: unknown): EngineCommandOutcome {
  if (result === null || result === undefined)
    return { kind: 'answered', text: '' };
  if (typeof result !== 'object' || Array.isArray(result))
    return { kind: 'answered', text: bounded(JSON.stringify(result)) };
  const record = result as Record<string, unknown>;
  const success =
    typeof record.success === 'boolean' ? record.success : undefined;
  const message =
    typeof record.message === 'string'
      ? record.message
      : typeof record.error === 'string'
        ? record.error
        : undefined;
  const rest = Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => key !== 'success' && key !== 'message' && key !== 'error',
    ),
  );
  const detail =
    Object.keys(rest).length > 0
      ? `\`\`\`json\n${JSON.stringify(rest, null, 2)}\n\`\`\``
      : '';
  const text = [message, detail].filter(Boolean).join('\n\n');
  return {
    kind: 'answered',
    text: bounded(text),
    ...(success !== undefined ? { success } : {}),
  };
}

/**
 * Whether a refused request means "this engine has no such command", so the
 * command runs as prompt text instead: `-32601`, or kiro-cli's `-32700`
 * deserialization refusal of a command name it has no variant for (live,
 * kiro-cli 3.3.0: "unknown variant `…`", `data.phase: 'deserialization'`).
 */
export function acpCommandUnsupported(error: unknown): boolean {
  if (isAcpMethodNotFound(error)) return true;
  if (!error || typeof error !== 'object') return false;
  const { code, data } = error as { code?: unknown; data?: unknown };
  return (
    code === -32700 &&
    data !== null &&
    typeof data === 'object' &&
    (data as { phase?: unknown }).phase === 'deserialization'
  );
}

/** A refused request as an outcome. */
export function acpCommandFailure(error: unknown): EngineCommandOutcome {
  return acpCommandUnsupported(error)
    ? { kind: 'unsupported' }
    : { kind: 'failed', message: bounded(errorMessage(error)) };
}
