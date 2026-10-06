/**
 * White-label theme overrides from the branding provider (`GET /api/branding`
 * `theme`), applied to the element that carries Station's theme scope.
 *
 * The contract is `@kontourai/ui`'s DESIGN.md "White-label overrides", and
 * the check is the package's own `validateBrandOverride`
 * (`@kontourai/ui/contrast`): the allowlist, hex-only values, the action pair
 * rule, every brand-slot contrast pair, and all-or-nothing acceptance. The
 * endpoint is a no-credential boot read supplied by a plugin, so everything
 * here is untrusted input: only what the validator accepted is applied, and
 * any rejection keeps the defaults, so an unreadable or half-applied theme
 * never lands.
 *
 * What stays in Station, because the shared validator does not cover it:
 *
 * - The input shape. Station also accepts the original flat
 *   `Record<string, string>` form; flat keys are expanded into both modes
 *   (per-mode entries winning) before the shared validator sees them, and a
 *   flat value a mode entry shadows must still be a hex colour. A mode that
 *   sets only the brand also gets it as its action (see `expandModes`).
 *
 *     { "--k-brand": "#…",                      // flat: expanded into both modes
 *       "dark":  { "--k-action": "#…", … },      // per mode: wins over flat
 *       "light": { "--k-action": "#…", … } }
 *
 * - One stricter contrast rule, for the action fill as text (see
 *   `STATION_SURFACE_TEXT_RULES`).
 * - The apply path: mode tracking, the write-time re-check, and the cache.
 */

import {
  type AcceptedBrandOverride,
  BRAND_SLOT_PROPERTIES,
  type BrandOverrideViolation,
  type BrandSlotProperty,
  type ContrastMode,
  contrastRatio,
  isHexColor,
  SHIPPED_THEMES,
  type SurfaceProperty,
  validateBrandOverride,
} from '@kontourai/ui/contrast';

/** The only properties a branding theme may set. Order is apply order. */
export const BRANDING_THEME_PROPERTIES = BRAND_SLOT_PROPERTIES;

export type BrandingThemeProperty = BrandSlotProperty;
export type BrandingThemeMode = ContrastMode;
export type BrandingModeOverrides = Partial<
  Record<BrandingThemeProperty, string>
>;
export type BrandingThemeOverrides = Partial<
  Record<BrandingThemeMode, BrandingModeOverrides>
>;

const MODES: readonly BrandingThemeMode[] = ['dark', 'light'];

/**
 * The shipped theme overrides are rated against. Station applies no
 * `.theme-*` class, so the effective defaults are the package's unthemed
 * tokens (`branding-theme.test.ts` pins this against the installed CSS).
 */
export const BRANDING_BASE_THEME = 'default';

/**
 * Station paints `--accent-primary` (which reads the action role) as link and
 * accent text on the page and the panel. The shared contract rates the action
 * fill on the panel at the non-text threshold (3:1) and not on the page at
 * all, so Station additionally requires AA text contrast (4.5:1) for it on
 * both surfaces. Only overridden properties are rated, like the shared
 * validator.
 *
 * The brand needs no rule here: from @kontourai/ui 1.18 the shared validator
 * itself rates it as text at 4.5:1 on the page, the panel and the raised
 * panel, which covers the sidebar channel badge.
 */
const STATION_SURFACE_TEXT_RULES: readonly {
  property: BrandingThemeProperty;
  surfaces: readonly SurfaceProperty[];
  minimum: number;
}[] = [
  { property: '--k-action', surfaces: ['--k-bg', '--k-panel'], minimum: 4.5 },
];

/** A rule Station applies on top of the shared validator. */
export interface StationSurfaceTextViolation {
  kind: 'station-surface-text';
  mode: BrandingThemeMode;
  property: BrandingThemeProperty;
  surface: SurfaceProperty;
  ratio: number;
  minimum: number;
  message: string;
}

export type BrandingThemeViolation =
  | BrandOverrideViolation
  | StationSurfaceTextViolation;

function stationSurfaceTextViolations(
  mode: BrandingThemeMode,
  values: Record<string, unknown>,
): StationSurfaceTextViolation[] {
  const shipped = SHIPPED_THEMES[BRANDING_BASE_THEME][mode];
  const violations: StationSurfaceTextViolation[] = [];
  for (const { property, surfaces, minimum } of STATION_SURFACE_TEXT_RULES) {
    const value = values[property];
    // A non-hex value is already the shared validator's violation.
    if (!isHexColor(value)) continue;
    for (const surface of surfaces) {
      const ratio = contrastRatio(value, shipped[surface]);
      if (ratio < minimum) {
        violations.push({
          kind: 'station-surface-text',
          mode,
          property,
          surface,
          ratio,
          minimum,
          message: `${mode}: ${property} ${value} as text on ${surface} ${shipped[surface]} = ${ratio.toFixed(2)}:1 (Station needs ${minimum}:1)`,
        });
      }
    }
  }
  return violations;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Copy own enumerable keys into a prototype-free record, so a key such as
 * `__proto__` (an own key after JSON.parse) is carried as data and then
 * rejected by the validator instead of rewiring the object.
 */
function copyInto(
  into: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const key of Object.keys(source)) {
    Object.defineProperty(into, key, {
      value: source[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

/**
 * Expand Station's input shape into the shared `{ dark?, light? }` shape: flat
 * top-level keys go into both modes, per-mode entries win for their mode. A
 * mode entry that is not an object is passed through unchanged, so the
 * validator reports it. A mode with nothing in it is left out.
 *
 * A mode that sets `--k-brand` but neither action property also gets the
 * brand as its action (`--k-action`), with `--k-brand-contrast` (or the
 * shipped action contrast) as `--k-action-contrast`. Before @kontourai/ui
 * defined the action role, buttons, links and the accent read the brand; the
 * installed tokens now define `--k-action` as a literal, so without this a
 * brand-only theme would leave them on the shipped colour. The expanded pair
 * goes through the validator and Station's action rule like any other.
 */
function expandModes(input: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(input)) {
    if (key === 'dark' || key === 'light') continue;
    copyInto(flat, { [key]: input[key] });
  }
  const expanded: Record<string, unknown> = Object.create(null);
  for (const mode of MODES) {
    const specific = Object.hasOwn(input, mode) ? input[mode] : undefined;
    if (specific !== undefined && !isPlainObject(specific)) {
      expanded[mode] = specific;
      continue;
    }
    const merged: Record<string, unknown> = Object.create(null);
    copyInto(merged, flat);
    if (specific) copyInto(merged, specific);
    if (
      Object.hasOwn(merged, '--k-brand') &&
      !Object.hasOwn(merged, '--k-action') &&
      !Object.hasOwn(merged, '--k-action-contrast')
    ) {
      copyInto(merged, {
        '--k-action': merged['--k-brand'],
        '--k-action-contrast': Object.hasOwn(merged, '--k-brand-contrast')
          ? merged['--k-brand-contrast']
          : SHIPPED_THEMES[BRANDING_BASE_THEME][mode]['--k-action-contrast'],
      });
    }
    if (Object.keys(merged).length > 0) expanded[mode] = merged;
  }
  return expanded;
}

/**
 * A flat value a per-mode entry replaces never reaches the validator, but it
 * is still part of the theme: an invalid one rejects the theme, as before the
 * swap to the shared validator. Reported against each mode that shadows it,
 * in the validator's own `invalid-value` shape.
 */
function shadowedFlatViolations(
  input: Record<string, unknown>,
): BrandOverrideViolation[] {
  const violations: BrandOverrideViolation[] = [];
  for (const mode of MODES) {
    const specific = Object.hasOwn(input, mode) ? input[mode] : undefined;
    if (!isPlainObject(specific)) continue;
    for (const property of BRANDING_THEME_PROPERTIES) {
      if (!Object.hasOwn(input, property) || !Object.hasOwn(specific, property))
        continue;
      const value = input[property];
      if (isHexColor(value)) continue;
      violations.push({
        kind: 'invalid-value',
        mode,
        property,
        message: `${mode}: flat ${property} ${String(value).slice(0, 64)} is not a #rgb or #rrggbb colour (shadowed by the ${mode} entry)`,
      });
    }
  }
  return violations;
}

export interface ResolvedBrandingTheme {
  overrides: AcceptedBrandOverride;
  violations: BrandingThemeViolation[];
}

/**
 * Parse an untrusted branding `theme` into validated per-mode overrides.
 *
 * ALL OR NOTHING: if the shared validator or a Station rule rejects anything
 * — an unknown key, a value that is not a hex colour, an unpaired action, or
 * a contrast failure in either mode — nothing is applied and the defaults
 * stay. A half-applied brand is a design nobody reviewed. Every violation is
 * still reported for the log. `overrides` is the validator's `accepted`, so
 * what lands is exactly what was rated.
 */
export function resolveBrandingTheme(input: unknown): ResolvedBrandingTheme {
  if (input === null || input === undefined)
    return { overrides: {}, violations: [] };
  // A non-object theme goes to the validator as-is; it reports the shape.
  const expanded = isPlainObject(input) ? expandModes(input) : input;
  const { violations, accepted } = validateBrandOverride({
    base: BRANDING_BASE_THEME,
    overrides: expanded,
  });
  const all: BrandingThemeViolation[] = [...violations];
  if (isPlainObject(input)) all.push(...shadowedFlatViolations(input));
  if (isPlainObject(expanded)) {
    for (const mode of MODES) {
      const values = expanded[mode];
      if (isPlainObject(values))
        all.push(...stationSurfaceTextViolations(mode, values));
    }
  }
  return { overrides: all.length === 0 ? accepted : {}, violations: all };
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
  // Messages echo caller data (clipped to 64 characters); console only.
  for (const v of violations.slice(0, MAX_LOGGED_VIOLATIONS)) {
    console.warn(`[branding-theme] rejected (${v.kind}) ${v.message}`);
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
  overrides: Readonly<BrandingThemeOverrides>,
): Readonly<BrandingThemeOverrides> {
  const copy: BrandingThemeOverrides = {};
  for (const mode of MODES) {
    const source = overrides[mode];
    if (!source) continue;
    const values: BrandingModeOverrides = {};
    for (const property of BRANDING_THEME_PROPERTIES) {
      const value = source[property];
      if (value !== undefined) values[property] = value;
    }
    copy[mode] = Object.freeze(values);
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
    const value = values[property];
    if (isHexColor(value))
      root.style.setProperty(property, value.toLowerCase());
    else root.style.removeProperty(property);
  }
  // Keyed on what was actually written for this mode, so a theme that sets
  // focus in one mode only hands the ring back to the accent in the other.
  if (root.style.getPropertyValue('--k-focus'))
    root.setAttribute(BRANDING_FOCUS_ATTRIBUTE, '');
  else root.removeAttribute(BRANDING_FOCUS_ATTRIBUTE);
}

/**
 * Set on the theme-scope element while the applied theme supplies
 * `--k-focus` for the current mode. index.css paints the keyboard focus ring
 * from `--k-focus` only under it, and from `--accent-primary` otherwise.
 *
 * @kontourai/ui 1.16 defines `--k-focus` in its tokens, so "is `--k-focus`
 * defined" can no longer tell a white-label focus colour from the default.
 * The marker keeps the device accent chosen in Appearance on the ring unless
 * a white-label theme chose a focus colour (Dev, Beta and Nightly builds
 * keep their own focus colour through index.css's channel selectors).
 */
export const BRANDING_FOCUS_ATTRIBUTE = 'data-brand-focus';

/**
 * Apply validated overrides for the root's current mode, and keep them in
 * step when the mode changes (`data-theme` flips): a value that is only valid
 * in one mode must not survive into the other. `null` or empty clears every
 * branding property and stops watching.
 *
 * Inline style on the theme-scope element outranks the stylesheet's
 * `[data-theme="light"]` and channel blocks, so a provider theme wins over a
 * channel retint; the device accent picker writes `--accent-primary`, which
 * sits above the roles and still wins over both. The focus ring follows the
 * accent too, unless this theme supplies `--k-focus` for the current mode
 * (`BRANDING_FOCUS_ATTRIBUTE`).
 */
export function applyBrandingTheme(
  root: HTMLElement,
  overrides: Readonly<BrandingThemeOverrides> | null,
): void {
  const state = rootState.get(root);
  const empty = !overrides || MODES.every((mode) => !overrides[mode]);
  if (empty) {
    state?.observer?.disconnect();
    rootState.delete(root);
    for (const property of BRANDING_THEME_PROPERTIES)
      root.style.removeProperty(property);
    root.removeAttribute(BRANDING_FOCUS_ATTRIBUTE);
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
): AcceptedBrandOverride | null {
  if (!raw) return null;
  try {
    const { overrides } = resolveBrandingTheme(JSON.parse(raw));
    return MODES.some((mode) => overrides[mode]) ? overrides : null;
  } catch {
    return null;
  }
}
