import type { Locator } from '@playwright/test';

/**
 * Colour measurement for Playwright assertions — one implementation, because
 * three hand-rolled ones each shipped the same defect.
 *
 * Two hazards live here. Both produced confidently wrong numbers in this repo,
 * and both are invisible at the call site: the maths still returns a plausible
 * ratio, so a mis-parsed measurement is indistinguishable from a real pass.
 *
 * ## Hazard 1 — two serialization forms, different channel ranges
 *
 * `getComputedStyle` returns `rgb(102, 102, 102)` (0-255 channels) for a plain
 * colour, but `color(srgb 0.919 0.915 0.897)` (0-1 channels) for anything
 * computed through `color-mix()` — which is every `--bg-hover` / selected-row
 * surface in this app. Dividing the `color(srgb …)` form by 255 yields a
 * near-black colour.
 *
 * Symptom, twice: a real 4.74:1 placeholder measured as 3.64:1 in
 * `accessibility-core` while the failure message still named the theme it
 * thought it was testing (fixed #1173); and `new-chat-provider-managed`'s
 * `elementContrast` measured every `color-mix()` agent-row surface as black,
 * so its `>= 4.5` assertions passed on an inverted reading of the row. A third
 * instance was found the same day in an ad-hoc probe by another lane.
 *
 * ## Hazard 2 — translucent fills must be composited before comparing
 *
 * A `color-mix(…, transparent)` background reports its *own* un-composited
 * colour, and a fully unpainted element reports `rgba(0, 0, 0, 0)`. Comparing
 * text against either directly compares a colour with something that is not
 * what the user sees: an unpainted parent reads as pure black (inflating a
 * light-theme ratio), and a half-transparent tint reads as its own undiluted
 * pigment.
 *
 * Symptom: measuring a selected agent row against its own translucent tint
 * rather than the tint composited over the modal panel behind it. So
 * {@link contrastRatio} walks up the ancestor chain, alpha-compositing each
 * background over the next, and stops at the first opaque surface.
 *
 * ## Deliberate limits
 *
 * - Only `rgb()`/`rgba()` and `color(srgb …)` are accepted. Any other
 *   serialization (`oklch()`, `color(display-p3 …)`, `lab()`) **throws**
 *   rather than guessing: a wrong number that looks right is the failure mode
 *   this module exists to prevent, and the throw names the value so the next
 *   author knows exactly what to add.
 * - Ancestor `opacity`, `filter`, `background-image`, and `mix-blend-mode` are
 *   not modelled. A surface relying on those is not measured correctly here;
 *   assert on it directly instead of pretending this covers it.
 */

/** Pseudo-elements whose own `color` can be measured against the host's backdrop. */
export type PseudoElement =
  | '::placeholder'
  | '::before'
  | '::after'
  | '::first-line';

export interface ContrastOptions {
  /**
   * Read the foreground `color` from this pseudo-element instead of the
   * element itself. The backdrop is still the host element's composited
   * background — pseudo-elements like `::placeholder` paint no surface.
   */
  pseudo?: PseudoElement;
}

/** An element's own background paint, before any compositing. */
export interface BackgroundPaint {
  /** The raw serialized value, for failure messages. */
  color: string;
  /** Alpha in 0-1. `0` means fully unpainted; `1` means fully opaque. */
  alpha: number;
}

/**
 * The evaluate body shared by both exported helpers.
 *
 * This is a string-free single function so Playwright can serialize it into the
 * page. It must not close over anything from the module scope.
 */
function measureInPage(
  element: Element,
  options: { pseudo?: string | null; mode: 'contrast' | 'background' },
): number | BackgroundPaint {
  interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
  }

  const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

  const parseColor = (raw: string): Rgba => {
    const text = String(raw ?? '').trim();
    if (!text || text === 'transparent' || text === 'none') return TRANSPARENT;

    const call = /^([a-zA-Z-]+)\(([^)]*)\)$/.exec(text);
    if (!call) {
      throw new Error(`Unsupported colour serialization: ${text}`);
    }
    const fn = call[1].toLowerCase();
    // Normalise both the legacy comma form and the modern
    // `r g b / a` slash form into a flat token list.
    const args = call[2]
      .replace(/\//g, ' ')
      .split(/[\s,]+/)
      .filter(Boolean);

    let scale: number;
    if (fn === 'color') {
      // `color(<colorspace> r g b [/ a])` — the colorspace is a bare
      // identifier that must be dropped BEFORE reading numbers, because
      // several colorspace names contain digits (`display-p3`, `rec2020`).
      const space = (args.shift() ?? '').toLowerCase();
      if (space !== 'srgb') {
        throw new Error(
          `Unsupported colour space '${space}' in ${text}: the luminance maths below is sRGB-only. Add an explicit conversion rather than reading these channels as sRGB.`,
        );
      }
      // `color(srgb …)` carries 0-1 channels.
      scale = 1;
    } else if (fn === 'rgb' || fn === 'rgba') {
      // `rgb(…)`/`rgba(…)` carry 0-255 channels.
      scale = 255;
    } else {
      throw new Error(
        `Unsupported colour function '${fn}()' in ${text}: this helper reads rgb()/rgba() and color(srgb …) only.`,
      );
    }

    if (args.length < 3) {
      throw new Error(`Colour ${text} has fewer than three channels.`);
    }
    const channel = (token: string, divisor: number) =>
      token.endsWith('%')
        ? Number.parseFloat(token) / 100
        : Number.parseFloat(token) / divisor;

    return {
      r: channel(args[0], scale),
      g: channel(args[1], scale),
      b: channel(args[2], scale),
      a: args.length > 3 ? channel(args[3], 1) : 1,
    };
  };

  /** Standard source-over alpha compositing: `over` painted on top of `under`. */
  const composite = (over: Rgba, under: Rgba): Rgba => {
    const a = over.a + under.a * (1 - over.a);
    if (a === 0) return TRANSPARENT;
    const blend = (o: number, u: number) =>
      (o * over.a + u * under.a * (1 - over.a)) / a;
    return {
      r: blend(over.r, under.r),
      g: blend(over.g, under.g),
      b: blend(over.b, under.b),
      a,
    };
  };

  const ownBackground = (node: Element): Rgba =>
    parseColor(getComputedStyle(node).backgroundColor);

  if (options.mode === 'background') {
    const paint = ownBackground(element);
    return {
      color: getComputedStyle(element).backgroundColor,
      alpha: paint.a,
    };
  }

  /**
   * Composite the element's own background over each ancestor's until the
   * accumulated surface is opaque. An element that paints nothing simply
   * contributes nothing, so this also resolves the common "text in a
   * transparent span" case to the real surface behind it.
   */
  const backdrop = (): Rgba => {
    let result = ownBackground(element);
    let node: Element | null = element.parentElement;
    while (result.a < 1 && node) {
      result = composite(result, ownBackground(node));
      node = node.parentElement;
    }
    if (result.a < 1) {
      // Nothing in the chain painted an opaque surface, so what shows
      // through is the browser canvas, which defaults to white.
      result = composite(result, { r: 1, g: 1, b: 1, a: 1 });
    }
    return result;
  };

  const relativeLuminance = ({ r, g, b }: Rgba) => {
    const linear = (channel: number) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };

  const foregroundColor = getComputedStyle(
    element,
    options.pseudo ?? null,
  ).color;
  const foreground = relativeLuminance(parseColor(foregroundColor));
  const background = relativeLuminance(backdrop());
  return (
    (Math.max(foreground, background) + 0.05) /
    (Math.min(foreground, background) + 0.05)
  );
}

/**
 * WCAG 2.x contrast ratio (1-21) between the locator's text colour and the
 * surface actually behind it.
 *
 * The backdrop is resolved by alpha-compositing the element's own background
 * over its ancestors' until opaque — see Hazard 2 above. Do not pre-resolve it
 * at the call site (e.g. `element.closest('button')`); that is the workaround
 * this replaces.
 */
export async function contrastRatio(
  locator: Locator,
  options: ContrastOptions = {},
): Promise<number> {
  return locator.evaluate(
    measureInPage as (element: Element, options: unknown) => number,
    { pseudo: options.pseudo ?? null, mode: 'contrast' },
  );
}

/**
 * The locator's own background paint and its alpha, form-agnostically.
 *
 * Use this for "is this surface opaque?" assertions. An anchored
 * `^rgba\(…\)$` regex cannot see `color(srgb … / a)`, so a translucent
 * `color-mix()` surface reads as opaque under one — the same blind spot as
 * Hazard 1, in the alpha channel instead of the colour channels.
 *
 * `alpha === 1` is fully opaque; `alpha === 0` is fully unpainted (the
 * `transparent` keyword, however it happens to serialize).
 */
export async function backgroundPaint(
  locator: Locator,
): Promise<BackgroundPaint> {
  return locator.evaluate(
    measureInPage as (element: Element, options: unknown) => BackgroundPaint,
    { pseudo: null, mode: 'background' },
  );
}
