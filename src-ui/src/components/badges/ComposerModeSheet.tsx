import type { ReactNode, RefObject } from 'react';
import { useState } from 'react';
import {
  APPROVAL_MODE_OPTIONS,
  type ApprovalMode,
  approvalModeDescription,
} from '../../utils/approvalMode';
import { EngineGlyph, HandGlyph, ReturnGlyph } from '../icons/Glyph';
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
  /** The resolved effective mode this session is running under. */
  effectiveMode: ApprovalMode;
  engineConnectionId?: string | null;
  onClose: () => void;
  onSelect: (mode: ApprovalMode) => void;
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
 */
export function ComposerModeSheet({
  triggerRef,
  effectiveMode,
  engineConnectionId,
  onClose,
  onSelect,
}: ComposerModeSheetProps) {
  const [pendingEscalation, setPendingEscalation] = useState(false);

  const choose = (mode: ApprovalMode) => {
    if (mode === 'never' && effectiveMode !== 'never') {
      setPendingEscalation(true);
      return;
    }
    onSelect(mode);
    onClose();
  };

  return (
    <ResponsiveDialogSurface
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
                onSelect('never');
                onClose();
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
          {APPROVAL_MODE_OPTIONS.map((option) => {
            const isSelected = option.value === effectiveMode;
            return (
              <label
                key={option.value}
                className="composer-actions-menu__item composer-mode-sheet__option"
              >
                <input
                  type="radio"
                  name="composer-mode-sheet-option"
                  value={option.value}
                  checked={isSelected}
                  aria-checked={isSelected}
                  className="composer-mode-sheet__option-input"
                  // Native radio semantics (real element per the a11y rule
                  // biome's `useSemanticElements` names, replacing the prior
                  // `role="radio"` button) give keyboard/screen-reader users a
                  // genuine radio group for free. `onChange` covers a real
                  // selection change (click on a different option, or arrow-key
                  // navigation); `onClick` preserves the pre-existing behavior
                  // of re-clicking the ALREADY-selected option still calling
                  // `choose` (browsers don't fire `change` when the checked
                  // state doesn't transition, but `click` always fires) — see
                  // ApprovalModeChip.test.tsx's "re-affirming an already-never
                  // mode" case.
                  onChange={() => choose(option.value)}
                  onClick={() => choose(option.value)}
                />
                <span
                  className="composer-mode-sheet__option-glyph"
                  aria-hidden="true"
                >
                  {MODE_GLYPH[option.value]}
                </span>
                <span className="composer-mode-sheet__option-body">
                  <strong>{option.label}</strong>
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
