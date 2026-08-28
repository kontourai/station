/**
 * Coachmark — one anchored first-run popover (archive#2652 chapter 3).
 *
 * Placement follows `InfoTip`'s proven approach (measure the anchor, clamp to a
 * viewport gutter, flip above/below, reposition on resize and capture-phase
 * scroll) but takes its anchor as a `data-first-run-anchor` selector on an
 * element the product already renders, instead of owning its own trigger.
 *
 * Accessibility, which a first-run surface has to get right because it is the
 * very first thing a keyboard or screen-reader user meets:
 * - `role="dialog"` + `aria-modal="false"` — it annotates the page rather than
 *   sealing it off, and the anchor stays visible behind it.
 * - Focus moves into the coachmark on mount, so each step is announced.
 * - Tab is trapped inside the card while it is open, so a keyboard user cannot
 *   fall out of the tour into the page behind it and lose their place.
 * - Escape ends the tour. It is bound on the card, not the document, so it
 *   cannot swallow Escape from a dialog opened over it.
 *
 * Return focus is NOT this component's job and is deliberately not done here:
 * the coachmark remounts on every step (`key={step.id}` in `FirstRunFlow`), so
 * a restore on its unmount would fire between steps. `FirstRunFlow` owns one
 * `captureReturnFocus` when the run starts and one `restoreReturnFocus` when it
 * ends — see its `beginRun`/`endRun`.
 *
 * When the anchor element is genuinely absent, the card renders centred and
 * without a pointer instead of pinning itself to the viewport origin — it says
 * nothing about where the surface is rather than pointing somewhere wrong.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FIRST_RUN_ANCHOR_ATTRIBUTE } from './tour-steps';
import './Coachmark.css';

const CARD_WIDTH = 340;
const VIEWPORT_GUTTER = 16;
const ANCHOR_OFFSET = 12;
/** Conservative floor before the card has a stable browser measurement. */
const CARD_PLACEMENT_HEIGHT_FLOOR = 300;
/**
 * How long to keep watching for a step's anchor to appear before accepting the
 * unanchored fallback. Generous on purpose: the cost of waiting is a card that
 * arrives correctly placed a moment later, the cost of giving up early is a
 * card that claims to point at a surface it never found.
 */
const ANCHOR_WAIT_MS = 5000;

/** Keep a placed card correct while the page moves under it. */
function bindReposition(place: () => boolean): () => void {
  const reposition = () => {
    place();
  };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
  return () => {
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
  };
}

interface CoachmarkPosition {
  left: number;
  top: number;
  placement: 'above' | 'below';
}

const FOCUSABLE =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export interface CoachmarkProps {
  anchor: string;
  title: string;
  body: string;
  stepNumber: number;
  stepCount: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  /** Rendered on the last step instead of "Next". */
  isLastStep: boolean;
}

export function Coachmark({
  anchor,
  title,
  body,
  stepNumber,
  stepCount,
  onNext,
  onBack,
  onSkip,
  isLastStep,
}: CoachmarkProps) {
  const titleId = useId();
  const bodyId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CoachmarkPosition | null>(null);
  const [anchorFound, setAnchorFound] = useState(false);

  const place = useCallback((): boolean => {
    // Attribute-value comparison rather than an interpolated selector: the
    // anchor name would otherwise have to be escaped into CSS syntax, and
    // `CSS.escape` is not universally available (absent in the jsdom the UI
    // suite runs under, and in older webviews Station is expected to run in).
    // A throwing selector here would take out the whole tour.
    const element = Array.from(
      document.querySelectorAll(`[${FIRST_RUN_ANCHOR_ATTRIBUTE}]`),
    ).find(
      (candidate) =>
        candidate.getAttribute(FIRST_RUN_ANCHOR_ATTRIBUTE) === anchor,
    );
    if (!element) {
      setAnchorFound(false);
      setPosition(null);
      return false;
    }
    const rect = element.getBoundingClientRect();
    // A zero-area rect is a rendered-but-hidden anchor; treat it as absent
    // rather than pinning the card to the viewport origin.
    if (rect.width === 0 && rect.height === 0) {
      setAnchorFound(false);
      setPosition(null);
      return false;
    }
    const left = Math.min(
      Math.max(VIEWPORT_GUTTER, rect.left + rect.width / 2 - CARD_WIDTH / 2),
      Math.max(
        VIEWPORT_GUTTER,
        window.innerWidth - CARD_WIDTH - VIEWPORT_GUTTER,
      ),
    );
    const card = cardRef.current;
    const measuredHeight = Math.max(
      card?.getBoundingClientRect().height ?? 0,
      card?.scrollHeight ?? 0,
    );
    const cardHeight = Math.max(measuredHeight, CARD_PLACEMENT_HEIGHT_FLOOR);
    const rootStyle = getComputedStyle(document.documentElement);
    const chatDockHeight =
      Number.parseFloat(rootStyle.getPropertyValue('--dock-slot-size')) || 0;
    const viewportBottomInset =
      Number.parseFloat(
        rootStyle.getPropertyValue('--visual-viewport-bottom-inset'),
      ) || 0;
    const usableViewportBottom =
      window.innerHeight - chatDockHeight - viewportBottomInset;
    const belowTop = rect.bottom + ANCHOR_OFFSET;
    const aboveTop = rect.top - ANCHOR_OFFSET;
    const belowFits =
      belowTop + cardHeight <= usableViewportBottom - VIEWPORT_GUTTER;
    const aboveFits = aboveTop - cardHeight >= VIEWPORT_GUTTER;
    const placeAbove = !belowFits && aboveFits;
    setAnchorFound(true);
    setPosition({
      left,
      top: placeAbove
        ? Math.min(
            usableViewportBottom - VIEWPORT_GUTTER,
            Math.max(cardHeight + VIEWPORT_GUTTER, aboveTop),
          )
        : Math.min(
            Math.max(VIEWPORT_GUTTER, belowTop),
            Math.max(
              VIEWPORT_GUTTER,
              usableViewportBottom - cardHeight - VIEWPORT_GUTTER,
            ),
          ),
      placement: placeAbove ? 'above' : 'below',
    });
    return true;
  }, [anchor]);

  // Wait for the destination surface to actually paint its anchor.
  //
  // A step navigates to its route and the coachmark mounts in the same commit,
  // so the anchor is never present on the first measurement. This used to be
  // two fixed retries (60ms, 300ms), which was a guess at how long a route
  // change plus its data load takes — and on a real machine it is routinely
  // longer: the review-queue step measured "absent" against an anchor that was
  // in the DOM, and silently fell back to the unanchored card. A tour that
  // quietly stops pointing at things is the failure this component exists to
  // avoid, and no test could see it because tests mount the anchor first.
  //
  // Observe instead of guessing: re-measure on every DOM mutation until the
  // anchor is found, then stop observing. `ANCHOR_WAIT_MS` bounds the wait so a
  // step whose surface genuinely never renders settles into the honest
  // unanchored fallback rather than observing forever.
  useEffect(() => {
    if (place()) return bindReposition(place);
    // Coalesce into one measurement per frame: this observes the whole document
    // during a route change plus its data load, and `place` runs a
    // `querySelectorAll` — running it per mutation would be a full-document
    // scan on every DOM write for up to ANCHOR_WAIT_MS.
    let pending: number | null = null;
    const observer = new MutationObserver(() => {
      if (pending !== null) return;
      pending = requestAnimationFrame(() => {
        pending = null;
        if (place()) observer.disconnect();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const giveUp = window.setTimeout(
      () => observer.disconnect(),
      ANCHOR_WAIT_MS,
    );
    const unbind = bindReposition(place);
    return () => {
      observer.disconnect();
      if (pending !== null) cancelAnimationFrame(pending);
      window.clearTimeout(giveUp);
      unbind();
    };
  }, [place]);

  // Focus the card itself (not its first button) so the title and body are
  // announced before the controls.
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onSkip();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === cardRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      ref={cardRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the coachmark is a focus target by design — focus lands on the card so its title and body are announced before the controls.
      tabIndex={0}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="first-run-coachmark"
      data-anchored={anchorFound ? 'true' : 'false'}
      className={`first-run-coachmark${
        position
          ? ` first-run-coachmark--${position.placement}`
          : ' first-run-coachmark--unanchored'
      }`}
      style={position ? { left: position.left, top: position.top } : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="first-run-coachmark__progress">
        Step {stepNumber} of {stepCount}
      </div>
      <h2 className="first-run-coachmark__title" id={titleId}>
        {title}
      </h2>
      <p className="first-run-coachmark__body" id={bodyId}>
        {body}
      </p>
      <div className="first-run-coachmark__actions">
        <button
          type="button"
          className="first-run-coachmark__secondary"
          onClick={onSkip}
        >
          Skip the tour
        </button>
        <div className="first-run-coachmark__advance">
          {stepNumber > 1 && (
            <button
              type="button"
              className="first-run-coachmark__secondary"
              onClick={onBack}
            >
              Back
            </button>
          )}
          <button
            type="button"
            className="first-run-coachmark__primary"
            onClick={onNext}
          >
            {isLastStep ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
