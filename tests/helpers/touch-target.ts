/**
 * Minimum touch-target size, in CSS pixels, for mobile assertions.
 *
 * WCAG 2.5.5 sets the floor at 44 CSS px, and the product styles these controls
 * to exactly that. A raw `getBoundingClientRect()` read can nevertheless report
 * 43.99999237060547 or 44.00000762939453 for one of them, which a bare `44`
 * comparison fails on roughly half of those reads.
 *
 * THE MECHANISM, MEASURED — not scroll offset and not device pixel ratio. An
 * earlier version of this docblock named those two, and a second entry repeated
 * the attribution. Both were swept and neither moves the number: device pixel
 * ratio at 1, 1.25, 1.5, 2, 2.5 and 3, and scroll offset at 0, 1, 7, 13, 100 and
 * 333, all report exactly 44, as do webfont load state, viewport width, the
 * `isMobile` flag, fractional `--safe-top` insets and corpus composition. What
 * does move it is an ANCESTOR TRANSFORM IN FLIGHT. `.banner-host__item` runs the
 * `banner-host-enter` entry animation (`translateY(-8px)` to `translateY(0)`,
 * `BannerHost.css`), and the controls measured here are its descendants. While
 * that animation runs, Chromium maps the descendant's corners through the
 * ancestor's transform and takes their bounding box, so the reported `height` is
 * `float32(bottom) - float32(top)` — a difference of two rounded edges — rather
 * than a layout size. Both keyframe endpoints are integers, which is why a read
 * at rest, or at the from-state, is exact and the artifact is rare.
 *
 * THE ARITHMETIC THAT IDENTIFIES IT, and the reason this is a float32 edge
 * difference rather than unexplained noise. `44 - 43.99999237060547` is 2^-17,
 * exactly one float32 unit in the last place at magnitude 88 — and 88 is the
 * measured `top` of that element. The sibling value `44 - 43.99993896484375` is
 * 2^-14, one ULP at magnitude 857 — and 857 is its measured `left`. Each deficit
 * is one representable step at the coordinate its edge sits on. The error is also
 * SYMMETRIC (`44.00000762939453` was observed as often as the undershoot), which
 * is what settles that nothing is genuinely undersized: a control that were
 * really too small could not round upward.
 *
 * THE FIX IS TO SETTLE THE ANIMATION, NOT TO TOLERATE IT. A caller that awaits
 * `Element.getAnimations()`' `finished` promises before measuring reads exactly
 * 44 at any renderer speed — see `BannerHost.dialog-stacking.test.tsx` and
 * `tests/banner-stack-bound.spec.ts`, which both do this. That matters far more
 * than the 7.6e-6 px: the same window displaces the banner by up to a full EIGHT
 * pixels, so any hit test computed from an unsettled rectangle can resolve to a
 * different element than the settled layout gives — a wrong verdict in either
 * direction, not a rounding artifact. A tolerance cannot help with that.
 *
 * This constant therefore remains DEFENCE IN DEPTH for callers that measure
 * without settling, and is not the fix for #2086. One hundredth of a pixel keeps
 * the assertion honest — anything genuinely undersized is short by whole pixels,
 * not by 7.6e-6 — while absorbing the single-ULP artifact, which it exceeds by
 * about 1300x. Use it for any assertion against a browser-MEASURED rectangle; a
 * bare `44` is only safe where the measurement has already been rounded to an
 * integer.
 *
 * Observed instances: `ssh-environments-ui` with `Received: 43.99993896484375`,
 * and `BannerHost.dialog-stacking` with `43.99999237060547` during a large
 * related-set run on a loaded host (#2086).
 */
export const MIN_TOUCH_TARGET_PX = 43.99;
