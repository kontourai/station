/**
 * Applies a person's custom appearance (docs/decisions/custom-appearance.md).
 *
 * Two constructed sheets are adopted after every document sheet, so they
 * follow Station's own styles in the cascade: the palette, and the sanitized
 * CSS. The CSS sheet is disabled while a decision surface is mounted
 * (`decision-surfaces.ts`); the palette stays. Both are off in a tab opened
 * with `?appearance=safe`.
 *
 * What is shown is the preview when one is running, otherwise the active
 * appearance. The last active appearance this browser applied is cached in
 * localStorage as the text the server accepted, and
 * `applyCachedCustomAppearance` parses and sanitizes it again before the first
 * render. (The sanitized serialization is not cached: the CSSOM expands
 * shorthands, so it can exceed the 50,000-character limit the parse enforces.)
 */
import {
  CUSTOM_APPEARANCE_SAFE_PARAM,
  CUSTOM_APPEARANCE_SAFE_VALUE,
  type CustomAppearance,
  type CustomCssStripped,
  parseCustomAppearance,
} from '@kontourai/station-contracts/custom-appearance';
import {
  decisionSurfaceMounted,
  subscribeDecisionSurfaces,
} from './decision-surfaces';
import { customPaletteCss } from './palette-css';
import { constructedSheetsSupported, sanitizeCustomCss } from './sanitize-css';
import { customAppearanceVisualCss } from './visual-css';

export const CUSTOM_APPEARANCE_CACHE_KEY = 'station-custom-appearance-v1';
const SAFE_SESSION_KEY = 'station-custom-appearance-safe';

interface Applied {
  appearance: CustomAppearance;
  stripped: CustomCssStripped[];
}

interface State {
  active: Applied | null;
  preview: Applied | null;
  safe: boolean;
  palette: CSSStyleSheet | null;
  css: CSSStyleSheet | null;
  visual: CSSStyleSheet | null;
}

const state: State = {
  active: null,
  preview: null,
  safe: false,
  palette: null,
  css: null,
  visual: null,
};
const listeners = new Set<() => void>();
let snapshot = 0;
let bound = false;

function readSafeMode(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (
      params.get(CUSTOM_APPEARANCE_SAFE_PARAM) === CUSTOM_APPEARANCE_SAFE_VALUE
    ) {
      sessionStorage.setItem(SAFE_SESSION_KEY, '1');
      return true;
    }
    return sessionStorage.getItem(SAFE_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function prepare(appearance: CustomAppearance): Applied {
  return { appearance, stripped: sanitizeCustomCss(appearance.css).stripped };
}

function render(): void {
  if (typeof document === 'undefined' || !constructedSheetsSupported()) return;
  const shown = state.preview ?? state.active;
  const ours = new Set(
    [state.palette, state.css, state.visual].filter(Boolean),
  );
  const others = document.adoptedStyleSheets.filter((s) => !ours.has(s));
  state.palette = null;
  state.css = null;
  state.visual = null;
  if (shown && !state.safe) {
    const palette = new CSSStyleSheet();
    palette.replaceSync(customPaletteCss(shown.appearance.palette));
    const css = sanitizeCustomCss(shown.appearance.css).sheet;
    const visualText = customAppearanceVisualCss(shown.appearance);
    if (visualText) {
      const visual = new CSSStyleSheet();
      visual.replaceSync(visualText);
      visual.disabled = decisionSurfaceMounted();
      state.visual = visual;
    }
    state.palette = palette;
    state.css = css;
    if (css) css.disabled = decisionSurfaceMounted();
  }
  document.adoptedStyleSheets = [
    ...others,
    ...[state.palette, state.visual, state.css].filter(
      (s): s is CSSStyleSheet => !!s,
    ),
  ];
  snapshot += 1;
  for (const listener of listeners) listener();
}

function suspendForDecisions(): void {
  if (state.css) state.css.disabled = decisionSurfaceMounted();
  if (state.visual) state.visual.disabled = decisionSurfaceMounted();
  snapshot += 1;
  for (const listener of listeners) listener();
}

function bind(): void {
  if (bound) return;
  bound = true;
  state.safe = readSafeMode();
  subscribeDecisionSurfaces(suspendForDecisions);
}

function writeCache(applied: Applied | null): void {
  try {
    if (!applied) {
      localStorage.removeItem(CUSTOM_APPEARANCE_CACHE_KEY);
      return;
    }
    localStorage.setItem(
      CUSTOM_APPEARANCE_CACHE_KEY,
      JSON.stringify({ version: 2, appearance: applied.appearance }),
    );
  } catch {
    // The cache is a pre-paint convenience; the live appearance still applies.
  }
}

/** The person's active appearance from the server, or `null` to turn it off. Writes the pre-paint cache. */
export function setActiveCustomAppearance(
  appearance: CustomAppearance | null,
): void {
  bind();
  const parsed = appearance ? parseCustomAppearance(appearance) : null;
  state.active = parsed?.ok ? prepare(parsed.value) : null;
  writeCache(state.active);
  render();
}

/**
 * Apply the cached appearance before the first render. The cache is device
 * storage, so it is parsed (including the CSS text check) and sanitized again.
 */
export function applyCachedCustomAppearance(): void {
  bind();
  let cached: unknown;
  try {
    const raw = localStorage.getItem(CUSTOM_APPEARANCE_CACHE_KEY);
    cached = raw ? JSON.parse(raw) : null;
  } catch {
    cached = null;
  }
  if (!cached || typeof cached !== 'object') return;
  const { version, appearance } = cached as Record<string, unknown>;
  if (version !== 2) return;
  const parsed = parseCustomAppearance(appearance);
  if (!parsed.ok) return;
  state.active = prepare(parsed.value);
  render();
}

export function startCustomAppearancePreview(
  appearance: CustomAppearance,
): Applied {
  bind();
  state.preview = prepare(appearance);
  render();
  return state.preview;
}

export function endCustomAppearancePreview(): void {
  if (!state.preview) return;
  state.preview = null;
  render();
}

export interface CustomAppearanceSnapshot {
  active: CustomAppearance | null;
  previewing: CustomAppearance | null;
  safe: boolean;
  /** Custom CSS is in the cascade now (not suspended, not safe mode). */
  cssApplied: boolean;
  suspendedForDecision: boolean;
  version: number;
}

let cachedSnapshot: CustomAppearanceSnapshot | null = null;
export function getCustomAppearanceSnapshot(): CustomAppearanceSnapshot {
  if (cachedSnapshot?.version !== snapshot)
    cachedSnapshot = {
      active: state.active?.appearance ?? null,
      previewing: state.preview?.appearance ?? null,
      safe: state.safe,
      cssApplied: !!state.css && !state.css.disabled,
      suspendedForDecision: !!state.css?.disabled || !!state.visual?.disabled,
      version: snapshot,
    };
  return cachedSnapshot;
}

export function subscribeCustomAppearance(listener: () => void): () => void {
  bind();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Run `read` with the custom CSS sheet out of the cascade, so a measurement
 * sees the palette over the theme and nothing the CSS made conditional on
 * page content. Synchronous: no frame is painted in between.
 */
export function withoutCustomCss<T>(read: () => T): T {
  const sheets = [state.css, state.visual].filter(
    (sheet): sheet is CSSStyleSheet => !!sheet && !sheet.disabled,
  );
  for (const sheet of sheets) sheet.disabled = true;
  try {
    return read();
  } finally {
    for (const sheet of sheets) sheet.disabled = decisionSurfaceMounted();
  }
}

/** Leave safe mode in this tab. */
export function leaveCustomAppearanceSafeMode(): void {
  try {
    sessionStorage.removeItem(SAFE_SESSION_KEY);
  } catch {
    // Nothing to forget.
  }
  state.safe = false;
  render();
}
