import { useEffect, useState } from 'react';
import type { DockMode } from '../types';

/**
 * The single source of truth for the mobile breakpoint, mirroring the
 * `--bp-mobile` documentation token in `tokens.css`. CSS media queries cannot
 * read a custom property, so this literal must stay byte-identical to the
 * condition on every mobile `@media` block across the stylesheets.
 *
 * The second clause exists because width alone was wrong. A phone in landscape
 * is ~855 CSS px wide, so `max-width: 768px` reported it as a desktop and
 * silently switched off every mobile affordance — the one-row chat header, the
 * task switcher, the 44px touch floors — on a device that is unambiguously a
 * phone. A short viewport with a coarse pointer is a phone held sideways;
 * a tablet in landscape is ~768px tall and correctly does not match.
 *
 * The desktop-only blocks are guarded with the negation of this same clause
 * (`@media (min-width: 769px) and (not (...))`), because a landscape phone
 * matches BOTH width conditions and would otherwise get desktop rules layered
 * on top of mobile ones, with source order deciding the winner.
 */
export const MOBILE_MEDIA_QUERY =
  '(max-width: 768px), (max-height: 540px) and (pointer: coarse)';

export type DockSlotDevice = {
  viewportWidth: number;
  coarsePointer: boolean;
};

const DOCK_SLOT_COARSE_POINTER_QUERY = '(pointer: coarse)';
const BOTTOM_ONLY: readonly DockMode[] = ['bottom'];
const EVERY_EDGE: readonly DockMode[] = ['left', 'right', 'bottom'];

/**
 * The sole device policy for the ambient dock slot, and deliberately NOT the
 * mobile breakpoint (station#3928).
 *
 * They ask different questions. `MOBILE_MEDIA_QUERY` asks "is this a phone",
 * and it has to stay byte-identical to the condition on every mobile `@media`
 * block or the stylesheets and the components disagree about the same device.
 * This asks "can this device usefully put the dock on a side", and the answer
 * is no for ANY coarse pointer, including a wide touchscreen laptop that is
 * emphatically not a phone. Deriving one from the other means widening the
 * breakpoint to answer a dock question, which silently moves every mobile
 * affordance in the product onto touchscreen desktops.
 */
export function availablePlacements({
  viewportWidth,
  coarsePointer,
}: DockSlotDevice): readonly DockMode[] {
  return coarsePointer || viewportWidth <= 768 ? BOTTOM_ONLY : EVERY_EDGE;
}

export function effectivePlacement(
  preference: DockMode,
  available: readonly DockMode[],
): DockMode {
  return available.includes(preference)
    ? preference
    : (available[0] ?? 'bottom');
}

/**
 * Subscribes to the mobile breakpoint via `matchMedia` and re-renders when it
 * toggles. SSR / jsdom-safe: guards `window` and `matchMedia` so non-browser
 * environments simply report "not mobile" without throwing.
 *
 * Use this for JS-driven responsive behavior (drawer state, conditional layout
 * restructuring). Pure styling differences should stay in CSS under
 * `@media (max-width: 768px)`.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => getInitialMatch());

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(MOBILE_MEDIA_QUERY);
    const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    // Sync once on mount in case the value changed before the effect ran.
    setIsMobile(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return isMobile;
}

/**
 * What this device can do with the dock slot, subscribed.
 *
 * It reads the viewport and the pointer HERE, once, so no dock consumer does —
 * and it feeds `availablePlacements`, so the policy that ships is the policy
 * the tests exercise. A second copy of the two arrays inlined at the call site
 * is how a tested function and a shipped function drift apart.
 */
export function useDockSlotDevice(): DockSlotDevice {
  const [device, setDevice] = useState<DockSlotDevice>(getInitialDockDevice);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const coarse = window.matchMedia(DOCK_SLOT_COARSE_POINTER_QUERY);
    const read = () =>
      setDevice((current) =>
        current.viewportWidth === window.innerWidth &&
        current.coarsePointer === coarse.matches
          ? current
          : { viewportWidth: window.innerWidth, coarsePointer: coarse.matches },
      );
    read();
    coarse.addEventListener('change', read);
    window.addEventListener('resize', read);
    return () => {
      coarse.removeEventListener('change', read);
      window.removeEventListener('resize', read);
    };
  }, []);

  return device;
}

/** Shared effective placement for every dock-slot consumer. */
export function useDockSlotPlacement(preference: DockMode) {
  const available = availablePlacements(useDockSlotDevice());
  return { available, effective: effectivePlacement(preference, available) };
}

function getInitialDockDevice(): DockSlotDevice {
  if (typeof window === 'undefined')
    return { viewportWidth: 1440, coarsePointer: false };
  return {
    viewportWidth: window.innerWidth,
    coarsePointer:
      window.matchMedia?.(DOCK_SLOT_COARSE_POINTER_QUERY).matches ?? false,
  };
}

function getInitialMatch(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}
