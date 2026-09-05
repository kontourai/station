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
 * The adapter's own built-in posture when nothing overrides it — what a
 * brand-new, untouched connection actually does today. This is what the
 * chip resolves to (not the `'connection-default'` sentinel) so an
 * untouched Codex connection reads as full-access/never-ask at a glance,
 * per archive#727.
 */
export function adapterDefaultApprovalMode(
  engineId?: string | null,
): ApprovalMode | undefined {
  if (engineId === 'codex') return 'never';
  if (engineId === 'claude') return 'ask';
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
    // approval. `settingSources: ['user']` (claude-adapter.ts) is what makes
    // "user-level" true — a workspace's checked-in `.claude/settings.json` no
    // longer applies.
    claude:
      "Claude asks before tool calls its own rules don't already allow; only your user-level Claude settings apply.",
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

/**
 * What the chip says for an engine whose adapter reads no `approvalMode` at
 * all (archive#1010).
 *
 * This is deliberately a *capability* statement, not a mode. The old read-only
 * chip ran the same `resolveEffectiveApprovalMode` resolution as a
 * knob-supporting engine, which made it assert a posture the engine provably
 * cannot honour: `config.approvalMode` is a generic connection-config bag field
 * with no server-side gate, so a no-knob connection carrying it rendered e.g.
 * "Ask first — default" while the adapter ignored the value entirely.
 * Reporting a governing approval mode that nothing governs is worse than
 * reporting nothing.
 */
/*
 * "Set by engine", not "Not managed" (archive#1010). ACP connections — the main
 * population that reaches this chip — DO manage approvals: `acp-adapter.ts`
 * implements the interactive `session/request_permission` handshake, and Station
 * itself surfaces those prompts. What is missing is Station's ability to set the
 * *policy*, not the existence of approvals. "Not managed" said the opposite, and
 * on touch the pill is all a user gets — the explanation below is hover and
 * screen-reader only, so the two words have to be true on their own.
 */
export const APPROVAL_MODE_UNMANAGED_CHIP_LABEL = 'Set by engine';

export const APPROVAL_MODE_UNMANAGED_EXPLANATION =
  'Station cannot set approvals for this engine — the engine decides when to ask.';

export type ApprovalModeSource =
  | 'session override'
  | 'connection default'
  | 'adapter default';

export interface EffectiveApprovalMode {
  mode: ApprovalMode;
  label: string;
  source: ApprovalModeSource;
}

/**
 * The effective approval mode for a session, in priority order: a concrete
 * session override, then the engine connection's configured default,
 * then the adapter's own built-in default. `'connection-default'` is only
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
}: {
  engineConnectionId?: string | null;
  sessionOverride?: unknown;
  connectionDefault?: unknown;
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
