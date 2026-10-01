import type { ReactNode } from 'react';
import { ActionOverflowMenu, type OverflowAction } from './ActionOverflowMenu';
import './ActionRow.css';

export type { OverflowAction } from './ActionOverflowMenu';

/**
 * A row of actions that cannot grow past two labelled buttons (#3045).
 *
 * The owner's complaint was rows of five and six labelled buttons — a detail
 * header reading Duplicate · Export · Test · Remove · Save. The rule is two:
 * the action the row is for (`primary`) and at most one more (`secondary`).
 * Everything else is an `overflow` item behind one `⋯` menu.
 *
 * The cap is the SHAPE of the props, not a runtime check: there is no slot for
 * a third labelled button. `scripts/button-cap-ratchet.mjs` holds the same
 * line for rows that are not written with this component.
 *
 * With neither `primary` nor `secondary`, the overflow trigger carries a word
 * and IS the row's one labelled action; the scan counts it as one.
 *
 * Order on screen is secondary, primary, overflow — the primary action sits
 * where a row's last button has always been, and the menu trails it.
 */
export function ActionRow({
  primary,
  secondary,
  overflow = [],
  overflowLabel,
  label,
  className,
}: {
  /** The action this row exists for. One element. */
  primary?: ReactNode;
  /** At most one more labelled action. One element. */
  secondary?: ReactNode;
  /** Everything else. Danger items are moved last, behind a separator. */
  overflow?: readonly OverflowAction[];
  /**
   * Names the `⋯` trigger and its menu ("More skill actions"). Required even
   * when `overflow` is empty today, so adding the first item cannot ship a
   * trigger with no accessible name.
   *
   * When the row has NO labelled action of its own (a card in a state that
   * recommends nothing), the trigger shows this label's FIRST WORD beside the
   * glyph — "Manage ⋯" for "Manage Kiro CLI", "More ⋯" for "More actions for
   * Studio Mac". A lone glyph does not say there is anything behind it, and
   * taking the word from the name keeps the name one clean phrase that begins
   * with what is shown.
   */
  overflowLabel: string;
  /** Names the row as a group for assistive technology, when it needs one. */
  label?: string;
  className?: string;
}) {
  if (!primary && !secondary && overflow.length === 0) return null;
  return (
    <div
      className={className ? `action-row ${className}` : 'action-row'}
      {...(label ? { role: 'group', 'aria-label': label } : {})}
    >
      {secondary}
      {primary}
      <ActionOverflowMenu
        actions={overflow}
        label={overflowLabel}
        {...(!primary && !secondary
          ? { triggerText: overflowLabel.trim().split(/\s+/)[0] }
          : {})}
      />
    </div>
  );
}
