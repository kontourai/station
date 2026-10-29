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

/**
 * A motion token (`--motion-fast`, `--motion-base`, …) read from `style` in
 * milliseconds, for animations driven from script that must last exactly as
 * long as the CSS ones. Tokens are authored in seconds or milliseconds, and
 * the reduced-motion block in `tokens.css` collapses them to 0.01ms, so a
 * caller honours reduced motion without checking it separately. An unset or
 * unparsable token reads as `fallback`.
 */
export function motionTokenMs(
  style: CSSStyleDeclaration,
  token: `--motion-${string}`,
  fallback = 0,
): number {
  const raw = style.getPropertyValue(token).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith('ms') ? value : value * 1000;
}
