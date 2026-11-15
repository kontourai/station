import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import { Badge } from '@kontourai/ui/react';
import type { ReactNode, RefObject } from 'react';
import { useState } from 'react';
import { useAccountPreferences } from '../../contexts/AccountPreferencesContext';
import { useManagedApprovalCeiling } from '../../contexts/ManagedPolicyContext';
import {
  APPROVAL_MODE_OPTIONS,
  type ApprovalMode,
  approvalModeDescription,
} from '../../utils/approvalMode';
import { Button } from '../Button';
import {
  ConversationManagedPolicyProvider,
  useOptionalConversationConnection,
} from '../conversation/ConversationConnectionContext';
import { EngineGlyph, HandGlyph, ReturnGlyph } from '../icons/Glyph';
import { ManagedApprovalCeilingNote } from '../managed/ManagedApprovalCeilingNote';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';

/**
 * One glyph per approval posture, so the list is scannable before it is read.
 * The option's accessible name comes from its label and description, never
 * the aria-hidden glyph.
 */
const MODE_GLYPH: Record<ApprovalMode, ReactNode> = {
  'connection-default': <ReturnGlyph />,
  ask: <HandGlyph />,
  auto: '›_',
  never: <EngineGlyph />,
};

interface ComposerModeSheetProps {
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** The next-turn effective mode the picker treats as selected. */
  effectiveMode: ApprovalMode;
  engineConnectionId?: string | null;
  onClose: () => void;
  onSelect: (mode: ApprovalMode) => void;
  sourceNote?: string;
  /** Whether Station's own approvals reach this engine's tool calls. */
  policyNote?: string;
  pendingNote?: string;
  activeMode?: string;
  isNewSession?: boolean;
  /**
   * `dialog` when the trigger sits in a dialog (the dock's New chat), so the
   * picker opens above it, as that dialog's other menus do.
   */
  layer?: 'dialog' | 'popover';
}

/**
 * Approval-mode picker, shared by every viewport.
 *
 * This replaces the native `<select>` the chip used to render, which
 * docs/design/chat-composer.md §2 flagged as the composer's least legible
 * control despite being its highest-consequence one: an option list gives every
 * posture its own description, and a `radio`-role row is a real named control
 * for keyboard, screen-reader, and agent callers alike (§1). Copy stays in
 * Station's own approval-mode vocabulary (docs/glossary.md) — the owner-supplied
 * mobile reference informed the shape of this surface, not its wording.
 *
 * `ResponsiveDialogSurface` already resolves to a desktop popover and a mobile
 * bottom sheet from one implementation, so there is no per-platform fork here.
 *
 * Escalating to `never` (full access) still takes a second, explicit
 * confirmation (archive#727) — but as an inline confirm step inside the
 * sheet rather than a chip that silently rewrites itself into a confirm button.
 * Backing out of the confirm leaves the session's mode untouched.
 *
 * #4518: under the machine's managed approval ceiling, the modes above it are
 * disabled and the sheet says whose policy limits them. The server refuses
 * them whatever this shows; until the policy is read (or if it cannot be),
 * nothing is disabled and a pick above the ceiling comes back refused with
 * the same sentence.
 */
function ComposerModeSheetContent({
  triggerRef,
  effectiveMode,
  engineConnectionId,
  onClose,
  onSelect,
  sourceNote,
  policyNote,
  pendingNote,
  activeMode,
  isNewSession,
  layer = 'popover',
}: ComposerModeSheetProps) {
  const account = useAccountPreferences();
  const target = useOptionalConversationConnection();
  const personalDefaults =
    !target?.station ||
    target.station.capabilities.personalDefaults.state === 'allowed';
  const { aboveCeiling } = useManagedApprovalCeiling();
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const apply = (mode: ApprovalMode) => {
    if (
      personalDefaults &&
      saveAsDefault &&
      (engineConnectionId === 'codex' ||
        engineConnectionId === 'claude' ||
        engineConnectionId === 'muse')
    ) {
      account.save({
        interactiveApprovalModes: {
          [engineConnectionId]: mode === 'connection-default' ? null : mode,
        },
      });
    }
    onSelect(mode);
    onClose();
  };
  const [pendingEscalation, setPendingEscalation] = useState(false);

  const choose = (mode: ApprovalMode) => {
    if (aboveCeiling(mode)) return;
    if (mode === effectiveMode && !saveAsDefault) {
      onClose();
      return;
    }
    if (mode === 'never' && (effectiveMode !== 'never' || saveAsDefault)) {
      setPendingEscalation(true);
      return;
    }
    apply(mode);
  };

  return (
    <ResponsiveDialogSurface
      layer={layer}
      ariaLabel="Approval mode"
      onClose={onClose}
      historyMode="entry"
      returnFocusTarget={triggerRef.current}
      anchorRef={triggerRef}
      overlayClassName="composer-popover-overlay composer-popover-overlay--start"
      panelClassName="composer-popover-panel composer-mode-sheet"
    >
      <ResponsiveDialogHeader
        title="Approval mode"
        subtitle="How much this agent decides on its own"
        closeLabel="Close mode picker"
        onClose={onClose}
      />
      <div className="composer-mode-sheet__notes">
        <ManagedApprovalCeilingNote className="composer-mode-sheet__confirm-body" />
        <p className="composer-mode-sheet__confirm-body">{sourceNote}</p>
        {policyNote && (
          <p className="composer-mode-sheet__confirm-body">{policyNote}</p>
        )}
        <p className="composer-mode-sheet__confirm-body">
          {pendingNote?.includes('restart')
            ? 'Restart required'
            : isNewSession
              ? 'Applies on start'
              : 'Applies next turn'}
          {activeMode ? ` · Active: ${activeMode}` : ''}
        </p>
        {personalDefaults && account.status === 'account' && (
          <label className="composer-mode-sheet__confirm-body">
            <input
              type="checkbox"
              checked={saveAsDefault}
              onChange={(event) => setSaveAsDefault(event.target.checked)}
            />{' '}
            {/* #4390: the engine's product name, never its raw id. */}
            Save as my{' '}
            {(engineConnectionId
              ? engineDisplayLabel(engineConnectionId)
              : null) ?? 'engine'}{' '}
            default
          </label>
        )}
        {saveAsDefault && (
          <Button onClick={() => choose(effectiveMode)}>
            Save current mode as my default
          </Button>
        )}
      </div>

      {pendingEscalation ? (
        <div className="composer-mode-sheet__confirm" role="alertdialog">
          <p className="composer-mode-sheet__confirm-title">
            Turn on full access?
          </p>
          <p className="composer-mode-sheet__confirm-body">
            {approvalModeDescription('never', engineConnectionId)}
          </p>
          <div className="composer-mode-sheet__confirm-actions">
            <button
              type="button"
              className="composer-mode-sheet__confirm-cancel"
              onClick={() => setPendingEscalation(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="composer-mode-sheet__confirm-accept"
              onClick={() => {
                setPendingEscalation(false);
                apply('never');
              }}
            >
              Enable full access
            </button>
          </div>
        </div>
      ) : (
        <div
          className="composer-actions-menu__list"
          role="radiogroup"
          aria-label="Approval mode"
        >
          {APPROVAL_MODE_OPTIONS.filter(
            (option) =>
              option.value !== 'never' ||
              !target?.station ||
              target.station.capabilities.fullAccess.state === 'allowed',
          ).map((option) => {
            const isSelected = option.value === effectiveMode;
            const managed = aboveCeiling(option.value);
            return (
              <label
                key={option.value}
                className={`composer-actions-menu__item composer-mode-sheet__option${
                  managed ? ' composer-mode-sheet__option--managed' : ''
                }`}
              >
                <input
                  type="radio"
                  name="composer-mode-sheet-option"
                  value={option.value}
                  checked={isSelected}
                  aria-checked={isSelected}
                  disabled={managed}
                  className="composer-mode-sheet__option-input"
                  // Native change fires only for a real selection transition,
                  // suppressing duplicate/no-op mode events by construction.
                  onChange={() => choose(option.value)}
                />
                <span
                  className="composer-mode-sheet__option-glyph"
                  aria-hidden="true"
                >
                  {MODE_GLYPH[option.value]}
                </span>
                <span className="composer-mode-sheet__option-body">
                  <strong>
                    {option.label}
                    {/* The sentence above names whose policy; the badge only
                        marks which rows it covers (one fact per surface). */}
                    {managed ? (
                      <>
                        {' '}
                        <Badge value="Managed" tone="neutral" />
                      </>
                    ) : null}
                  </strong>
                  <small>
                    {approvalModeDescription(option.value, engineConnectionId)}
                  </small>
                </span>
                <span
                  className="composer-mode-sheet__option-mark"
                  aria-hidden="true"
                />
              </label>
            );
          })}
        </div>
      )}
    </ResponsiveDialogSurface>
  );
}

export function ComposerModeSheet(props: ComposerModeSheetProps) {
  return (
    <ConversationManagedPolicyProvider>
      <ComposerModeSheetContent {...props} />
    </ConversationManagedPolicyProvider>
  );
}
