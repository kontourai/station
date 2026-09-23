import {
  type ApprovalMode,
  isApprovalMode,
} from '@kontourai/station-contracts/provider';
import {
  EXECUTION_MODE,
  type ExecutionMode,
} from '@kontourai/station-contracts/tool';

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
  | 'connection default'
  | 'station default'
  | 'adapter default';

interface EffectiveApprovalMode {
  mode: ApprovalMode;
  label: string;
  source: ApprovalModeSource;
}

/**
 * The effective approval mode for a session, in priority order: a concrete
 * session override, then the engine connection's configured default, then
 * this Station's `AppConfig.defaultApprovalMode` (#2144 slice 6), then the
 * adapter's own built-in default. `'connection-default'` is only
 * ever a *selectable* value meaning "clear my override" — it is never
 * itself displayed as a resolved posture when a concrete adapter default
 * is known (archive#727).
 *
 * When the resolution did NOT come from an explicit session override, the
 * label is suffixed with "— default" so the two are visually
 * distinguishable in the chip.
 */
export function resolveEffectiveApprovalMode({
  engineConnectionId,
  sessionOverride,
  connectionDefault,
  stationDefault,
}: {
  engineConnectionId?: string | null;
  sessionOverride?: unknown;
  connectionDefault?: unknown;
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

  const connDefault =
    isApprovalMode(connectionDefault) &&
    connectionDefault !== 'connection-default'
      ? connectionDefault
      : undefined;
  if (connDefault) {
    return {
      mode: connDefault,
      label: `${approvalModeLabel(connDefault)} — default`,
      source: 'connection default',
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
 * The approval mode this send must put ON THE WIRE, or `undefined` for "send
 * nothing and let the engine keep whatever it already does".
 *
 * `resolveEffectiveApprovalMode` answers what to DISPLAY. This answers what
 * to ENFORCE, and the two have to agree or the chip narrates a posture
 * nothing applies (#2144 slice 6 fix round 1: both the Station default and
 * the connection default were display-only — the only value that reached
 * `modelOptions.approvalMode`, which is the single thing the server reads
 * (`readApprovalMode`, provider.ts), was the session override).
 *
 * Returns `undefined` when:
 * - the engine's adapter has no approval knob (`approvalModeKnobSupported`) —
 *   sending a posture there would be a request nothing can honour;
 * - the chat does not run in `external` execution mode. A provider-managed
 *   Station-mode chat keeps a knob-capable `agentConnectionId` (its model
 *   provider), and `ChatInputArea` renders no approval control for it, so a
 *   posture on the wire would be one no surface offered (round 2 M2);
 * - this chat's session is LIVE (`chatSessionIsLive`, utils/execution.ts —
 *   round 3 F1 replaced "an id exists" with a liveness derivation, because a
 *   `currentSessionId` outlives its session and a reopened conversation is
 *   marked started while merely continuable). The default is the posture a
 *   session STARTS in: re-requesting it on a warm session would let a
 *   mid-life edit of the Station setting reconfigure a running chat, and
 *   Claude refuses an escalation to `'never'` on a session that was not
 *   spawned with its bypass flag — with a `runtime.warning` banner on every
 *   later turn (claude-adapter.ts). A session override is the only thing
 *   that may change a live session's posture, and it travels on its own
 *   (round 2 M3). The queued-follow-up drain (`queueDrain.ts`) passes no
 *   fallback at all and is deliberately left that way: a queued message is
 *   never the message that starts a session;
 * - the resolution came from that session override, which the dispatcher
 *   already carries as `approvalModeOverride` (#2334);
 * - nothing concrete resolved (`'connection-default'`), which is Station
 *   deliberately stating no posture.
 */
export function approvalModeForDispatch(input: {
  engineConnectionId?: string | null;
  /** The chat's execution mode; only `external` reaches an engine adapter. */
  executionMode?: ExecutionMode;
  /**
   * Whether this chat already has a live orchestration session. `true`
   * suppresses the fold entirely — see above.
   */
  sessionAlreadyStarted?: boolean;
  sessionOverride?: unknown;
  connectionDefault?: unknown;
  stationDefault?: unknown;
}): ApprovalMode | undefined {
  if (input.executionMode !== EXECUTION_MODE.EXTERNAL) return undefined;
  if (input.sessionAlreadyStarted) return undefined;
  if (!approvalModeKnobSupported(input.engineConnectionId)) return undefined;
  const resolved = resolveEffectiveApprovalMode(input);
  if (resolved.source === 'session override') return undefined;
  if (resolved.mode === 'connection-default') return undefined;
  return resolved.mode;
}

/**
 * A session approval override as the composer holds it (#2334): the user's
 * pick, and whether the engine has confirmed applying it yet.
 */
export interface SessionApprovalOverride {
  mode: ApprovalMode;
  /** True until a report's applied mode matches (`settleApprovalPick`). */
  pending: boolean;
}

/**
 * The approval-pick fields of a chat. They live OUTSIDE the model-options
 * request bag (#2334): that bag is cleared whenever a report acknowledges the
 * requested model, and every reader treats `requested ?? confirmed` as the
 * whole send, so an approval pick stored inside it was either discarded with
 * the bag or, when kept alone, displaced the model controls.
 */
export interface ApprovalPickState {
  /**
   * A pick the engine has not confirmed. Sent alongside the model options on
   * every turn until it settles. Never `'connection-default'`: clearing an
   * override has nothing for the engine to confirm, so it settles at once.
   */
  pendingApprovalMode?: ApprovalMode;
  /** A pick the engine has confirmed applying on this chat's session. */
  approvalModeOverride?: ApprovalMode;
  requestedProviderOptions?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}

/**
 * What the composer chip shows and the next send carries as the session
 * override: the pending pick, else the confirmed one. The last fallback is an
 * `approvalMode` already sitting in the options bag, which only chat state
 * persisted before #2334 still holds; the dispatcher sends that bag as-is, so
 * the chip has to name it too.
 */
export function sessionApprovalOverride(
  chat: ApprovalPickState | null | undefined,
): SessionApprovalOverride | undefined {
  if (!chat) return undefined;
  if (isApprovalMode(chat.pendingApprovalMode)) {
    return { mode: chat.pendingApprovalMode, pending: true };
  }
  if (isApprovalMode(chat.approvalModeOverride)) {
    return { mode: chat.approvalModeOverride, pending: false };
  }
  const legacy = (chat.requestedProviderOptions ?? chat.providerOptions)
    ?.approvalMode;
  return isApprovalMode(legacy) ? { mode: legacy, pending: false } : undefined;
}

/**
 * The chat update for a newly picked approval mode. A concrete pick waits
 * for the engine; `'connection-default'` clears the override immediately.
 * Any `approvalMode` left in either options bag by pre-#2334 state is
 * removed, so it can neither be resent nor outrank the pick.
 */
export function approvalPickUpdate(
  chat: ApprovalPickState | null | undefined,
  mode: ApprovalMode,
): Partial<ApprovalPickState> {
  const withoutLegacy = (
    bag: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined => {
    if (!bag || !('approvalMode' in bag)) return bag;
    const { approvalMode: _dropped, ...rest } = bag;
    return rest;
  };
  return {
    ...(chat?.requestedProviderOptions &&
    'approvalMode' in chat.requestedProviderOptions
      ? {
          requestedProviderOptions: withoutLegacy(
            chat.requestedProviderOptions,
          ),
        }
      : {}),
    ...(chat?.providerOptions && 'approvalMode' in chat.providerOptions
      ? { providerOptions: withoutLegacy(chat.providerOptions) }
      : {}),
    ...(mode === 'connection-default'
      ? { pendingApprovalMode: undefined, approvalModeOverride: undefined }
      : { pendingApprovalMode: mode }),
  };
}

/**
 * The chat update for an engine report of the mode actually applied
 * (`session.configured` / `turn.started` metadata).
 *
 * - A pending pick settles only when the report MATCHES it. A differing
 *   report may describe a turn sent before the pick (a stale report), so it
 *   neither drops the pick nor confirms it (#2334, refuted approach 2).
 * - With nothing pending, a report that disagrees with the confirmed pick
 *   moves it back to PENDING rather than dropping it: the report can be stale
 *   too, and dropping the pick would leave the session on whatever the report
 *   named (possibly looser). Pending, it is resent and re-confirmed, the same
 *   treatment a disagreeing report gets on the pending path.
 */
export function settleApprovalPick(
  chat: ApprovalPickState | null | undefined,
  applied: ApprovalMode | undefined,
): Partial<ApprovalPickState> {
  if (!chat || !applied) return {};
  if (chat.pendingApprovalMode !== undefined) {
    return chat.pendingApprovalMode === applied
      ? { pendingApprovalMode: undefined, approvalModeOverride: applied }
      : {};
  }
  if (
    chat.approvalModeOverride !== undefined &&
    chat.approvalModeOverride !== applied
  ) {
    return {
      approvalModeOverride: undefined,
      pendingApprovalMode: chat.approvalModeOverride,
    };
  }
  return {};
}
