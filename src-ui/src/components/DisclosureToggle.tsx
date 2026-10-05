import type { ReactNode } from 'react';
import { ArrowDownGlyph } from './icons/Glyph';
import './DisclosureToggle.css';

/**
 * THE one disclosure affordance for a folded section of a list (design
 * round 2026-10, C13): a caret on the left of the label that rotates, on a
 * quiet button carrying `aria-expanded`. The dock's "+ Snoozed · 3", Home's
 * native `<details>` triangle for Drafts and its custom "+ Snoozed" button,
 * and the sidebar's "+"/"−" text glyphs were four spellings of one control.
 *
 * Only the affordance is shared: what the section contains, where its
 * expanded state lives (component state, a device setting) and which
 * heading id it carries stay with the host.
 */
export function DisclosureToggle({
  expanded,
  onToggle,
  children,
  id,
  className,
  controls,
}: {
  expanded: boolean;
  onToggle: () => void;
  /** The label: the section's name, with its count where the host shows one. */
  children: ReactNode;
  id?: string;
  className?: string;
  /** The id of the region this toggles, when the host renders one. */
  controls?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      className={
        className ? `disclosure-toggle ${className}` : 'disclosure-toggle'
      }
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      <ArrowDownGlyph className="disclosure-toggle__caret" />
      <span className="disclosure-toggle__label">{children}</span>
    </button>
  );
}
