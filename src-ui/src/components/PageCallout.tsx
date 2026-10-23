/**
 * PageCallout — the one page-scoped callout (#1582 C4).
 *
 * WHAT IT REPLACES. Three cards that said the same kind of thing in three
 * visual systems: Home's `first-run-home-card` (neutral border, accent
 * button), Home's `starter-work-card` (a different neutral border, different
 * radius, different padding) and the project page's inline "New here?" card
 * (accent border, a bespoke accent button that was not `Button` at all).
 * Same voice now, and one place to change it.
 *
 * Callouts use the shared tone vocabulary and root --tone-border-* tokens.
 * They scroll with their owning page and disappear when that view unmounts.
 */

import type { ReactNode } from 'react';
import type { BannerTone } from '../contexts/banner-store';
import './PageCallout.css';

/**
 * The banner scale, verbatim. A page callout that invented its own would be
 * a second vocabulary for the same idea, and the two would diverge the first
 * time either was extended.
 */
type PageCalloutTone = BannerTone;

interface PageCalloutProps {
  /**
   * Identifies the callout, not the instance. It is what makes a stack
   * dedupable: two surfaces that both decide to offer the same thing render
   * it once. Also emitted as `data-callout-id` so a journey can name what it
   * is looking at without reaching for a class.
   */
  calloutId: string;
  tone?: PageCalloutTone;
  /** The one line that says what this is. Optional for a single-sentence callout. */
  title?: ReactNode;
  /** The callout's own copy. */
  children?: ReactNode;
  /** The control it offers, if it offers one. */
  action?: ReactNode;
  /** Names the region. Required, because a callout is a landmark with no heading. */
  ariaLabel: string;
  /**
   * A live-region role, when the callout is an ANSWER to something the reader
   * just did rather than page furniture they can find at their leisure.
   *
   * `alert` (assertive) is the one to reach for when the callout is MOUNTED by
   * the action — a polite `status` region that is inserted already containing
   * its text is not reliably announced, so the reader who cannot see it gets
   * nothing (#1596). `status` is for a region that is already in the tree and
   * whose text changes, where politeness is what stops it interrupting.
   */
  role?: 'status' | 'alert';
  /**
   * The callout is waiting on something and renders a skeleton in place of
   * its copy. ONE prop: it sets `aria-busy` AND the `--busy` modifier the
   * skeleton's flex sizing hangs off, so a caller can never announce a busy
   * state without the layout that makes it legible (or the reverse). It was
   * briefly both this prop and a hand-passed class name.
   */
  busy?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function PageCallout({
  calloutId,
  tone = 'info',
  title,
  children,
  action,
  ariaLabel,
  role,
  busy,
  className,
  'data-testid': testId,
}: PageCalloutProps) {
  return (
    // A <p>, not a heading: a callout can render ABOVE its page's own <h1>,
    // and a heading there either outranks the page title or lands out of
    // order. `aria-label` gives the region its name without inventing a
    // level. (Carried over from `first-run-home-card`, which learned it.)
    <section
      className={[
        `page-callout page-callout--${tone}`,
        busy && 'page-callout--busy',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-callout-id={calloutId}
      aria-label={ariaLabel}
      {...(role ? { role } : {})}
      {...(busy ? { 'aria-busy': 'true' as const } : {})}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <div className="page-callout__text">
        {title ? <p className="page-callout__title">{title}</p> : null}
        {children ? <div className="page-callout__body">{children}</div> : null}
      </div>
      {action ? <div className="page-callout__action">{action}</div> : null}
    </section>
  );
}

/**
 * The identity a stack dedupes on, or `null` for a child that is not a
 * `PageCallout` (a wrapper component that renders one, a fragment, `null`).
 *
 * Deliberately structural rather than a registry of mounted instances: a
 * mount-time registry has to decide in an effect, which means both copies
 * paint for a frame before one disappears, and a component that renders a
 * callout conditionally would keep claiming the id after it stopped showing
 * it. Reading the id off the elements a stack was actually handed is
 * decided during render, is pure, and cannot get out of step with what is
 * on screen.
 */
function calloutIdOf(child: unknown): string | null {
  if (typeof child !== 'object' || child === null) return null;
  const element = child as { type?: unknown; props?: { calloutId?: unknown } };
  if (element.type !== PageCallout) return null;
  return typeof element.props?.calloutId === 'string'
    ? element.props.calloutId
    : null;
}

/**
 * Drops every `PageCallout` after the first that carries a given
 * `calloutId`. Children that are not callouts pass through untouched — a
 * stack holds whatever the page puts in it, and only the callouts it can
 * identify are deduped.
 */
function dedupePageCallouts(children: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const kept: unknown[] = [];
  for (const child of children) {
    const id = calloutIdOf(child);
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    kept.push(child);
  }
  return kept;
}

/**
 * Stacks page callouts with one rhythm. The gap lives here rather than on
 * each callout so a page that shows one and a page that shows three read the
 * same, and so a callout can never contribute trailing space on a page where
 * it is the only thing.
 */
export function PageCalloutStack({ children }: { children?: ReactNode }) {
  const list = Array.isArray(children) ? children : [children];
  // Always rendered, even when every child resolves to nothing: whether a
  // child COMPONENT will render a callout is not knowable here, and a guess
  // either way would be a claim about someone else's render. `:empty` in the
  // stylesheet is what withholds the spacing, and it reads the DOM rather
  // than this element list, so it cannot be wrong.
  return (
    <div className="page-callout-stack">
      {dedupePageCallouts(list) as ReactNode[]}
    </div>
  );
}
