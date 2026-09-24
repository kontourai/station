import { APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE } from '@kontourai/station-contracts/orchestration';
import {
  type ApprovalMode,
  isApprovalMode,
} from '@kontourai/station-contracts/provider';

export type { ApprovalMode } from '@kontourai/station-contracts/provider';

/** Clean engine identities whose adapter maps `approvalMode` to a native knob. */
const APPROVAL_MODE_KNOB_ENGINE_IDS = new Set(['claude', 'codex']);

/**
 * Whether this engine connection's adapter reads `approvalMode` at all.
 * Everything else (ACP, Ollama, Bedrock, the Station agent runtime) has no
 * native knob, so the composer chip renders read-only for them.
 */
export function approvalModeKnobSupported(engineId?: string | null): boolean {
  return !!engineId && APPROVAL_MODE_KNOB_ENGINE_IDS.has(engineId);
}

/**
 * Station no longer guesses a Claude Ask / Codex Never default (station#1950).
 * Untouched sessions inherit the engine's own config; the chip shows
 * `'connection-default'` until `session.configured` reports what applied.
 */
export function adapterDefaultApprovalMode(
  _engineId?: string | null,
): ApprovalMode | undefined {
  return undefined;
}

export const APPROVAL_MODE_OPTIONS: Array<{
  value: ApprovalMode;
  label: string;
  description: string;
}> = [
  {
    value: 'connection-default',
    label: 'Connection default',
    description: 'Clears any session override for this chat.',
  },
  {
    value: 'ask',
    // Not "Ask every time" (#1545): every engine keeps its own allow list and
    // read-only classifier underneath this mode, so some calls do run without
    // a Station approval request. The label must not promise a floor Station
    // does not impose.
    label: 'Ask first',
    description:
      'Asks before actions the engine does not already allow on its own.',
  },
  {
    value: 'auto',
    label: 'Auto',
    description:
      'Runs some actions automatically; the exact boundary depends on the engine.',
  },
  {
    value: 'never',
    label: 'Never ask (full access)',
    description:
      'Runs fully autonomously with no sandbox — the agent can do anything you can.',
  },
];

/**
 * Per-engine description, for modes whose real guarantee differs by engine
 * connection (archive#727 for 'auto'; #1545 added 'ask'). The generic copy in
 * `APPROVAL_MODE_OPTIONS` is the fallback for any other mode, or for a runtime
 * the chip doesn't recognize.
 */
const ENGINE_MODE_DESCRIPTIONS: Partial<
  Record<ApprovalMode, Partial<Record<string, string>>>
> = {
  auto: {
    codex:
      'Agent asks at its own discretion; file writes sandboxed to the workspace.',
    claude: 'File edits auto-approved; other actions still ask.',
  },
  ask: {
    // #1545: Station imposes no approval floor over Claude's own permission
    // flow in this mode, so the copy has to name whose rules can skip an
    // approval. It says "and this workspace's" because Station sets no
    // `settingSources` (claude-adapter.ts, accepted gap): a workspace the
    // operator has trusted in Claude Code has its checked-in
    // `.claude/settings.json` in the cascade too. An earlier draft said "only
    // your user-level Claude settings apply", which was true only while the
    // narrowing was in place — do not restore that wording without it.
    claude:
      "Claude asks before tool calls its own rules don't already allow — your Claude settings and a trusted workspace's both count.",
  },
};

export function approvalModeDescription(
  mode: ApprovalMode,
  engineId?: string | null,
): string {
  const engineCopy = engineId && ENGINE_MODE_DESCRIPTIONS[mode]?.[engineId];
  if (engineCopy) return engineCopy;
  return (
    APPROVAL_MODE_OPTIONS.find((option) => option.value === mode)
      ?.description ?? ''
  );
}

export function approvalModeLabel(mode: ApprovalMode): string {
  return (
    APPROVAL_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
  );
}

/**
 * Short forms for the composer chip (archive#1010). The descriptive labels in
 * `APPROVAL_MODE_OPTIONS` are written for the picker's option rows, where a
 * full sentence fragment reads well; in a pill they are far too long — "Never
 * ask (full access) — default" measured 152px against 390px of composer and
 * clipped its own caret at the viewport edge.
 *
 * Nothing is lost by shortening: the chip's `aria-label` and `title` still
 * carry the full label (including the "— default" source suffix), and the
 * sheet still shows label + per-engine description. The source distinction the
 * suffix used to carry is already encoded visually by the
 * `--default`/`--override` variants, so repeating it as text was redundant at
 * exactly the width where it cost the most.
 */
const APPROVAL_MODE_CHIP_LABELS: Record<ApprovalMode, string> = {
  'connection-default': 'Default',
  ask: 'Ask',
  auto: 'Auto',
  // Keeps the severity legible at a glance — the danger is the point.
  never: 'Full access',
};

export function approvalModeChipLabel(mode: ApprovalMode): string {
  return APPROVAL_MODE_CHIP_LABELS[mode] ?? mode;
}

type ApprovalModeSource =
  | 'session override'
  | 'agent default'
  | 'station default'
  | 'adapter default';

interface EffectiveApprovalMode {
  mode: ApprovalMode;
  label: string;
  source: ApprovalModeSource;
}

/**
 * The effective approval mode for a session, in the order the server applies
 * it (#2436, `approval-posture.ts`): the session's own pick, then the
 * Agent's default (`AgentSpec.execution.approvalMode`), then this Station's
 * `AppConfig.defaultApprovalMode` (#2144 slice 6), then the adapter's own
 * built-in default. `'connection-default'` is only ever a *selectable*
 * value meaning "clear my override" — it is never itself displayed as a
 * resolved posture when a concrete default is known (archive#727).
 *
 * An engine connection's `config.approvalMode` is not a layer: no writer
 * persists it, and the server does not apply it, so showing it would name a
 * posture nothing enforces.
 *
 * When the resolution did NOT come from the session's own pick, the label
 * says which default it is, so the two are distinguishable in the chip.
 */
export function resolveEffectiveApprovalMode({
  engineConnectionId,
  sessionOverride,
  agentDefault,
  stationDefault,
}: {
  engineConnectionId?: string | null;
  sessionOverride?: unknown;
  /** The session's Agent's own default (`execution.approvalMode`). */
  agentDefault?: unknown;
  /**
   * This Station's `AppConfig.defaultApprovalMode`. Applies only to an
   * engine whose adapter reads the knob at all — passing it for any other
   * engine would report a posture nothing enforces.
   */
  stationDefault?: unknown;
}): EffectiveApprovalMode {
  const override = isApprovalMode(sessionOverride)
    ? sessionOverride
    : undefined;
  if (override && override !== 'connection-default') {
    return {
      mode: override,
      label: approvalModeLabel(override),
      source: 'session override',
    };
  }

  const agentDefaultMode =
    approvalModeKnobSupported(engineConnectionId) &&
    isApprovalMode(agentDefault) &&
    agentDefault !== 'connection-default'
      ? agentDefault
      : undefined;
  if (agentDefaultMode) {
    return {
      mode: agentDefaultMode,
      label: `${approvalModeLabel(agentDefaultMode)} (agent default)`,
      source: 'agent default',
    };
  }

  // #2144 slice 6. Gated on `approvalModeKnobSupported`: an engine whose
  // adapter never reads `approvalMode` would otherwise display a Station
  // posture as its resolved one, which is a claim nothing applies. The
  // Settings row's own copy says so too, but the gate is here because this
  // is what every surface reads.
  const stationDefaultMode =
    approvalModeKnobSupported(engineConnectionId) &&
    isApprovalMode(stationDefault) &&
    stationDefault !== 'connection-default'
      ? stationDefault
      : undefined;
  if (stationDefaultMode) {
    return {
      mode: stationDefaultMode,
      label: `${approvalModeLabel(stationDefaultMode)} — default`,
      source: 'station default',
    };
  }

  const adapterDefault = adapterDefaultApprovalMode(engineConnectionId);
  if (adapterDefault) {
    return {
      mode: adapterDefault,
      label: `${approvalModeLabel(adapterDefault)} — default`,
      source: 'adapter default',
    };
  }

  // No knob-supporting runtime is known (read-only providers, or no
  // engineConnectionId at all) — Station genuinely has nothing more specific to
  // report than "whatever the connection already does."
  return {
    mode: 'connection-default',
    label: approvalModeLabel('connection-default'),
    source: 'adapter default',
  };
}

/**
 * #2436: the approval posture is a SERVER-ordered session decision (see
 * docs/design/approval-posture-server-ordered.md). A pick is a
 * `setApprovalMode` command; the server records it as a
 * `session.approval-mode-set` event and applies the conversation's latest
 * recorded posture at every session start and turn start, whatever path
 * sends that turn. This client keeps only:
 *
 * - `queuedApprovalMode`: a pick the server has not received yet (no session
 *   yet, offline, or the command failed). The next composer send, offline
 *   replay or queued drain carries it, and the server records it on receipt;
 * - `approvalPosture` / `approvalPostureSequence`: the latest recorded
 *   decision and its server global sequence, folded from the stream (and
 *   from this client's own command result);
 * - `lastAppliedApprovalMode` / `approvalEscalationRejected`: what the
 *   engine reports it applied, for an honest chip.
 *
 * Nothing here decides what the engine runs; the server does.
 */
export interface SessionApprovalOverride {
  mode: ApprovalMode;
  /**
   * - `requested`: queued, or recorded and not yet reported applied; the
   *   next turn start applies it, on every send path.
   * - `refused`: a recorded full access the engine refused because the
   *   session was not spawned with it (Claude); it needs a session restart.
   * - `confirmed`: the engine's latest report shows it applied.
   */
  state: 'requested' | 'refused' | 'confirmed';
}

/** The approval-posture fields of a chat (#2436). */
export interface ApprovalPostureState {
  /** A pick the server has not received yet. A Default pick is a decision too. */
  queuedApprovalMode?: ApprovalMode;
  /** The latest recorded decision this client has folded. */
  approvalPosture?: ApprovalMode;
  /** Its server global sequence; absent when only this client's send vouches for it. */
  approvalPostureSequence?: number;
  lastAppliedApprovalMode?: ApprovalMode;
  /** The engine refused the recorded full access on its latest turn. */
  approvalEscalationRejected?: boolean;
}

/**
 * What the composer chip shows as the session's override: the queued pick,
 * else a concrete recorded posture. A recorded Default is no override: the
 * chip shows the defaults and what the engine reports it applied.
 */
export function sessionApprovalOverride(
  chat: ApprovalPostureState | null | undefined,
): SessionApprovalOverride | undefined {
  if (!chat) return undefined;
  if (isApprovalMode(chat.queuedApprovalMode)) {
    return chat.queuedApprovalMode === 'connection-default'
      ? undefined
      : { mode: chat.queuedApprovalMode, state: 'requested' };
  }
  const posture = chat.approvalPosture;
  if (!isApprovalMode(posture) || posture === 'connection-default')
    return undefined;
  if (chat.lastAppliedApprovalMode === posture)
    return { mode: posture, state: 'confirmed' };
  return {
    mode: posture,
    state:
      posture === 'never' && chat.approvalEscalationRejected
        ? 'refused'
        : 'requested',
  };
}

/**
 * The chat update for a new pick: it is queued until the server has it.
 * `undefined` when that exact pick is already queued. A pick equal to the
 * recorded posture is still a decision (a re-pick another device must see
 * ordered), so it is queued and sent like any other.
 */
export function approvalPickUpdate(
  chat: ApprovalPostureState | null | undefined,
  mode: ApprovalMode,
): Partial<ApprovalPostureState> | undefined {
  if (chat?.queuedApprovalMode === mode) return undefined;
  return { queuedApprovalMode: mode };
}

/**
 * Fold a recorded decision at server `sequence`. The latest by sequence wins;
 * a value with no known sequence (this client's own accepted send) replaces
 * the current one and is itself replaced by the next recorded event.
 */
export function foldApprovalPosture(
  chat: ApprovalPostureState | null | undefined,
  approvalMode: unknown,
  sequence?: number,
): Partial<ApprovalPostureState> {
  if (!isApprovalMode(approvalMode)) return {};
  const current = chat?.approvalPostureSequence;
  if (sequence !== undefined && current !== undefined && sequence <= current)
    return {};
  return {
    approvalPosture: approvalMode,
    approvalPostureSequence: sequence,
  };
}

/**
 * The update once the server has answered a pick (the `setApprovalMode`
 * command's result, or the result a send that carried it reports): the
 * standing decision is folded, and the queued pick is cleared — either it
 * was recorded, or a newer decision it had not seen stands instead
 * (compare-and-set, `recorded: false`). A pick made after this one was sent
 * stays queued.
 */
export function approvalPickReceived(
  chat: ApprovalPostureState | null | undefined,
  sent: ApprovalMode,
  result: { approvalMode: ApprovalMode; sequence: number },
): Partial<ApprovalPostureState> {
  return {
    ...foldApprovalPosture(chat, result.approvalMode, result.sequence),
    ...(chat?.queuedApprovalMode === sent
      ? { queuedApprovalMode: undefined }
      : {}),
  };
}

/**
 * Whether `error` is the server's refusal of full access to a caller that is
 * neither the operator in person nor a device granted it (#2436).
 */
export function isFullAccessRefusal(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE
  );
}

export const fullAccessRefusalNote =
  "Full access was not applied: this device is not allowed to give an agent full access. The Station's operator can allow it from this device's access settings.";

/** The note a pick dropped by compare-and-set earns in the chat. */
export function supersededPickNote(standing: ApprovalMode): string {
  return `Your approval pick was not applied: another device had already set it to **${approvalModeLabel(standing)}**.`;
}

/**
 * #2436 migration: a pick persisted by `main` (an `approvalMode` inside the
 * model-options bags) or by the unreleased #2449 branch (`pendingApprovalMode`
 * / `approvalModeOverride`) becomes a queued pick, so the server records it on
 * the next send. A persisted full access is dropped in every form (pending,
 * confirmed, or in a bag `main` resent every turn) rather than re-escalated
 * from stale state.
 */
export function migratedApprovalPick(persisted: {
  pendingApprovalMode?: unknown;
  approvalModeOverride?: unknown;
  requestedProviderOptions?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}): ApprovalMode | undefined {
  // Even an unsent pending full access is dropped: re-escalating from state
  // persisted before a reload is never what a later reader expects, and a
  // pick of full access now needs an authority the old build never checked.
  if (isApprovalMode(persisted.pendingApprovalMode))
    return persisted.pendingApprovalMode === 'ask' ||
      persisted.pendingApprovalMode === 'auto'
      ? persisted.pendingApprovalMode
      : undefined;
  const confirmed = isApprovalMode(persisted.approvalModeOverride)
    ? persisted.approvalModeOverride
    : (persisted.requestedProviderOptions ?? persisted.providerOptions)
        ?.approvalMode;
  return confirmed === 'ask' || confirmed === 'auto' ? confirmed : undefined;
}

/** `bag` without a legacy `approvalMode`; the same reference when it has none. */
export function withoutLegacyApprovalMode(
  bag: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!bag || !('approvalMode' in bag)) return bag;
  const { approvalMode: _dropped, ...rest } = bag;
  return rest;
}
