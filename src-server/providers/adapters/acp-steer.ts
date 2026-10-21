import { declaredAcpExtensionMethods } from '../../services/acp/acp-handshake-facts.js';
import type { InitializeResult } from '../../services/acp/acp-process.js';
import { errorMessage } from '../../utils/error-message.js';

/**
 * How an ACP session injects mid-turn user input.
 *
 * Native channels (`_session/steer`, `_x.ai/interject`) are additive: the
 * in-flight `session/prompt` keeps running. The cancel + re-prompt fallback
 * cancels that prompt and re-prompts on the same Station turn id —
 * interruptive, but still a steer (same turn), not a queued follow-up.
 */
export type AcpSteerChannel = 'session-steer' | 'interject' | 'cancel-reprompt';

const NATIVE_STEER_METHODS: ReadonlyArray<{
  channel: Exclude<AcpSteerChannel, 'cancel-reprompt'>;
  method: string;
}> = [
  { channel: 'session-steer', method: '_session/steer' },
  { channel: 'interject', method: '_x.ai/interject' },
];

/** One declared handshake fact, matched exactly. */
type AcpHandshakeIdentity =
  | { agentInfoName: string }
  | { capabilityMetaNamespace: string }
  | { initializeMetaFlag: string };

/**
 * Engines that answer a native steer method without declaring it (ADR 0013
 * expects declaration; these do not). Keyed on what the live handshake says
 * about itself, never on the launch command. Each entry names the run it was
 * observed against: `initialize`, then the method with an unknown session id,
 * answered `-32602`/`-32603` naming the session rather than `-32601`
 * (2026-10-21).
 */
export const ACP_UNDECLARED_STEER_ENGINES: ReadonlyArray<{
  identity: AcpHandshakeIdentity;
  channel: Exclude<AcpSteerChannel, 'cancel-reprompt'>;
  methods: readonly string[];
  observed: string;
}> = [
  {
    identity: { agentInfoName: 'Kiro CLI Agent' },
    channel: 'session-steer',
    methods: ['_session/steer'],
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
    // Grok sends no agentInfo. `x.ai/interject`, tried second as before this
    // table, answered -32601 on 1.0.50; a miss degrades to cancel + re-prompt.
    identity: { initializeMetaFlag: 'grokShell' },
    channel: 'interject',
    methods: ['_x.ai/interject', 'x.ai/interject'],
    observed: 'grok 1.0.50 `agent stdio`',
  },
];

export interface AcpSteerSelection {
  channel: AcpSteerChannel;
  /** Extension methods to try in order; empty for cancel + re-prompt. */
  methods: readonly string[];
  basis: 'declared' | 'undeclared-engine' | 'none';
}

type SteerHandshake = Pick<
  InitializeResult,
  'agentInfo' | 'agentCapabilities' | '_meta'
>;

function hasRecordKey(value: unknown, key: string): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.hasOwn(value as object, key)
  );
}

function matchesIdentity(
  handshake: SteerHandshake,
  identity: AcpHandshakeIdentity,
): boolean {
  if ('agentInfoName' in identity) {
    return handshake.agentInfo?.name === identity.agentInfoName;
  }
  if ('capabilityMetaNamespace' in identity) {
    return hasRecordKey(
      handshake.agentCapabilities?._meta,
      identity.capabilityMetaNamespace,
    );
  }
  return handshake._meta?.[identity.initializeMetaFlag] === true;
}

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
    matchesIdentity(handshake, identity),
  );
  if (engine) {
    return {
      channel: engine.channel,
      methods: engine.methods,
      basis: 'undeclared-engine',
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
  channel: Exclude<AcpSteerChannel, 'cancel-reprompt'>,
  sessionId: string,
  input: string,
): Record<string, unknown> {
  return channel === 'session-steer'
    ? acpSessionSteerParams(sessionId, input)
    : acpInterjectParams(sessionId, input);
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
