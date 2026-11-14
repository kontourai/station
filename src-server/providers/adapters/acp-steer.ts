import {
  type AcpHandshakeIdentity,
  type AcpIdentityHandshake,
  declaredAcpExtensionMethods,
  matchesAcpHandshakeIdentity,
} from '../../services/acp/acp-handshake-facts.js';
import { errorMessage } from '../../utils/error-message.js';
import { isRecord } from '../../utils/is-record.js';

/**
 * How an ACP session injects mid-turn user input.
 *
 * Native channels (`_session/steer`, `_x.ai/interject`, Goose's run steer)
 * are additive: the in-flight `session/prompt` keeps running. A run steer
 * names the run it joins, which the engine announced in `_meta`; with no
 * run announced it is not sent. The cancel + re-prompt fallback
 * cancels that prompt and re-prompts on the same Station turn id —
 * interruptive, but still a steer (same turn), not a queued follow-up.
 */
export type AcpSteerChannel =
  | 'session-steer'
  | 'interject'
  | 'run-steer'
  | 'cancel-reprompt';

/**
 * Where an engine names its running prompt: `_meta.<namespace>.<key>` on a
 * `session_info_update`, a run id string while a prompt runs and `null`
 * once none does.
 */
export interface AcpSteerActiveRunSource {
  namespace: string;
  key: string;
}

/** The running prompt's id as the engine last announced it. */
export interface AcpSteerState {
  /** Set at session start from the handshake's steer selection. */
  acpSteerActiveRunSource?: AcpSteerActiveRunSource;
  acpActiveRunId?: string;
}

const NATIVE_STEER_METHODS: ReadonlyArray<{
  channel: Exclude<AcpSteerChannel, 'cancel-reprompt'>;
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
  /** Where a `run-steer` engine names the run a steer must join. */
  activeRun?: AcpSteerActiveRunSource;
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
    // Grok sends no agentInfo. `x.ai/interject`, tried second as before this
    // table, answered -32601 on 1.0.50; a miss degrades to cancel + re-prompt.
    identity: { initializeMetaFlag: 'grokShell' },
    channel: 'interject',
    methods: ['_x.ai/interject', 'x.ai/interject'],
    observed: 'grok 1.0.50 `agent stdio`',
  },
  {
    // Goose names itself `goose` and declares only `_meta.goose` feature
    // flags, not its methods (acp/server.rs on_initialize,
    // agent_capabilities_meta). The steer is `{sessionId, prompt,
    // expectedRunId}` (goose-sdk-types custom_requests.rs
    // SteerSessionRequest) and is refused unless `expectedRunId` is the
    // running prompt's, which every prompt announces at its start as
    // `_meta.goose.activeRunId` and clears with `null`
    // (send_active_run_update). Read from source, not a live run.
    identity: { agentInfoName: 'goose' },
    channel: 'run-steer',
    methods: ['_goose/unstable/session/steer'],
    activeRun: { namespace: 'goose', key: 'activeRunId' },
    observed:
      'aaif-goose/goose v1.59.0 (5d03ef6ed07b) crates/goose/src/acp/server.rs on_steer_session, send_active_run_update; crates/goose-sdk-types/src/custom_requests.rs',
  },
];

export interface AcpSteerSelection {
  channel: AcpSteerChannel;
  /** Extension methods to try in order; empty for cancel + re-prompt. */
  methods: readonly string[];
  basis: 'declared' | 'undeclared-engine' | 'none';
  /** The method that takes back unread steers, where the engine has one. */
  retractMethod?: string;
  /** Where the engine names the run a `run-steer` joins. */
  activeRun?: AcpSteerActiveRunSource;
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
      ...(engine.activeRun ? { activeRun: engine.activeRun } : {}),
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

/** Bound on a run id Station keeps; a longer one is not kept. */
const ACTIVE_RUN_ID_MAX_CHARS = 256;

/**
 * Track the running prompt a `session_info_update` names, on a session
 * whose engine announces it there. `null` clears it; anything else leaves
 * the last value.
 */
export function trackAcpSteerActiveRun(
  update: { _meta?: Record<string, unknown> | null },
  state: AcpSteerState | undefined,
): void {
  const source = state?.acpSteerActiveRunSource;
  if (!state || !source) return;
  const vendor = update._meta?.[source.namespace];
  if (!isRecord(vendor) || !Object.hasOwn(vendor, source.key)) return;
  const runId = vendor[source.key];
  if (runId === null) {
    state.acpActiveRunId = undefined;
  } else if (
    typeof runId === 'string' &&
    runId.length > 0 &&
    runId.length <= ACTIVE_RUN_ID_MAX_CHARS
  ) {
    state.acpActiveRunId = runId;
  }
}

/**
 * The steer request for a native channel, or `undefined` when a `run-steer`
 * has no announced run to join.
 */
/**
 * JSON-RPC invalid params (-32602). Goose answers a run steer this way when
 * the run it names has ended or been replaced ("no active run to steer",
 * "expected active run id ...": acp/server.rs require_active_run).
 */
export function isAcpInvalidParams(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: unknown }).code === -32602
  );
}

export function acpSteerParams(
  channel: Exclude<AcpSteerChannel, 'cancel-reprompt'>,
  sessionId: string,
  input: string,
  activeRunId?: string,
): Record<string, unknown> | undefined {
  switch (channel) {
    case 'session-steer':
      return acpSessionSteerParams(sessionId, input);
    case 'interject':
      return acpInterjectParams(sessionId, input);
    case 'run-steer':
      return activeRunId
        ? {
            sessionId,
            prompt: [{ type: 'text', text: input }],
            expectedRunId: activeRunId,
          }
        : undefined;
  }
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
