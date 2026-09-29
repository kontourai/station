/**
 * White-label theme overrides from the branding provider (`GET /api/branding`
 * `theme`), applied to the element that carries Station's theme scope.
 *
 * The contract is `@kontourai/ui`'s DESIGN.md "White-label overrides": values
 * are per mode, the action fill and its text are a pair, and a runtime that
 * applies a theme must reject a pair that fails the contrast thresholds. The
 * endpoint is a no-credential boot read supplied by a plugin, so everything
 * here is untrusted input: only the five brand-slot properties below are ever
 * written, only after their values parse as hex colours, and only when the
 * WHOLE theme passes — any rejection keeps the defaults, so an unreadable or
 * half-applied theme never lands.
 *
 * Accepted shape (JSON-serialisable, backward compatible with the original
 * flat `Record<string, string>`):
 *
 *   { "--k-brand": "#…",                      // flat: expanded into both modes
 *     "dark":  { "--k-action": "#…", … },      // per mode: wins over flat
 *     "light": { "--k-action": "#…", … } }
 *
 * `@kontourai/ui/contrast` (ui 1.16.0) ships the shared check for the
 * expanded `{ dark, light }` shape with the same all-or-nothing rule. Once
 * Station can take that release, its `validateBrandOverride` replaces the
 * validation inside `resolveBrandingTheme`; Station's stricter rule (the
 * action fill also reads as text on page and panel) stays as an extra check.
 */

import { contrastRatio } from './accent-contrast';

/** The only properties a branding theme may set. Order is apply order. */
export const BRANDING_THEME_PROPERTIES = [
  '--k-brand',
  '--k-brand-contrast',
  '--k-action',
  '--k-action-contrast',
  '--k-focus',
] as const;

export type BrandingThemeProperty = (typeof BRANDING_THEME_PROPERTIES)[number];
export type BrandingThemeMode = 'dark' | 'light';
export type BrandingModeOverrides = Partial<
  Record<BrandingThemeProperty, string>
>;
export type BrandingThemeOverrides = Partial<
  Record<BrandingThemeMode, BrandingModeOverrides>
>;

const MODES: readonly BrandingThemeMode[] = ['dark', 'light'];
const ALLOWED = new Set<string>(BRANDING_THEME_PROPERTIES);

/** `#rgb` or `#rrggbb` only: no alpha, keywords, functions or `var()`. */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A validated, lower-cased hex colour, or `null`. */
function parseHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return HEX_COLOR.test(value) ? value.toLowerCase() : null;
}

/**
 * The shipped `@kontourai/ui` surfaces and brand slot per mode — what an
 * override is rated against, and what an unset half of a pair resolves to.
 * Pinned against the installed tokens file by `branding-theme.test.ts`.
 * Station applies no `.theme-*` class, so these are the effective defaults.
 */
export const SHIPPED_MODE_TOKENS: Record<
  BrandingThemeMode,
  { bg: string; panel: string; brand: string; brandContrast: string }
> = {
  dark: {
    bg: '#0a0e13',
    panel: '#111824',
    brand: '#5ce0c6',
    brandContrast: '#06080b',
  },
  light: {
    bg: '#f5f4ef',
    panel: '#ffffff',
    brand: '#0e7c64',
    brandContrast: '#ffffff',
  },
};

/** WCAG AA for text; non-text (focus indicator) contrast. */
const TEXT_CONTRAST_MIN = 4.5;
const NON_TEXT_CONTRAST_MIN = 3;

/**
 * WCAG contrast ratio of two already-validated hex colours, through Station's
 * existing helper (`accent-contrast.ts`). `0` if either somehow is not hex, so
 * a malformed value can only fail a threshold, never pass one.
 */
export function hexContrast(a: string, b: string): number {
  return contrastRatio(a, b) ?? 0;
}

export interface BrandingThemeViolation {
  mode: BrandingThemeMode | 'both';
  /** The property or group that was dropped. */
  subject: string;
  reason: string;
}

interface ModeCheck {
  accepted: BrandingModeOverrides;
  violations: BrandingThemeViolation[];
}

/**
 * Rate one mode's overrides group by group. `accepted` lists the groups that
 * pass; `resolveBrandingTheme` applies nothing unless every group in every
 * mode passes. Groups:
 *
 * - action pair (`--k-action` + `--k-action-contrast`): both or neither; the
 *   pair meets AA text contrast. Station also paints `--accent-primary` (which
 *   reads the action role) as link and accent TEXT on the page and panel, so
 *   the fill must meet AA text contrast on both surfaces too — stricter than
 *   the shared contract, which rates the pair only.
 * - brand (`--k-brand`, optional `--k-brand-contrast`): brand used as text
 *   meets AA on the page and panel, and the brand/brand-contrast pair (either
 *   half defaulting to the shipped value) meets AA. Until Station takes the
 *   roles release, its action colour falls back to the brand, so this is also
 *   what keeps a brand-only theme's buttons legible.
 * - focus (`--k-focus`): non-text contrast on the page and the panel.
 */
export function checkModeOverrides(
  mode: BrandingThemeMode,
  values: BrandingModeOverrides,
): ModeCheck {
  const shipped = SHIPPED_MODE_TOKENS[mode];
  const accepted: BrandingModeOverrides = {};
  const violations: BrandingThemeViolation[] = [];
  const reject = (subject: string, reason: string) =>
    violations.push({ mode, subject, reason });
  const onSurfaces = (color: string) =>
    Math.min(hexContrast(color, shipped.bg), hexContrast(color, shipped.panel));

  const action = values['--k-action'];
  const actionContrast = values['--k-action-contrast'];
  if (action || actionContrast) {
    const pair = '--k-action/--k-action-contrast';
    if (!action || !actionContrast) {
      reject(pair, 'the action pair must be overridden together');
    } else if (hexContrast(action, actionContrast) < TEXT_CONTRAST_MIN) {
      reject(
        pair,
        `pair contrast ${hexContrast(action, actionContrast).toFixed(2)}:1 is below ${TEXT_CONTRAST_MIN}:1`,
      );
    } else if (onSurfaces(action) < TEXT_CONTRAST_MIN) {
      reject(
        pair,
        `--k-action on the page/panel is ${onSurfaces(action).toFixed(2)}:1, below ${TEXT_CONTRAST_MIN}:1`,
      );
    } else {
      accepted['--k-action'] = action;
      accepted['--k-action-contrast'] = actionContrast;
    }
  }

  const brand = values['--k-brand'];
  const brandContrast = values['--k-brand-contrast'];
  if (brand || brandContrast) {
    const group = '--k-brand/--k-brand-contrast';
    const effectiveBrand = brand ?? shipped.brand;
    const effectiveContrast = brandContrast ?? shipped.brandContrast;
    const pairRatio = hexContrast(effectiveBrand, effectiveContrast);
    if (onSurfaces(effectiveBrand) < TEXT_CONTRAST_MIN) {
      reject(
        group,
        `--k-brand on the page/panel is ${onSurfaces(effectiveBrand).toFixed(2)}:1, below ${TEXT_CONTRAST_MIN}:1`,
      );
    } else if (pairRatio < TEXT_CONTRAST_MIN) {
      reject(
        group,
        `brand pair contrast ${pairRatio.toFixed(2)}:1 is below ${TEXT_CONTRAST_MIN}:1`,
      );
    } else {
      if (brand) accepted['--k-brand'] = brand;
      if (brandContrast) accepted['--k-brand-contrast'] = brandContrast;
    }
  }

  const focus = values['--k-focus'];
  if (focus) {
    if (onSurfaces(focus) < NON_TEXT_CONTRAST_MIN) {
      reject(
        '--k-focus',
        `focus on the page/panel is ${onSurfaces(focus).toFixed(2)}:1, below ${NON_TEXT_CONTRAST_MIN}:1`,
      );
    } else {
      accepted['--k-focus'] = focus;
    }
  }

  return { accepted, violations };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Keys are echoed into logs; keep an attacker-chosen key short. */
function describeKey(key: string): string {
  return JSON.stringify(key.length > 64 ? `${key.slice(0, 64)}…` : key);
}

/**
 * A prototype-free record, so a key such as `__proto__` is stored and then
 * rejected like any other unknown key instead of silently rewiring the object.
 */
function bareRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function readEntries(
  source: Record<string, unknown>,
  into: Record<string, string>,
  scope: BrandingThemeMode | 'both',
  violations: BrandingThemeViolation[],
): void {
  // Own enumerable string keys only; JSON.parse makes `__proto__` one of them.
  for (const key of Object.keys(source)) {
    const raw = source[key];
    if (!ALLOWED.has(key)) {
      violations.push({
        mode: scope,
        subject: describeKey(key),
        reason: 'not an allowlisted branding property',
      });
      continue;
    }
    const color = parseHexColor(raw);
    if (!color) {
      violations.push({
        mode: scope,
        subject: key,
        reason: 'value is not a #rgb or #rrggbb colour',
      });
      continue;
    }
    Object.defineProperty(into, key, {
      value: color,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

export interface ResolvedBrandingTheme {
  overrides: BrandingThemeOverrides;
  violations: BrandingThemeViolation[];
}

function toModeOverrides(
  source: Record<string, string>,
): BrandingModeOverrides {
  const out: BrandingModeOverrides = {};
  for (const property of BRANDING_THEME_PROPERTIES) {
    const value = source[property];
    if (value !== undefined) out[property] = value;
  }
  return out;
}

/**
 * Parse an untrusted branding `theme` into validated per-mode overrides.
 *
 * ALL OR NOTHING, like `@kontourai/ui/contrast`'s `validateBrandOverride`
 * (ui 1.16.0): if anything in the theme is rejected — an unknown key, a value
 * that is not a hex colour, or any group failing its contrast rule in either
 * mode — nothing is applied and the defaults stay. A half-applied brand is a
 * design nobody reviewed. Every violation is still reported for the log.
 *
 * Flat top-level `--k-*` keys (the original `Record<string, string>` form)
 * are expanded into both modes BEFORE validation, per-mode entries winning.
 * The swap to the shared validator replaces this function's validation step
 * and hands it that expanded `{ dark, light }` shape; parsing, expansion and
 * the apply path stay here.
 */
export function resolveBrandingTheme(input: unknown): ResolvedBrandingTheme {
  const violations: BrandingThemeViolation[] = [];
  if (input === null || input === undefined)
    return { overrides: {}, violations };
  if (!isPlainObject(input)) {
    violations.push({
      mode: 'both',
      subject: 'theme',
      reason: 'theme must be an object',
    });
    return { overrides: {}, violations };
  }

  const flat = bareRecord<unknown>();
  const perMode: Partial<Record<BrandingThemeMode, Record<string, unknown>>> =
    {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (key === 'dark' || key === 'light') {
      if (isPlainObject(value)) perMode[key] = value;
      else
        violations.push({
          mode: key,
          subject: key,
          reason: 'a mode entry must be an object of properties',
        });
    } else {
      Object.defineProperty(flat, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  const shared = bareRecord<string>();
  readEntries(flat, shared, 'both', violations);

  const expanded: BrandingThemeOverrides = {};
  for (const mode of MODES) {
    const specific = bareRecord<string>();
    const source = perMode[mode];
    if (source) readEntries(source, specific, mode, violations);
    const merged = toModeOverrides({ ...shared, ...specific });
    if (Object.keys(merged).length === 0) continue;
    violations.push(...checkModeOverrides(mode, merged).violations);
    expanded[mode] = merged;
  }
  return { overrides: violations.length === 0 ? expanded : {}, violations };
}

/** Enough to diagnose a theme without letting a hostile one flood the console. */
const MAX_LOGGED_VIOLATIONS = 20;

export function logBrandingThemeViolations(
  violations: readonly BrandingThemeViolation[],
): void {
  if (violations.length === 0) return;
  console.warn(
    '[branding-theme] theme rejected; keeping the default theme. Nothing from it was applied.',
  );
  for (const v of violations.slice(0, MAX_LOGGED_VIOLATIONS)) {
    console.warn(
      `[branding-theme] rejected ${v.subject} (${v.mode}): ${v.reason}`,
    );
  }
  if (violations.length > MAX_LOGGED_VIOLATIONS) {
    console.warn(
      `[branding-theme] …and ${violations.length - MAX_LOGGED_VIOLATIONS} more rejection(s)`,
    );
  }
}

/** The mode the theme scope is currently in. Dark is the shipped default. */
function currentThemeMode(root: HTMLElement): BrandingThemeMode {
  return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

interface RootState {
  overrides: Readonly<BrandingThemeOverrides>;
  observer: MutationObserver | null;
}

const rootState = new WeakMap<HTMLElement, RootState>();

/**
 * A frozen copy of just the allowlisted entries, taken at apply time, so the
 * mode-flip re-apply writes what was validated even if the caller's object is
 * mutated afterwards.
 */
function snapshot(
  overrides: BrandingThemeOverrides,
): Readonly<BrandingThemeOverrides> {
  const copy: BrandingThemeOverrides = {};
  for (const mode of MODES) {
    const source = overrides[mode];
    if (source) copy[mode] = Object.freeze(toModeOverrides({ ...source }));
  }
  return Object.freeze(copy);
}

function writeMode(
  root: HTMLElement,
  overrides: Readonly<BrandingThemeOverrides>,
) {
  const values = overrides[currentThemeMode(root)] ?? {};
  for (const property of BRANDING_THEME_PROPERTIES) {
    // Re-checked at the write itself: nothing but an allowlisted property with
    // a hex value can reach setProperty, whatever produced `overrides`.
    const color = parseHexColor(values[property]);
    if (color) root.style.setProperty(property, color);
    else root.style.removeProperty(property);
  }
}

/**
 * Apply validated overrides for the root's current mode, and keep them in
 * step when the mode changes (`data-theme` flips): a value that is only valid
 * in one mode must not survive into the other. `null` or empty clears every
 * branding property and stops watching.
 *
 * Inline style on the theme-scope element outranks the stylesheet's
 * `[data-theme="light"]` and channel blocks, so a provider theme wins over a
 * channel retint; the device accent picker writes `--accent-primary`, which
 * sits above the roles and still wins over both.
 */
export function applyBrandingTheme(
  root: HTMLElement,
  overrides: BrandingThemeOverrides | null,
): void {
  const state = rootState.get(root);
  const empty = !overrides || MODES.every((mode) => !overrides[mode]);
  if (empty) {
    state?.observer?.disconnect();
    rootState.delete(root);
    for (const property of BRANDING_THEME_PROPERTIES)
      root.style.removeProperty(property);
    return;
  }
  const frozen = snapshot(overrides);
  const next: RootState = state ?? { overrides: frozen, observer: null };
  next.overrides = frozen;
  if (!next.observer && typeof MutationObserver !== 'undefined') {
    next.observer = new MutationObserver(() => {
      const live = rootState.get(root);
      if (live) writeMode(root, live.overrides);
    });
    next.observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }
  rootState.set(root, next);
  writeMode(root, frozen);
}

/**
 * The last validated theme, so the boot path can apply it before the first
 * render instead of flashing the default until `/api/branding` answers. It is
 * re-validated on read: storage is as untrusted as the endpoint.
 */
export const BRANDING_THEME_STORAGE_KEY = 'station-branding-theme-v1';

export function resolveCachedBrandingTheme(
  raw: string | null,
): BrandingThemeOverrides | null {
  if (!raw) return null;
  try {
    const { overrides } = resolveBrandingTheme(JSON.parse(raw));
    return MODES.some((mode) => overrides[mode]) ? overrides : null;
  } catch {
    return null;
  }
}
