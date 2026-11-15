/**
 * Custom appearance: a person's own palette and CSS, stored per person and
 * proposed by agents for the person to preview and keep
 * (docs/decisions/custom-appearance.md).
 *
 * This module owns the shapes and the checks both sides apply: the palette
 * roles, the hex and contrast rules, the CSS text check, and the stable hook
 * selectors. It has no contrast arithmetic of its own: callers pass the
 * WCAG ratio they already use (`@kontourai/ui/contrast`'s `contrastRatio`), so
 * there is one implementation of the formula.
 *
 * The text check is early feedback, not the sandbox. The browser parses the
 * CSS into a constructed stylesheet and drops what fetches
 * (`src-ui/src/lib/custom-appearance/sanitize-css.ts`); this check refuses at
 * the server what that guard would drop, so an agent learns at proposal time.
 */

/**
 * The `@kontourai/ui` `--k-*` roles a palette (and a named color theme) may
 * set. The UI's color-theme catalog reads this list rather than keeping its
 * own.
 */
export const APPEARANCE_ROLE_PROPERTIES = [
  '--k-bg',
  '--k-panel',
  '--k-panel-raised',
  '--k-line',
  '--k-line-strong',
  '--k-text',
  '--k-text-muted',
  '--k-text-faint',
  '--k-status-contrast',
  '--k-positive',
  '--k-caution',
  '--k-negative',
  '--k-active',
] as const;

export type AppearanceRoleProperty =
  (typeof APPEARANCE_ROLE_PROPERTIES)[number];

export const APPEARANCE_MODES = ['dark', 'light'] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];

/** One mode's palette: some roles, and an accent for brand, action and focus. */
export interface CustomAppearanceModePalette {
  roles?: Partial<Record<AppearanceRoleProperty, string>>;
  /** Brand, action and focus. Its text partner is derived (black or white). */
  accent?: string;
}

export interface CustomAppearance {
  version: 1;
  /** What the person sees it called. */
  name: string;
  palette: Partial<Record<AppearanceMode, CustomAppearanceModePalette>>;
  /** Applied after Station's own styles. Empty for a palette-only appearance. */
  css: string;
}

export const CUSTOM_APPEARANCE_CSS_MAX_LENGTH = 50_000;
export const CUSTOM_APPEARANCE_NAME_MAX_LENGTH = 80;
/** The reserved query parameter and value that suspend custom appearance in one tab. */
export const CUSTOM_APPEARANCE_SAFE_PARAM = 'appearance';
export const CUSTOM_APPEARANCE_SAFE_VALUE = 'safe';
/** How long a preview stays before it reverts on its own. */
export const CUSTOM_APPEARANCE_PREVIEW_SECONDS = 20;

export interface CustomAppearanceProposal {
  /** Server-computed digest of `appearance`; a render report names it. */
  id: string;
  appearance: CustomAppearance;
  proposedAt: string;
}

/** What the person's browser saw when it previewed a proposal. */
export interface CustomAppearanceRenderReport {
  proposalId: string;
  reportedAt: string;
  /** The mode the preview rendered in; the other mode was not rendered. */
  mode: AppearanceMode;
  hooks: { id: string; selector: string; matched: number }[];
  /** Ratings of the computed values on screen. */
  contrast: CustomAppearanceContrastResult[];
  /** What the browser's CSS guard removed. */
  stripped: CustomCssStripped[];
}

export interface CustomAppearanceDocument {
  /** Opaque precondition over `active` and `proposal`. */
  revision: string;
  /**
   * Opaque, stable per person on this Station. The browser keys its pre-paint
   * cache with it, so a different person's answer replaces the cache.
   */
  owner: string;
  active: CustomAppearance | null;
  proposal: CustomAppearanceProposal | null;
  /** The latest render report for the current proposal, if the person previewed it. */
  renderReport: CustomAppearanceRenderReport | null;
}

export interface CustomAppearanceProposalInput {
  revision: string;
  appearance: CustomAppearance;
}
/** A person's own save; `null` turns custom appearance off. */
export interface CustomAppearanceSaveInput {
  revision: string;
  appearance: CustomAppearance | null;
}

export interface CustomCssStripped {
  /** The rule's selector or at-rule prelude, cut to 120 characters. */
  where: string;
  /** The property, or the at-rule's name. */
  what: string;
  reason: CustomCssViolationKind;
}

export type CustomCssViolationKind =
  | 'too-long'
  | 'escape'
  | 'import'
  | 'remote-url'
  | 'image-function'
  | 'font-face'
  | 'at-rule';

export interface CustomAppearanceViolation {
  kind:
    | CustomCssViolationKind
    | 'invalid-shape'
    | 'invalid-color'
    | 'unknown-role'
    | 'contrast';
  message: string;
}

export interface CustomAppearanceContrastResult {
  mode: AppearanceMode;
  foreground: string;
  surface: string;
  ratio: number;
  minimum: number;
  pass: boolean;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
export const isAppearanceHex = (value: unknown): value is string =>
  typeof value === 'string' && HEX.test(value);

/**
 * Value fragments that make the browser fetch. Checked on lowercased text
 * with comments removed; the browser guard checks the same list on the
 * parsed, unescaped values.
 */
const FETCHING_FUNCTIONS: readonly [RegExp, CustomCssViolationKind][] = [
  [/(?:^|[^a-z0-9_-])(?:-webkit-)?image-set\(/, 'image-function'],
  [/(?:^|[^a-z0-9_-])(?:-webkit-)?cross-fade\(/, 'image-function'],
  [/(?:^|[^a-z0-9_-])image\(/, 'image-function'],
  [/(?:^|[^a-z0-9_-])src\(/, 'remote-url'],
  [/(?:^|[^a-z0-9_-])attr\(/, 'remote-url'],
];

/** `url(` arguments other than `data:` and `#fragment`, in normalized text. */
function remoteUrl(text: string): string | null {
  const pattern = /url\(\s*(['"]?)\s*([^'")\s]*)/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const target = match[2] ?? '';
    if (!target.startsWith('data:') && !target.startsWith('#')) return target;
  }
  return null;
}

/**
 * The fetching constructs in one normalized value (lowercased, no comments),
 * for a declaration value or a whole sheet. `null` when it fetches nothing.
 */
export function fetchingValueKind(
  normalized: string,
): CustomCssViolationKind | null {
  if (normalized.includes('\\')) return 'escape';
  if (remoteUrl(normalized) !== null) return 'remote-url';
  for (const [pattern, kind] of FETCHING_FUNCTIONS)
    if (pattern.test(normalized)) return kind;
  return null;
}

const stripComments = (css: string) =>
  css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '');

/**
 * The text check: length, escapes, `@import`, `@font-face` and every
 * fetching function. Conservative on purpose: a string that only looks like
 * `url(https://…)` (inside `content: "…"`) is refused too.
 */
export function customCssTextViolations(
  css: string,
): CustomAppearanceViolation[] {
  const violations: CustomAppearanceViolation[] = [];
  if (css.length > CUSTOM_APPEARANCE_CSS_MAX_LENGTH)
    violations.push({
      kind: 'too-long',
      message: `CSS is ${css.length} characters; the limit is ${CUSTOM_APPEARANCE_CSS_MAX_LENGTH}.`,
    });
  // Both the text with comments removed (so `ur/**/l(` cannot hide a url)
  // and the raw text (so a `/*` inside a string cannot hide what follows).
  const text = `${stripComments(css)}\n${css}`.toLowerCase();
  if (text.includes('\\'))
    violations.push({
      kind: 'escape',
      message: 'Backslash escapes are not allowed in custom CSS.',
    });
  if (/@import\b/.test(text))
    violations.push({
      kind: 'import',
      message: '@import is not allowed: custom CSS cannot load other files.',
    });
  if (/@font-face\b/.test(text))
    violations.push({
      kind: 'font-face',
      message: '@font-face is not allowed: custom CSS cannot load fonts.',
    });
  const url = remoteUrl(text);
  if (url !== null)
    violations.push({
      kind: 'remote-url',
      message: `url(${url.slice(0, 60)}) is not allowed: only data: and #fragment URLs are.`,
    });
  for (const [pattern, kind] of FETCHING_FUNCTIONS) {
    const match = pattern.exec(text);
    if (match)
      violations.push({
        kind,
        message: `${match[0].replace(/^[^a-z-]/, '')}…) is not allowed: it can load a remote resource.`,
      });
  }
  return violations;
}

/**
 * The at-rules the browser guard keeps. Every other at-rule (`@font-face`,
 * `@import`, `@namespace`, `@page`, `@property`, unknown ones) is dropped.
 */
export const CUSTOM_CSS_ALLOWED_AT_RULES = [
  'media',
  'supports',
  'container',
  'layer',
  'keyframes',
] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/**
 * Parse an appearance from untrusted JSON: shape, name, hex colours, known
 * roles and the CSS text check. Contrast is rated separately
 * ({@link rateAppearancePalette}) because it needs a ratio function.
 */
export function parseCustomAppearance(
  input: unknown,
):
  | { ok: true; value: CustomAppearance }
  | { ok: false; violations: CustomAppearanceViolation[] } {
  const violations: CustomAppearanceViolation[] = [];
  const shape = (message: string) =>
    violations.push({ kind: 'invalid-shape', message });
  if (!isPlainObject(input)) {
    shape('An appearance is an object.');
    return { ok: false, violations };
  }
  for (const key of Object.keys(input))
    if (!['version', 'name', 'palette', 'css'].includes(key))
      shape(`Unknown field ${key.slice(0, 40)}.`);
  if (input.version !== 1) shape('version must be 1.');
  const name = input.name;
  if (
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    name.length > CUSTOM_APPEARANCE_NAME_MAX_LENGTH
  )
    shape(`name must be 1 to ${CUSTOM_APPEARANCE_NAME_MAX_LENGTH} characters.`);
  const css = input.css ?? '';
  if (typeof css !== 'string') shape('css must be a string.');
  else violations.push(...customCssTextViolations(css));
  const palette: CustomAppearance['palette'] = {};
  const rawPalette = input.palette ?? {};
  if (!isPlainObject(rawPalette)) shape('palette is an object.');
  else
    for (const [mode, rawMode] of Object.entries(rawPalette)) {
      if (!(APPEARANCE_MODES as readonly string[]).includes(mode)) {
        shape(`Unknown palette mode ${mode.slice(0, 20)}.`);
        continue;
      }
      if (!isPlainObject(rawMode)) {
        shape(`palette.${mode} is an object.`);
        continue;
      }
      const out: CustomAppearanceModePalette = {};
      for (const key of Object.keys(rawMode))
        if (key !== 'roles' && key !== 'accent')
          shape(`Unknown field palette.${mode}.${key.slice(0, 40)}.`);
      if (rawMode.accent !== undefined) {
        if (isAppearanceHex(rawMode.accent)) out.accent = rawMode.accent;
        else
          violations.push({
            kind: 'invalid-color',
            message: `palette.${mode}.accent must be #rgb or #rrggbb.`,
          });
      }
      if (rawMode.roles !== undefined) {
        if (!isPlainObject(rawMode.roles))
          shape(`palette.${mode}.roles is an object.`);
        else {
          const roles: Partial<Record<AppearanceRoleProperty, string>> = {};
          for (const [role, value] of Object.entries(rawMode.roles)) {
            if (
              !(APPEARANCE_ROLE_PROPERTIES as readonly string[]).includes(role)
            ) {
              violations.push({
                kind: 'unknown-role',
                message: `${role.slice(0, 40)} is not a palette role. Roles: ${APPEARANCE_ROLE_PROPERTIES.join(', ')}.`,
              });
              continue;
            }
            if (!isAppearanceHex(value)) {
              violations.push({
                kind: 'invalid-color',
                message: `palette.${mode}.roles.${role} must be #rgb or #rrggbb.`,
              });
              continue;
            }
            roles[role as AppearanceRoleProperty] = value;
          }
          if (Object.keys(roles).length > 0) out.roles = roles;
        }
      }
      if (out.roles || out.accent) palette[mode as AppearanceMode] = out;
    }
  if (violations.length > 0) return { ok: false, violations };
  return {
    ok: true,
    value: {
      version: 1,
      name: (name as string).trim(),
      palette,
      css: css as string,
    },
  };
}

export type ContrastRatio = (a: string, b: string) => number;

/** The text partner of an accent: whichever of black and white reads better on it. */
export function appearanceAccentContrast(
  accent: string,
  ratio: ContrastRatio,
): '#000000' | '#ffffff' {
  return ratio('#000000', accent) >= ratio('#ffffff', accent)
    ? '#000000'
    : '#ffffff';
}

export const APPEARANCE_TEXT = 4.5;
const SURFACES = ['--k-bg', '--k-panel', '--k-panel-raised'] as const;
const TONES = [
  '--k-positive',
  '--k-caution',
  '--k-negative',
  '--k-active',
] as const;

/**
 * The text-on-surface rules a palette is rated against: the color-theme
 * catalog's rules (`color-theme-contrast.test.ts`, DESIGN.md "Colors",
 * `validateBrandOverride`'s brand-as-text pair and Station's action-as-text
 * rule), all at the 4.5:1 text threshold. `accent` stands for the brand and
 * action roles, `accent-contrast` for their derived text partner.
 */
export const APPEARANCE_CONTRAST_RULES: readonly {
  foreground: string;
  surface: string;
}[] = [
  ...(
    ['--k-text', '--k-text-muted', '--k-text-faint', 'accent'] as const
  ).flatMap((foreground) =>
    SURFACES.map((surface) => ({ foreground, surface })),
  ),
  ...TONES.flatMap((tone) => [
    { foreground: tone, surface: '--k-bg' },
    { foreground: tone, surface: '--k-panel' },
    { foreground: '--k-status-contrast', surface: tone },
  ]),
  { foreground: 'accent-contrast', surface: 'accent' },
];

/**
 * Rate one mode's values. Only pairs whose two values are both known are
 * rated, so the server rates what a proposal names on its own and the
 * browser rates the full computed set.
 */
export function rateAppearancePalette(
  mode: AppearanceMode,
  values: Partial<Record<string, string>>,
  ratio: ContrastRatio,
): CustomAppearanceContrastResult[] {
  const known: Partial<Record<string, string>> = { ...values };
  if (known.accent && !known['accent-contrast'])
    known['accent-contrast'] = appearanceAccentContrast(known.accent, ratio);
  const results: CustomAppearanceContrastResult[] = [];
  for (const { foreground, surface } of APPEARANCE_CONTRAST_RULES) {
    const fg = known[foreground];
    const bg = known[surface];
    if (!isAppearanceHex(fg) || !isAppearanceHex(bg)) continue;
    const value = ratio(fg, bg);
    results.push({
      mode,
      foreground,
      surface,
      ratio: Math.round(value * 100) / 100,
      minimum: APPEARANCE_TEXT,
      pass: value >= APPEARANCE_TEXT,
    });
  }
  return results;
}

/** The pairs a proposal's own values fail, as violations. */
export function appearanceContrastViolations(
  appearance: CustomAppearance,
  ratio: ContrastRatio,
): CustomAppearanceViolation[] {
  const violations: CustomAppearanceViolation[] = [];
  for (const mode of APPEARANCE_MODES) {
    const palette = appearance.palette[mode];
    if (!palette) continue;
    const values = { ...palette.roles, accent: palette.accent };
    for (const result of rateAppearancePalette(mode, values, ratio))
      if (!result.pass)
        violations.push({
          kind: 'contrast',
          message: `${mode}: ${result.foreground} on ${result.surface} is ${result.ratio}:1; text needs ${result.minimum}:1.`,
        });
  }
  return violations;
}

export interface AppearanceHook {
  id: string;
  selector: string;
  description: string;
}

/**
 * The stable selectors custom CSS may rely on. Each is rendered by the
 * component that owns it, and a test per owner renders it and queries the
 * selector. Class names are not part of this contract and change freely.
 */
export const APPEARANCE_HOOKS: readonly AppearanceHook[] = [
  {
    id: 'sidebar',
    selector: '[data-surface="sidebar"]',
    description: 'The primary navigation sidebar.',
  },
  {
    id: 'region-left',
    selector: '[data-region="left"]',
    description: 'A docked pane region on the left.',
  },
  {
    id: 'region-right',
    selector: '[data-region="right"]',
    description: 'A docked pane region on the right (the chat dock).',
  },
  {
    id: 'region-bottom',
    selector: '[data-region="bottom"]',
    description: 'A docked pane region along the bottom.',
  },
  {
    id: 'chat-header',
    selector: '[data-surface="chat-header"]',
    description: 'The header of the chat dock: title, engine and actions.',
  },
  {
    id: 'transcript',
    selector: '[data-surface="transcript"]',
    description: 'The scrolling list of messages in a conversation.',
  },
  {
    id: 'user-message',
    selector: '[data-surface="message"][data-message-role="user"]',
    description: 'One message the person sent.',
  },
  {
    id: 'assistant-message',
    selector: '[data-surface="message"][data-message-role="assistant"]',
    description: 'One message from the agent.',
  },
  {
    id: 'composer',
    selector: '[data-surface="composer"]',
    description: 'The message composer: text box, attachments and Send.',
  },
  {
    id: 'dialog',
    selector: '[data-surface="dialog"]',
    description: 'A standard dialog panel.',
  },
  {
    id: 'menu',
    selector: '[data-surface="menu"]',
    description: 'An action or context menu.',
  },
  {
    id: 'button',
    selector: '[data-slot="button"]',
    description: 'A standard Station button.',
  },
];

/** What an agent is told before proposing. */
export const CUSTOM_APPEARANCE_GUIDE = {
  summary:
    'Propose small changes. You cannot see the result: the person previews it at /appearance, Keeps or Discards it, and the preview reverts by itself after ' +
    `${CUSTOM_APPEARANCE_PREVIEW_SECONDS} seconds. After they preview, get_appearance returns a render report: which hooks matched, contrast on the computed colours, and any CSS the browser removed.`,
  palette:
    'palette.dark and palette.light each take roles (a map of the roles below to #rgb or #rrggbb) and accent (one hex for brand, action and focus; its text colour is derived). Unset roles keep the current theme. Text roles must reach 4.5:1 on bg, panel and panel-raised.',
  css: `At most ${CUSTOM_APPEARANCE_CSS_MAX_LENGTH} characters, applied after Station's styles. No @import, @font-face, backslash escapes, image-set(), cross-fade(), image(), src(), attr(), or url() other than data: and #fragment. Allowed at-rules: ${CUSTOM_CSS_ALLOWED_AT_RULES.map((r) => `@${r}`).join(', ')}. Use the hook selectors; class names change without notice. Custom CSS is switched off while any approval or consent prompt is on screen.`,
  roles: APPEARANCE_ROLE_PROPERTIES,
  hooks: APPEARANCE_HOOKS,
  openPath: '/appearance',
} as const;
