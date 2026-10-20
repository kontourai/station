/**
 * True when this device asks for reduced motion, read at call time rather than
 * cached — the OS setting can change while the app is open, and a cached
 * answer would keep animating (or keep refusing to) for the rest of the
 * session. `matchMedia` is absent in some non-browser hosts, which reads as
 * "no preference expressed", never as "reduce".
 *
 * The startup screen (`startup-animation.ts`, `startup-presentation.ts`)
 * subscribes to the query's `change` events instead of reading it once, and
 * `startup-animation.ts` must stay free of imports beyond its mark geometry,
 * so those two keep their own `matchMedia` call.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
