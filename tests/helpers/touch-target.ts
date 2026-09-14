/**
 * Minimum touch-target size, in CSS pixels, for mobile assertions.
 *
 * WCAG 2.5.5 sets the floor at 44 CSS px, and the product styles these controls
 * to exactly that. Browser layout, however, reports sub-pixel values: an
 * element styled to 44px measures as 43.99993896484375 depending on scroll
 * offset and device pixel ratio. Asserting against a bare `44` therefore fails
 * intermittently on an element that does meet the requirement — an observed
 * cause of rotating failures in the product bucket, where
 * `ssh-environments-ui` failed with `Received: 43.99993896484375`.
 *
 * One hundredth of a pixel of tolerance keeps the assertion honest — anything
 * genuinely undersized is smaller by whole pixels, not by 6e-5 — while removing
 * the rounding artifact.
 *
 * Second observed instance (#2086): `BannerHost.dialog-stacking` compared a raw
 * `getBoundingClientRect().height` against a bare `44` and red with
 * `43.99999237060547` during a large related-set run on a loaded host. Use this
 * constant for any assertion against a browser-MEASURED rectangle; a bare `44`
 * is only safe where the measurement has already been rounded to an integer.
 */
export const MIN_TOUCH_TARGET_PX = 43.99;
