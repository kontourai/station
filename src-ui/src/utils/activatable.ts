/**
 * The missing primitive behind ~150 `useKeyWithClickEvents` /
 * `noStaticElementInteractions` findings: a non-button element carrying an
 * `onClick` and nothing else. Mouse users can operate it; keyboard and screen
 * reader users cannot reach it at all — it has no role, no tab stop, and no
 * key handler.
 *
 * `<button>` remains the right answer for NEW code and needs none of this.
 * This exists for the existing surfaces, where the elements are load-bearing
 * for layout (`.app-toolbar__brand` alone is `display: none` in `index.css`
 * and `display: flex` in `chat.css` — a live cascade fight) and swapping the
 * tag silently changes rendering in ways no unit test observes. Adding the
 * affordances in place changes behaviour only where there was none.
 *
 * Keyboard semantics follow the native elements the roles imitate (this is
 * what screen reader users' muscle memory expects, per the ARIA authoring
 * practices — review finding, PR #1277 round 2):
 * - `role="button"`: Enter activates on keydown; Space activates on KEYUP,
 *   with the page-scroll default suppressed on keydown — native buttons
 *   depress on keydown and fire on keyup, and keyup also cannot auto-repeat,
 *   which is what stops a held Space from toggling state once per repeat.
 * - `role="link"`: Enter only. Space over a native link SCROLLS THE PAGE,
 *   and this primitive preserves that rather than hijacking it.
 * - Enter ignores `event.repeat`, so holding it activates once, like a
 *   native control.
 *
 * No new CSS is needed for the tab stop to be visible: the global rule at the
 * top of `index.css` already rings `[role="button"]`, `[role="link"]` and
 * `[tabindex]:not([tabindex="-1"])` on `:focus-visible`.
 */

import type { FocusEvent, KeyboardEvent, MouseEvent } from 'react';

export interface ActivatableOptions {
  /**
   * Announced role. `'button'` (default) performs an action in place;
   * `'link'` navigates. Screen reader users act on this distinction — it
   * changes both what is announced and which keys operate it (see the
   * header comment) — so pass `'link'` for real navigation; Station's
   * breadcrumbs are links.
   */
  role?: 'button' | 'link';
  /** Accessible name, when the element's own text is not descriptive. */
  label?: string;
}

/**
 * Props for an element that is genuinely activatable. Deliberately NOT
 * `Partial<>`-widened into the inert case below — the two shapes differ in
 * whether `tabIndex` exists at all, which is the whole point.
 */
export interface ActivatableProps {
  role: 'button' | 'link';
  tabIndex: 0;
  'aria-label'?: string;
  onClick: (event: MouseEvent<Element>) => void;
  onKeyDown: (event: KeyboardEvent<Element>) => void;
  onKeyUp: (event: KeyboardEvent<Element>) => void;
  onBlur: (event: FocusEvent<Element>) => void;
}

/**
 * The activation event, whichever way the user got here. Handlers that only
 * act need not declare it — a `() => void` is assignable — but handlers that
 * must `stopPropagation` do, and they must get it on BOTH paths. The chat
 * dock's project row is the case that forced this: the row is also the dock's
 * click-to-toggle surface, so an activation that does not stop propagation
 * selects the project AND collapses the dock. Passing the event only to
 * `onClick` would have fixed the mouse and shipped that bug to the keyboard.
 */
export type ActivateEvent = MouseEvent<Element> | KeyboardEvent<Element>;

/**
 * An element with no handler gets nothing — no role, no tab stop. A focusable
 * control that does nothing when activated is a worse outcome than static
 * text: it spends a tab stop and promises an action it will not perform.
 * Several call sites here are conditionally inert (a breadcrumb segment with
 * no route behind it), so this case is real, not defensive.
 */
export type InertProps = Record<string, never>;

/**
 * Which elements have a LIVE, unprevented Space press on them — press
 * provenance for the keyup activation below (round-2 review HIGH, PR #1277).
 * Without it, a bare keyup activates: press Space on control A, Tab away
 * while holding, release over control B, and B fires with no press of its
 * own; a keydown a nested handler prevented would likewise still activate on
 * release. Native buttons cancel in both cases, and muscle memory relies on
 * "focus away = cancel".
 *
 * Keyed by the DOM element (module-level, WeakSet so it can never leak),
 * NOT a closure inside `activatable()` — the returned handlers are recreated
 * on every render, so any per-call state would be silently reset by an
 * unrelated re-render landing between keydown and keyup, dropping real
 * activations.
 */
const spaceArmed = new WeakSet<Element>();

export function activatable(
  onActivate: ((event: ActivateEvent) => void) | undefined | null,
  options: ActivatableOptions = {},
): ActivatableProps | InertProps {
  if (!onActivate) return {};
  const role = options.role ?? 'button';
  return {
    role,
    tabIndex: 0,
    ...(options.label ? { 'aria-label': options.label } : {}),
    onClick: (event: MouseEvent<Element>) => onActivate(event),
    onKeyDown: (event: KeyboardEvent<Element>) => {
      // Something nested already handled this (a real button inside the
      // region, or a composed handler that consumed the key).
      if (event.defaultPrevented) return;
      if (event.key === 'Enter') {
        // A held Enter auto-repeats keydown; a native control activates once.
        if (event.repeat) return;
        // Enter can also submit an enclosing form — not what activation means.
        event.preventDefault();
        onActivate(event);
        return;
      }
      if (event.key === ' ' && role === 'button') {
        // Suppress page scroll now; activation happens on keyup below, where
        // auto-repeat cannot reach. Links deliberately fall through — Space
        // over a link scrolls, natively.
        event.preventDefault();
        spaceArmed.add(event.currentTarget);
      }
    },
    onKeyUp: (event: KeyboardEvent<Element>) => {
      if (event.key !== ' ' || role !== 'button') return;
      // Only a release matching a live press on THIS element activates —
      // an orphan keyup (focus arrived mid-hold, or the press was
      // prevented) is a cancel, not an activation.
      if (!spaceArmed.delete(event.currentTarget)) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      onActivate(event);
    },
    onBlur: (event) => {
      // Focus leaving mid-hold cancels the press (native behavior) — and
      // clears the entry so a LATER orphan keyup on this element cannot
      // consume a stale press.
      spaceArmed.delete(event.currentTarget);
    },
  };
}
