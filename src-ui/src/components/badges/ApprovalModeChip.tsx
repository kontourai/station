import {
  type ToolPolicyDelivery,
  toolPolicyDeliveryExplanation,
  toolPolicyDeliveryLabel,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { isApprovalMode } from '@kontourai/station-contracts/provider';
import { useRef, useState } from 'react';
import {
  APPROVAL_MODE_UNMANAGED_CHIP_LABEL,
  APPROVAL_MODE_UNMANAGED_EXPLANATION,
  type ApprovalMode,
  approvalModeChipLabel,
  approvalModeKnobSupported,
  approvalModeLabel,
  resolveEffectiveApprovalMode,
} from '../../utils/approvalMode';
import { LazyBoundary } from '../LazyBoundary';
import '../chat/chat.css';

/**
 * The picker is an overlay behind a tap — nothing about first paint needs it, so
 * it stays out of the entry chunk (the same reason App.tsx lazy-loads its own
 * overlays). The entry bundle is held to a tight budget by
 * scripts/ui-bundle-budget.mjs, whose last change *reclaimed* headroom rather
 * than granting it.
 */
const loadComposerModeSheet = () =>
  import('./ComposerModeSheet').then((module) => ({
    default: module.ComposerModeSheet,
  }));

export interface ApprovalModeChipProps {
  /** The session's clean engine-connection identity (for example `codex`). */
  engineConnectionId?: string | null;
  /**
   * Resolved from the bound connection's authoritative engine capability
   * matrix. Undefined is intentionally distinct from `unsupported`: this
   * surface must not invent coverage when its caller has no engine context.
   */
  toolPolicyDelivery?: ToolPolicyDelivery;
  /** Raw session override value, typically `providerOptions.approvalMode`. */
  sessionOverride?: unknown;
  /** The Agent app connection's configured default, if any. */
  connectionDefault?: unknown;
  /**
   * The mode the adapter last confirmed as actually applied (from
   * `session.configured` / `turn.started` metadata — see
   * ChatUIState.lastAppliedApprovalMode). Used only to detect "confirmed
   * client-side but not yet applied server-side" for 'never' (archive#727
   *).
   */
  lastAppliedApprovalMode?: unknown;
  onChange: (mode: ApprovalMode) => void;
}

/**
 * Composer control for a session's approval posture (archive#727). Shows the
 * EFFECTIVE mode — a session override wins over the connection's default,
 * which wins over the adapter's own built-in default.
 *
 * For an engine whose adapter exposes no native knob (ACP connections and any
 * plugin-contributed connected runtime; Ollama/Bedrock/the Station engine never
 * reach this component at all, because ChatInputArea only renders it for
 * `executionMode === 'external'`) it renders an inert "Set by engine" note rather
 * than a resolved mode — see APPROVAL_MODE_UNMANAGED_CHIP_LABEL for why
 * resolving one there was actively wrong (archive#1010).
 *
 * The pill shows a SHORT label (`approvalModeChipLabel`); the full descriptive
 * label lives on `aria-label`/`title` (archive#1010).
 *
 * Escalating TO 'never' (full access) requires a second confirming click
 * (archive#727) — backing out of that confirm, or dismissing the sheet,
 * leaves the session's mode untouched. Downgrades and every other selection
 * apply immediately. The confirm step now lives inside `ComposerModeSheet`.
 *
 * Once confirmed, the override applies optimistically client-side but the
 * live adapter only evaluates it starting with the next turn (and Claude's
 * 'never' may even be rejected outright if the process wasn't spawned with
 * the required flag — see claude-adapter.ts). While the override says
 * 'never' but the adapter hasn't confirmed it yet, the chip shows a
 * distinct pending state rather than overclaiming (archive#727 3,
 *). Render callers MUST remount this component (e.g. `key={sessionId}`)
 * when the active session changes — its local confirm state is not reset by
 * prop changes alone (archive#727 3).
 */
export function ApprovalModeChip({
  engineConnectionId,
  toolPolicyDelivery,
  sessionOverride,
  connectionDefault,
  lastAppliedApprovalMode,
  onChange,
}: ApprovalModeChipProps) {
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const supported = approvalModeKnobSupported(engineConnectionId);
  const policyLabel = toolPolicyDeliveryLabel(toolPolicyDelivery);
  const policyExplanation = toolPolicyDeliveryExplanation(toolPolicyDelivery);
  const policyDisclosure = `${policyLabel}. ${policyExplanation}`;

  if (!supported) {
    // Deliberately NOT `resolveEffectiveApprovalMode` (archive#1010): this
    // engine's adapter never reads `approvalMode`, so resolving one produced a
    // posture claim nothing honoured. Kept visible rather than hidden because
    // approvals are a security-relevant surface — an absent chip is
    // indistinguishable from a chip that failed to render, and a user deciding
    // whether to let an engine run unattended needs to be told that Station is
    // not the thing governing it. It renders inert-looking and is not a button,
    // so there is no target inviting a click that does nothing.
    return (
      <span
        className="chat-input__approval-chip chat-input__approval-chip--readonly"
        role="note"
        aria-label={`Engine approval mode: ${APPROVAL_MODE_UNMANAGED_EXPLANATION}. ${policyDisclosure}`}
        title={`Engine approval mode: ${APPROVAL_MODE_UNMANAGED_EXPLANATION}. ${policyDisclosure}`}
      >
        <span className="chat-input__approval-chip-label">
          {APPROVAL_MODE_UNMANAGED_CHIP_LABEL}
        </span>
        {/* Hidden below the narrow breakpoint, not truncated: on a phone this
            second label ran off the edge and crowded out the model selector
            beside it (station#3151). Nothing is lost by hiding it — the full
            "Set by engine · <policy>" text is already the accessible name and
            the tooltip above, so assistive tech and hover still get all of
            it. The disclosure stays; only its visible projection narrows. */}
        <span aria-hidden="true" className="chat-input__approval-chip-policy">
          {' · '}
          {policyLabel}
        </span>
      </span>
    );
  }

  const effective = resolveEffectiveApprovalMode({
    engineConnectionId,
    sessionOverride,
    connectionDefault,
  });
  const isOverride = effective.source === 'session override';
  const appliedMode = isApprovalMode(lastAppliedApprovalMode)
    ? lastAppliedApprovalMode
    : undefined;
  const isPendingApply =
    isOverride && effective.mode === 'never' && appliedMode !== 'never';

  // Full text for assistive tech and hover; the pill itself shows the short
  // form so it stops clipping at 390px (archive#1010).
  const selectedLabel = isPendingApply
    ? `${approvalModeLabel('never')} — pending next turn`
    : effective.label;
  const chipText = isPendingApply
    ? `${approvalModeChipLabel('never')} · pending`
    : approvalModeChipLabel(effective.mode);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`chat-input__approval-chip ${
          isPendingApply
            ? 'chat-input__approval-chip--pending'
            : isOverride
              ? 'chat-input__approval-chip--override'
              : 'chat-input__approval-chip--default'
        }`}
        aria-haspopup="dialog"
        aria-expanded={isSheetOpen}
        /* The visible chip text must be contained in the accessible name
           (WCAG 2.5.3 Label in Name) or a speech-input user cannot activate it
           by what they see. The pending state's short form ("Full access ·
           pending") is not a substring of the long form, so it is composed in
           explicitly rather than replaced. */
        aria-label={
          isPendingApply
            ? `Approval mode: ${chipText} — takes effect next turn. Engine approval control. ${policyDisclosure}`
            : `Approval mode: ${selectedLabel}. Engine approval control. ${policyDisclosure}`
        }
        title={
          isPendingApply
            ? `Engine approval mode: Full access was confirmed but has not applied yet — it takes effect starting with your next message. ${policyDisclosure}`
            : `Engine approval mode for this session: ${selectedLabel}. ${policyDisclosure}`
        }
        onClick={() => setIsSheetOpen((open) => !open)}
      >
        <span className="chat-input__approval-chip-label" aria-hidden="true">
          {chipText}
        </span>
        <span className="chat-input__approval-chip-caret" aria-hidden="true">
          ⌄
        </span>
      </button>
      {isSheetOpen && (
        <LazyBoundary
          load={loadComposerModeSheet}
          componentProps={{
            triggerRef,
            effectiveMode: effective.mode,
            engineConnectionId,
            onClose: () => setIsSheetOpen(false),
            onSelect: onChange,
          }}
          pending={null}
        />
      )}
    </>
  );
}
