import {
  type ToolPolicyDelivery,
  toolPolicyDeliveryExplanation,
  toolPolicyDeliveryLabel,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { isApprovalMode } from '@kontourai/station-contracts/provider';
import { useRef, useState } from 'react';
import {
  type ApprovalMode,
  approvalModeChipLabel,
  approvalModeKnobSupported,
  approvalModeLabel,
  resolveEffectiveApprovalMode,
} from '../../utils/approvalMode';
import { ArrowDownGlyph } from '../icons/Glyph';
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

interface ApprovalModeChipProps {
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
   * client-side but not yet applied server-side" for 'never' (archive#727).
   * It is not the chip's displayed value — a newer session override is
   * (station#1933).
   */
  lastAppliedApprovalMode?: unknown;
  onChange: (mode: ApprovalMode) => void;
}

/**
 * Composer control for a session's approval posture (archive#727). Shows the
 * EFFECTIVE mode — a session override wins over the connection's default,
 * which wins over the adapter's own built-in default.
 *
 * For an engine whose adapter exposes no native knob (ACP, Muse, and any
 * plugin-contributed connected runtime) this component renders nothing.
 * A long inert "Set by engine" pill crowded the mobile composer without
 * giving the user a control (station#1933). Claiming a resolved mode there
 * was worse (archive#1010); omitting the chip is the remaining honest
 * option until that engine grows a mapping. ChatInputArea also skips the
 * mount for `executionMode !== 'external'`.
 *
 * The pill shows a SHORT label (`approvalModeChipLabel`); the full descriptive
 * label lives on `aria-label`/`title` (archive#1010).
 *
 * Escalating TO 'never' (full access) requires a second confirming click
 * (archive#727) — backing out of that confirm, or dismissing the sheet,
 * leaves the session's mode untouched. Downgrades and every other selection
 * apply immediately. The confirm step now lives inside `ComposerModeSheet`.
 *
 * Once confirmed, the override applies optimistically client-side — the
 * chip and picker follow the requested/effective mode immediately so a
 * pick is not indistinguishable from a no-op (station#1933) — but the
 * live adapter only evaluates it starting with the next turn (and Claude's
 * 'never' may even be rejected outright if the process wasn't spawned with
 * the required flag — see claude-adapter.ts). While the override says
 * 'never' but the adapter hasn't confirmed it yet, the chip shows
 * "Full access · pending" rather than the prior receipt (archive#727).
 * Render callers MUST remount this component (e.g. `key={sessionId}`)
 * when the active session changes — its local confirm state is not reset by
 * prop changes alone (archive#727).
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
  if (!approvalModeKnobSupported(engineConnectionId)) {
    return null;
  }
  const policyLabel = toolPolicyDeliveryLabel(toolPolicyDelivery);
  const policyExplanation = toolPolicyDeliveryExplanation(toolPolicyDelivery);
  const policyDisclosure = `${policyLabel}. ${policyExplanation}`;

  const effective = resolveEffectiveApprovalMode({
    engineConnectionId,
    sessionOverride,
    connectionDefault,
  });
  const appliedMode = isApprovalMode(lastAppliedApprovalMode)
    ? lastAppliedApprovalMode
    : undefined;
  // The chip follows the next-turn request. lastApplied is only the
  // pending-never detector: showing the receipt over a newer pick made the
  // control look dead after session.configured (station#1933).
  const displayedMode = effective.mode;
  const isOverride = effective.source === 'session override';
  const isPendingApply =
    isOverride && effective.mode === 'never' && appliedMode !== 'never';

  // Full text for assistive tech and hover; the pill itself shows the short
  // form so it stops clipping at 390px (archive#1010).
  const selectedLabel = isPendingApply
    ? `${approvalModeLabel('never')} — full access requested for the next turn`
    : effective.label;
  const chipText = isPendingApply
    ? `${approvalModeChipLabel('never')} · pending`
    : approvalModeChipLabel(displayedMode);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`choice-trigger chat-input__approval-chip ${
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
        <ArrowDownGlyph className="choice-caret" />
      </button>
      {isSheetOpen && (
        <LazyBoundary
          load={loadComposerModeSheet}
          componentProps={{
            triggerRef,
            effectiveMode: displayedMode,
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
