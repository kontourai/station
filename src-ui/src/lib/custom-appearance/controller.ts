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
 * appearance. The last active appearance this browser applied is cached,
 * sanitized, in localStorage with the opaque owner tag the server returned,
 * and `applyCachedCustomAppearance` puts it back before the first render.
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

export const CUSTOM_APPEARANCE_CACHE_KEY = 'station-custom-appearance-v1';
const SAFE_SESSION_KEY = 'station-custom-appearance-safe';

interface Applied {
  appearance: CustomAppearance;
  stripped: CustomCssStripped[];
}

interface State {
  active: Applied | null;
  owner: string | null;
  preview: Applied | null;
  safe: boolean;
  palette: CSSStyleSheet | null;
  css: CSSStyleSheet | null;
}

const state: State = {
  active: null,
  owner: null,
  preview: null,
  safe: false,
  palette: null,
  css: null,
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
  const ours = new Set([state.palette, state.css].filter(Boolean));
  const others = document.adoptedStyleSheets.filter((s) => !ours.has(s));
  state.palette = null;
  state.css = null;
  if (shown && !state.safe) {
    const palette = new CSSStyleSheet();
    palette.replaceSync(customPaletteCss(shown.appearance.palette));
    const css = sanitizeCustomCss(shown.appearance.css).sheet;
    state.palette = palette;
    state.css = css;
    if (css) css.disabled = decisionSurfaceMounted();
  }
  document.adoptedStyleSheets = [
    ...others,
    ...[state.palette, state.css].filter((s): s is CSSStyleSheet => !!s),
  ];
  snapshot += 1;
  for (const listener of listeners) listener();
}

function suspendForDecisions(): void {
  if (state.css) state.css.disabled = decisionSurfaceMounted();
  snapshot += 1;
  for (const listener of listeners) listener();
}

function bind(): void {
  if (bound) return;
  bound = true;
  state.safe = readSafeMode();
  subscribeDecisionSurfaces(suspendForDecisions);
}

function writeCache(owner: string | null, applied: Applied | null): void {
  try {
    if (!owner || !applied) {
      localStorage.removeItem(CUSTOM_APPEARANCE_CACHE_KEY);
      return;
    }
    const sanitized = sanitizeCustomCss(applied.appearance.css).text;
    localStorage.setItem(
      CUSTOM_APPEARANCE_CACHE_KEY,
      JSON.stringify({
        version: 1,
        owner,
        appearance: { ...applied.appearance, css: sanitized },
      }),
    );
  } catch {
    // The cache is a pre-paint convenience; the live appearance still applies.
  }
}

/**
 * The person's active appearance, from the server (`owner` is its opaque
 * tag) or `null` to turn it off. Writes the pre-paint cache.
 */
export function setActiveCustomAppearance(
  appearance: CustomAppearance | null,
  owner: string | null,
): void {
  bind();
  const parsed = appearance ? parseCustomAppearance(appearance) : null;
  state.active = parsed?.ok ? prepare(parsed.value) : null;
  state.owner = state.active ? owner : null;
  writeCache(state.owner, state.active);
  render();
}

/** Apply the cached appearance before the first render. */
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
  const { version, owner, appearance } = cached as Record<string, unknown>;
  if (version !== 1 || typeof owner !== 'string') return;
  const parsed = parseCustomAppearance(appearance);
  if (!parsed.ok) return;
  state.active = prepare(parsed.value);
  state.owner = owner;
  render();
}

/** The owner tag of the appearance in force, so a different person's answer replaces it. */
export function customAppearanceOwner(): string | null {
  return state.owner;
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
      suspendedForDecision: !!state.css?.disabled,
      version: snapshot,
    };
  return cachedSnapshot;
}

export function subscribeCustomAppearance(listener: () => void): () => void {
  bind();
  listeners.add(listener);
  return () => listeners.delete(listener);
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
