import {
  type AcpHandshakeIdentity,
  type AcpIdentityHandshake,
  declaredAcpExtensionMethods,
  matchesAcpHandshakeIdentity,
} from '../../services/acp/acp-handshake-facts.js';
import { errorMessage } from '../../utils/error-message.js';

/**
 * How an ACP session injects mid-turn user input.
 *
 * Native channels (`_session/steer`, `_x.ai/interject`) are additive: the
 * in-flight `session/prompt` keeps running. `prompt-handoff` is additive
 * too: the engine takes a second `session/prompt` sent mid-turn as a steer,
 * answers the first one at once, and carries the running work on under the
 * second, so Station moves the turn's settlement to it without cancelling.
 * The cancel + re-prompt fallback cancels that prompt and re-prompts on the
 * same Station turn id — interruptive, but still a steer (same turn), not a
 * queued follow-up.
 */
export type AcpSteerChannel =
  | 'session-steer'
  | 'session-steering'
  | 'interject'
  | 'prompt-handoff'
  | 'cancel-reprompt';

/** Channels that call an extension method. */
type AcpSteerMethodChannel = 'session-steer' | 'session-steering' | 'interject';

const NATIVE_STEER_METHODS: ReadonlyArray<{
  channel: AcpSteerMethodChannel;
  method: string;
}> = [
  { channel: 'session-steer', method: '_session/steer' },
  { channel: 'interject', method: '_x.ai/interject' },
];

/**
 * Engines that answer a native steer method without declaring it (ADR 0013
 * expects declaration; these do not). Keyed on what the live handshake says
 * about itself, never on the launch command. Each entry names the run it was
 * observed against: `initialize`, then the method with an unknown session id,
 * answered `-32602`/`-32603` naming the session rather than `-32601`
 * (2026-10-21).
 */
const ACP_UNDECLARED_STEER_ENGINES: ReadonlyArray<{
  identity: AcpHandshakeIdentity;
  channel: Exclude<AcpSteerChannel, 'cancel-reprompt'>;
  methods: readonly string[];
  /**
   * Takes back every steer the running turn has not read yet. Listed only
   * where the engine's own report of the drop names exactly the unread
   * steers, so a caller can tell a dropped steer from a delivered one.
   */
  retract?: { method: string; observed: string };
  observed: string;
}> = [
  {
    identity: { agentInfoName: 'Kiro CLI Agent' },
    channel: 'session-steer',
    methods: ['_session/steer'],
    // Answered `{cleared: true}` either way; the drop itself is reported as
    // `AgentExecutionUserMessageCleared` naming the unread steers. Kiro's
    // agent service (`--agent-engine v3`) is deliberately not given one: its
    // clear names steers the turn already read (kirocrew
    // agent_sdk/backends_turns.py ACP_BACKENDS_STEER_RETRACT).
    retract: {
      method: '_session/steer/clear',
      observed:
        'kirocrew test/fixtures/acp_frames/kiro/steering-clear-live.jsonl (kiro-cli 2.33.1)',
    },
    observed: 'kiro-cli 2.33.0 `acp`',
  },
  {
    // `--v3` sends no agentInfo; it declares its own methods under
    // `_meta.kiro`, a list that omits `_session/steer`.
    identity: { capabilityMetaNamespace: 'kiro' },
    channel: 'session-steer',
    methods: ['_session/steer'],
    observed: 'kiro-cli 2.33.0 `--v3 acp`',
  },
  {
    // A core `session/prompt`, not an extension, so nothing is declared.
    // Google's ACP guide (antigravity.google/docs/ide/extensions/acp):
    // "Sending a prompt mid-turn steers the current turn." Recorded live on
    // Antigravity CLI 1.5.8 (2026-11-13): the first prompt answered
    // `end_turn` as the second arrived, and the running tool completed and
    // the reply followed the steer under the second prompt.
    identity: { agentInfoName: 'Antigravity ACP Server' },
    channel: 'prompt-handoff',
    methods: [],
    observed: 'Antigravity CLI 1.5.8 `agy acp`',
  },
  {
    // Grok sends no agentInfo. `x.ai/interject`, tried second as before this
    // table, answered -32601 on 1.0.50; a miss degrades to cancel + re-prompt.
    identity: { initializeMetaFlag: 'grokShell' },
    channel: 'interject',
    methods: ['_x.ai/interject', 'x.ai/interject'],
    observed: 'grok 1.0.50 `agent stdio`',
  },
  {
    // OpenCode 2.x declares `_meta.steering: {supported: true}` on its
    // `initialize` result but lists no method. Keyed on that declaration,
    // not on `agentInfo.name`: OpenCode 1.x names itself the same and has no
    // `_session/steering`, so it keeps cancel + re-prompt. A second
    // `session/prompt` mid-turn is refused -32603; this method is not.
    identity: { initializeMetaFeature: 'steering' },
    channel: 'session-steering',
    methods: ['_session/steering'],
    observed:
      'opencode 2.3.0 `acp` (2026-11-13): `{sessionId, prompt}` answered {outcome: "injected"} mid-stream and during a held permission, and the text reached the model; idle answered {outcome: "promptRequired", reason: "noRunningTurn"} (cli/src/acp/turn.ts)',
  },
];

export interface AcpSteerSelection {
  channel: AcpSteerChannel;
  /** Extension methods to try in order; empty for prompt hand-off and cancel + re-prompt. */
  methods: readonly string[];
  basis: 'declared' | 'undeclared-engine' | 'none';
  /** The method that takes back unread steers, where the engine has one. */
  retractMethod?: string;
}

type SteerHandshake = AcpIdentityHandshake;

/**
 * Select the steer channel from the live session's own `initialize` answer:
 * a declared native method first, then an engine known to answer one
 * undeclared, else cancel + re-prompt.
 */
export function resolveAcpSteerChannel(
  handshake: SteerHandshake | null | undefined,
): AcpSteerSelection {
  if (!handshake) {
    return { channel: 'cancel-reprompt', methods: [], basis: 'none' };
  }
  const declared = new Set(
    declaredAcpExtensionMethods(handshake.agentCapabilities),
  );
  const native = NATIVE_STEER_METHODS.find(({ method }) =>
    declared.has(method),
  );
  if (native) {
    return {
      channel: native.channel,
      methods: [native.method],
      basis: 'declared',
    };
  }
  const engine = ACP_UNDECLARED_STEER_ENGINES.find(({ identity }) =>
    matchesAcpHandshakeIdentity(handshake, identity),
  );
  if (engine) {
    return {
      channel: engine.channel,
      methods: engine.methods,
      basis: 'undeclared-engine',
      ...(engine.retract ? { retractMethod: engine.retract.method } : {}),
    };
  }
  return { channel: 'cancel-reprompt', methods: [], basis: 'none' };
}

export function isAcpMethodNotFound(error: unknown): boolean {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: unknown }).code === -32601
  ) {
    return true;
  }
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('method not found') ||
    message.includes('-32601') ||
    message.includes('unknown method') ||
    message.includes('unknown ext_method') ||
    message.includes('method not supported')
  );
}

export function acpSteerParams(
  channel: AcpSteerMethodChannel,
  sessionId: string,
  input: string,
): Record<string, unknown> {
  if (channel === 'session-steer')
    return acpSessionSteerParams(sessionId, input);
  if (channel === 'session-steering')
    return { sessionId, prompt: [{ type: 'text', text: input }] };
  return acpInterjectParams(sessionId, input);
}

/**
 * Whether an engine's answer to a native steer says it did not take the
 * input. Only the `session-steering` channel (OpenCode 2.x) has such an
 * answer: `{outcome: 'promptRequired'}` once no turn runs, so the steer
 * reached nothing and the turn it was meant for has ended. Another
 * channel's answer is never read this way.
 */
export function acpSteerDeclined(
  channel: AcpSteerChannel,
  result: unknown,
): boolean {
  return (
    channel === 'session-steering' &&
    result !== null &&
    typeof result === 'object' &&
    (result as { outcome?: unknown }).outcome === 'promptRequired'
  );
}

function acpSessionSteerParams(
  sessionId: string,
  input: string,
): Record<string, unknown> {
  return {
    sessionId,
    message: `<user_message>\n${input}\n</user_message>`,
  };
}

function acpInterjectParams(
  sessionId: string,
  input: string,
): Record<string, unknown> {
  return { sessionId, text: input };
}
