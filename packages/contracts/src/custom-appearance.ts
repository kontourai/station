import { stationControlToolName } from './station-control-refusal.js';

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

export interface CustomAppearanceVisual {
  background?: {
    dataUrl: string;
    size: 'cover' | 'contain' | 'tile';
    position: 'center' | 'top' | 'bottom' | 'left' | 'right';
    dim: number;
  };
  panelOpacity?: number;
  radius?: number;
  fontSize?: number;
}

export interface CustomAppearance {
  version: 1;
  /** What the person sees it called. */
  name: string;
  palette: Partial<Record<AppearanceMode, CustomAppearanceModePalette>>;
  /** Applied after Station's own styles. Empty for a palette-only appearance. */
  css: string;
  visual?: CustomAppearanceVisual;
}

export const CUSTOM_APPEARANCE_IMAGE_MAX_BYTES = 1024 * 1024;
export const CUSTOM_APPEARANCE_IMAGE_MAX_DIMENSION = 4096;
export const CUSTOM_APPEARANCE_THEME_PACK_MAX_BYTES = 1536 * 1024;
export const CUSTOM_APPEARANCE_LIBRARY_MAX_ENTRIES = 24;

export interface CustomAppearanceThemePack {
  format: 'station-appearance';
  version: 1;
  appearance: CustomAppearance;
}

export interface CustomAppearanceLibraryEntry {
  id: string;
  name: string;
  appearance: CustomAppearance;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface CustomAppearanceLibraryDocument {
  revision: string;
  themes: CustomAppearanceLibraryEntry[];
}
export interface CustomAppearanceLibrarySaveInput {
  revision: string;
  id?: string;
  appearance: CustomAppearance;
  name?: string;
  favorite?: boolean;
}
export interface CustomAppearanceLibraryUpdateInput {
  revision: string;
  id: string;
  name?: string;
  favorite?: boolean;
}

export const CUSTOM_APPEARANCE_CSS_MAX_LENGTH = 50_000;
export const CUSTOM_APPEARANCE_NAME_MAX_LENGTH = 80;
/** The reserved query parameter and value that suspend custom appearance in one tab. */
export const CUSTOM_APPEARANCE_SAFE_PARAM = 'appearance';
export const CUSTOM_APPEARANCE_SAFE_VALUE = 'safe';
/** How long a preview stays before it reverts on its own. */
export const CUSTOM_APPEARANCE_PREVIEW_SECONDS = 20;

export interface CustomAppearanceProposalReference {
  id: string;
  name: string;
  sourceSessionId: string;
}

export function appearanceProposalReferenceView(
  value: unknown,
): CustomAppearanceProposalReference | undefined {
  if (
    !isPlainObject(value) ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.id) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > CUSTOM_APPEARANCE_NAME_MAX_LENGTH ||
    hasControlCharacters(value.name) ||
    typeof value.sourceSessionId !== 'string' ||
    !value.sourceSessionId.trim() ||
    value.sourceSessionId.length > 256 ||
    hasControlCharacters(value.sourceSessionId)
  )
    return undefined;
  return {
    id: value.id,
    name: value.name,
    sourceSessionId: value.sourceSessionId,
  };
}

/** Read the authoritative successful proposal envelope before history excerpts cut it. */
export function parseAppearanceProposalReference(
  toolName: string | undefined,
  output: unknown,
): CustomAppearanceProposalReference | undefined {
  if (stationControlToolName(toolName) !== 'propose_appearance')
    return undefined;
  const object = (input: unknown): Record<string, unknown> | undefined => {
    if (typeof input === 'string') {
      if (input.length > 4 * 1024 * 1024) return undefined;
      try {
        input = JSON.parse(input);
      } catch {
        return undefined;
      }
    }
    return isPlainObject(input) ? input : undefined;
  };
  let body = object(output);
  if (body?.isError === true) return undefined;
  if (Array.isArray(body?.content)) {
    if (body.content.length !== 1) return undefined;
    const block = object(body.content[0]);
    if (block?.type !== 'text') return undefined;
    body = object(block.text);
  }
  if (body?.success !== true || body.state !== 'proposed') return undefined;
  const proposal = object(object(body.data)?.proposal);
  if (!proposal || typeof proposal.proposedAt !== 'string') return undefined;
  const appearance = parseCustomAppearance(proposal.appearance);
  if (!appearance.ok) return undefined;
  return appearanceProposalReferenceView({
    id: proposal.id,
    name: appearance.value.name,
    sourceSessionId: proposal.sourceSessionId,
  });
}

/** A retained reference is meaningful only on its successful originating Session event. */
export function appearanceProposalReferenceOfEvent(event: {
  toolName?: string;
  output?: unknown;
  appearanceProposal?: unknown;
  status?: unknown;
  threadId: string;
}): CustomAppearanceProposalReference | undefined {
  if (
    stationControlToolName(event.toolName) !== 'propose_appearance' ||
    event.status !== 'success'
  )
    return undefined;
  const reference =
    parseAppearanceProposalReference(event.toolName, event.output) ??
    appearanceProposalReferenceView(event.appearanceProposal);
  return reference?.sourceSessionId === event.threadId ? reference : undefined;
}

export interface CustomAppearanceProposal {
  /** Server-computed digest of `appearance`; a render report names it. */
  id: string;
  appearance: CustomAppearance;
  proposedAt: string;
  /** Verified runtime caller Session; never accepted from proposal arguments. */
  sourceSessionId?: string;
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

/**
 * Properties whose `url(#id)` names an element in this document (an SVG
 * filter, mask, clip path or marker) rather than a resource to load. Anywhere
 * else a fragment-only URL resolves against the page and fetches the page
 * itself (`background-image: url(#x)`), so it counts as remote.
 */
export const LOCAL_REFERENCE_PROPERTIES: readonly string[] = [
  'filter',
  'clip-path',
  '-webkit-clip-path',
  'mask',
  '-webkit-mask',
  'mask-image',
  '-webkit-mask-image',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
  'offset-path',
];

/**
 * An exact list, no prefixes: `mask-box-image`, `mask-border` and their
 * `-webkit-` forms take images, so `url(#x)` there loads the page (found in
 * review). A Chromium test confirms each listed property makes no request.
 */
export function isLocalReferenceProperty(property: string): boolean {
  return LOCAL_REFERENCE_PROPERTIES.includes(property.trim().toLowerCase());
}
/** Functions whose argument is a URL or image the browser resolves. */
export const URL_TAKING_FUNCTION =
  /(?:^|[^a-z0-9_-])(?:url|src|(?:-webkit-)?image-set|image|(?:-webkit-)?cross-fade)\(/;

/**
 * Whether the browser will add a backslash when it serializes this value's
 * strings: a `"` inside a single-quoted string, or a control character in any
 * string. The browser guard refuses a backslash next to a URL-taking
 * function, so the server refuses what would produce one.
 */
function serializesWithEscape(value: string): boolean {
  let quote: string | null = null;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '"' || code < 0x20 || code === 0x7f) return true;
    } else if (char === '"' || char === "'") quote = char;
  }
  return false;
}

/**
 * `url(` arguments that load something, in normalized text: anything but
 * `data:`, and `#fragment` only where `property` takes a local reference.
 */
function remoteUrl(text: string, property = ''): string | null {
  const pattern = /url\(\s*(['"]?)\s*([^'")\s]*)/g;
  const fragmentAllowed = isLocalReferenceProperty(property);
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const target = match[2] ?? '';
    if (target.startsWith('data:')) continue;
    if (target.startsWith('#') && fragmentAllowed) continue;
    return target;
  }
  return null;
}

/**
 * The fetching constructs in one normalized declaration value (lowercased, no
 * comments) of `property`. `null` when it fetches nothing. Any backslash is an
 * `escape`; the browser guard decides first where a backslash is harmless.
 */
export function fetchingValueKind(
  normalized: string,
  property = '',
): CustomCssViolationKind | null {
  if (normalized.includes('\\')) return 'escape';
  if (remoteUrl(normalized, property) !== null) return 'remote-url';
  for (const [pattern, kind] of FETCHING_FUNCTIONS)
    if (pattern.test(normalized)) return kind;
  return null;
}

/**
 * Comments removed, outside strings only: `content: "/*"` keeps its string,
 * and a quote inside a real comment does not open one.
 */
export function stripCssComments(css: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < css.length; i += 1) {
    const char = css[i]!;
    if (quote) {
      out += char;
      if (char === '\\' && i + 1 < css.length) {
        out += css[i + 1];
        i += 1;
        // As in CSS, an unescaped newline ends an unterminated string.
      } else if (char === quote || char === '\n') quote = null;
      continue;
    }
    if (char === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? css.length : close + 1;
      out += ' ';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    out += char;
  }
  return out;
}

export interface CssDeclarationText {
  /** Lowercased text before the first top-level `:`, or '' if there is none. */
  property: string;
  /** The rest, as written. */
  value: string;
}

/**
 * Split CSS text (comments already removed) into declaration-shaped pieces
 * at `;`, `{` and `}` outside strings and parentheses. Selectors and at-rule
 * preludes come out as pieces too; checking them as values is conservative.
 * A `;` inside a string (`";"`) does not split a declaration.
 */
export function splitCssDeclarations(text: string): CssDeclarationText[] {
  const pieces: CssDeclarationText[] = [];
  let current = '';
  let colon = -1;
  let quote: string | null = null;
  let depth = 0;
  const flush = () => {
    if (current.trim())
      pieces.push(
        colon === -1
          ? { property: '', value: current }
          : {
              property: current.slice(0, colon).trim().toLowerCase(),
              value: current.slice(colon + 1),
            },
      );
    current = '';
    colon = -1;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) {
      current += char;
      if (char === '\\' && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
      } else if (char === quote || char === '\n') quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === ';' || char === '{' || char === '}')) {
      flush();
      continue;
    } else if (depth === 0 && char === ':' && colon === -1)
      colon = current.length;
    current += char;
  }
  flush();
  return pieces;
}

/**
 * The text check: length, escapes, `@import`, `@font-face` and every
 * fetching function, per declaration so `url(#id)` is allowed only where it
 * is a local reference. Conservative on purpose: a string that only looks
 * like `url(https://…)` (inside `content: "…"`) is refused too.
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
  const text = stripCssComments(css).toLowerCase();
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
  for (const { value } of splitCssDeclarations(text)) {
    if (URL_TAKING_FUNCTION.test(value) && serializesWithEscape(value)) {
      violations.push({
        kind: 'escape',
        message:
          'A double quote inside a single-quoted string next to url() is refused: inside url(), use single quotes in a data: SVG, or percent-encode the double quotes (%22).',
      });
      break;
    }
  }
  for (const { property, value } of splitCssDeclarations(text)) {
    const url = remoteUrl(value, property);
    if (url !== null) {
      violations.push({
        kind: 'remote-url',
        message: `url(${url.slice(0, 60)}) is not allowed: only data: URLs, and #fragment in filter, mask, clip-path and marker.`,
      });
      break;
    }
  }
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

/** C0 and DEL controls, and the bidirectional marks, embeddings, overrides and isolates. */
function hasControlCharacters(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code < 0x20 ||
      code === 0x7f ||
      code === 0x61c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return true;
  }
  return false;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/** Bounded raster headers, read without fetching or decoding compressed pixels. */
export function isCustomAppearanceRasterDataUrl(
  input: unknown,
): input is string {
  if (
    typeof input !== 'string' ||
    input.length > Math.ceil(CUSTOM_APPEARANCE_IMAGE_MAX_BYTES / 3) * 4 + 40
  )
    return false;
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input);
  if (!match) return false;
  const encoded = match[2]!;
  if (encoded.length % 4 !== 0) return false;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const length = (encoded.length / 4) * 3 - padding;
  if (length === 0 || length > CUSTOM_APPEARANCE_IMAGE_MAX_BYTES) return false;
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  // Refuse noncanonical padding bits rather than accepting multiple byte spellings.
  if (
    padding &&
    (alphabet.indexOf(encoded[encoded.length - padding - 1]!) &
      (padding === 2 ? 15 : 3)) !==
      0
  )
    return false;
  const bytes = Uint8Array.from(atob(encoded), (character) =>
    character.charCodeAt(0),
  );
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, count: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + count));
  let width = 0;
  let height = 0;
  if (match[1] === 'png') {
    if (
      length < 45 ||
      ascii(0, 8) !== '\x89PNG\r\n\x1a\n' ||
      view.getUint32(8) !== 13 ||
      ascii(12, 4) !== 'IHDR'
    )
      return false;
    width = view.getUint32(16);
    height = view.getUint32(20);
    let offset = 8;
    let image = false;
    let end = false;
    while (offset + 12 <= length) {
      const size = view.getUint32(offset);
      if (size > length - offset - 12) return false;
      const type = ascii(offset + 4, 4);
      if (type === 'acTL') return false;
      if (type === 'IDAT' && size > 0) image = true;
      offset += size + 12;
      if (type === 'IEND') {
        end = size === 0 && offset === length;
        break;
      }
    }
    if (!image || !end) return false;
  } else if (match[1] === 'jpeg') {
    if (
      length < 12 ||
      bytes[0] !== 255 ||
      bytes[1] !== 216 ||
      bytes[length - 2] !== 255 ||
      bytes[length - 1] !== 217
    )
      return false;
    let offset = 2;
    let scan = false;
    let ended = false;
    while (offset < length) {
      if (bytes[offset++] !== 255) {
        if (!scan) return false;
        continue;
      }
      while (offset < length && bytes[offset] === 255) offset++;
      if (offset >= length) return false;
      const marker = bytes[offset++]!;
      if (marker === 0 || (marker >= 208 && marker <= 215)) {
        if (!scan) return false;
        continue;
      }
      if (marker === 217) {
        ended = offset === length;
        break;
      }
      if (offset + 2 > length) return false;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > length) return false;
      if ([192, 193, 194].includes(marker)) {
        if (size < 8 || width !== 0) return false;
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
      } else if (
        [195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)
      )
        return false;
      if (marker === 218 && width === 0) return false;
      scan = marker === 218;
      offset += size;
    }
    if (!ended) return false;
  } else {
    if (
      length < 25 ||
      ascii(0, 4) !== 'RIFF' ||
      ascii(8, 4) !== 'WEBP' ||
      view.getUint32(4, true) + 8 !== length
    )
      return false;
    let offset = 12;
    let payload = false;
    let payloadWidth = 0;
    let payloadHeight = 0;
    while (offset + 8 <= length) {
      const chunkSize = view.getUint32(offset + 4, true);
      const chunkType = ascii(offset, 4);
      if (
        chunkSize > length - offset - 8 ||
        chunkType === 'ANIM' ||
        chunkType === 'ANMF'
      )
        return false;
      if (chunkType === 'VP8 ' || chunkType === 'VP8L') {
        if (payload) return false;
        payload = true;
        if (chunkType === 'VP8 ') {
          if (chunkSize < 10 || ascii(offset + 11, 3) !== '\x9d\x01\x2a')
            return false;
          payloadWidth = view.getUint16(offset + 14, true) & 0x3fff;
          payloadHeight = view.getUint16(offset + 16, true) & 0x3fff;
        } else {
          if (chunkSize < 5 || bytes[offset + 8] !== 47) return false;
          const bits = view.getUint32(offset + 9, true);
          payloadWidth = 1 + (bits & 0x3fff);
          payloadHeight = 1 + ((bits >>> 14) & 0x3fff);
        }
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    if (!payload || offset !== length) return false;
    const type = ascii(12, 4);
    const size = view.getUint32(16, true);
    if (size > length - 20) return false;
    if (type === 'VP8X') {
      if (size !== 10 || length < 30 || (bytes[20]! & 2) !== 0) return false;
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    } else if (type === 'VP8L') {
      if (size < 5 || bytes[20] !== 47) return false;
      const bits = view.getUint32(21, true);
      width = 1 + (bits & 0x3fff);
      height = 1 + ((bits >>> 14) & 0x3fff);
    } else if (type === 'VP8 ') {
      if (size < 10 || ascii(23, 3) !== '\x9d\x01\x2a') return false;
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    } else return false;
    if (width !== payloadWidth || height !== payloadHeight) return false;
  }
  return (
    width > 0 &&
    height > 0 &&
    width <= CUSTOM_APPEARANCE_IMAGE_MAX_DIMENSION &&
    height <= CUSTOM_APPEARANCE_IMAGE_MAX_DIMENSION &&
    width * height <= 16_000_000
  );
}

function parseVisual(
  input: unknown,
  shape: (message: string) => void,
): CustomAppearanceVisual | undefined {
  if (input === undefined) return undefined;
  if (!isPlainObject(input)) {
    shape('visual is an object.');
    return undefined;
  }
  const visual: CustomAppearanceVisual = {};
  for (const key of Object.keys(input))
    if (!['background', 'panelOpacity', 'radius', 'fontSize'].includes(key))
      shape(`Unknown visual field ${key.slice(0, 40)}.`);
  for (const [key, min, max] of [
    ['panelOpacity', 0.5, 1],
    ['radius', 0, 24],
    ['fontSize', 12, 20],
  ] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      value > max
    )
      shape(`visual.${key} must be ${min} to ${max}.`);
    else visual[key] = value;
  }
  if (input.background !== undefined) {
    const raw = input.background;
    if (!isPlainObject(raw)) shape('visual.background is an object.');
    else {
      for (const key of Object.keys(raw))
        if (!['dataUrl', 'size', 'position', 'dim'].includes(key))
          shape(`Unknown background field ${key.slice(0, 40)}.`);
      if (!isCustomAppearanceRasterDataUrl(raw.dataUrl))
        shape(
          'Background must be a PNG, JPEG or WebP base64 data URL, at most 1 MiB, 4096 pixels per side and 16 million pixels; animation is not supported.',
        );
      if (!['cover', 'contain', 'tile'].includes(raw.size as string))
        shape('Background size must be cover, contain or tile.');
      if (
        !['center', 'top', 'bottom', 'left', 'right'].includes(
          raw.position as string,
        )
      )
        shape('Background position is not supported.');
      if (
        typeof raw.dim !== 'number' ||
        !Number.isFinite(raw.dim) ||
        raw.dim < 0 ||
        raw.dim > 1
      )
        shape('Background dim must be 0 to 1.');
      if (
        typeof raw.dataUrl === 'string' &&
        (raw.size === 'cover' ||
          raw.size === 'contain' ||
          raw.size === 'tile') &&
        (raw.position === 'center' ||
          raw.position === 'top' ||
          raw.position === 'bottom' ||
          raw.position === 'left' ||
          raw.position === 'right') &&
        typeof raw.dim === 'number'
      )
        visual.background = {
          dataUrl: raw.dataUrl,
          size: raw.size,
          position: raw.position,
          dim: raw.dim,
        };
    }
  }
  return visual;
}

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
    if (!['version', 'name', 'palette', 'css', 'visual'].includes(key))
      shape(`Unknown field ${key.slice(0, 40)}.`);
  if (input.version !== 1) shape('version must be 1.');
  const name = input.name;
  if (
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    name.length > CUSTOM_APPEARANCE_NAME_MAX_LENGTH
  )
    shape(`name must be 1 to ${CUSTOM_APPEARANCE_NAME_MAX_LENGTH} characters.`);
  // Bidi controls could reorder the name in the preview bar ("proposed by an
  // agent" read backwards); other control characters have no place in it.
  if (typeof name === 'string' && hasControlCharacters(name))
    shape(
      'name must not contain control or bidirectional formatting characters.',
    );
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
  const visual = parseVisual(input.visual, shape);
  if (violations.length > 0) return { ok: false, violations };
  return {
    ok: true,
    value: {
      version: 1,
      name: (name as string).trim(),
      palette,
      css: css as string,
      ...(visual === undefined ? {} : { visual }),
    },
  };
}

/** Portable packs carry appearance bytes only, never owner or proposal state. */
export function createCustomAppearanceThemePack(
  appearance: CustomAppearance,
): CustomAppearanceThemePack {
  const parsed = parseCustomAppearance(appearance);
  if (!parsed.ok)
    throw new Error(parsed.violations.map((v) => v.message).join(' '));
  const pack: CustomAppearanceThemePack = {
    format: 'station-appearance',
    version: 1,
    appearance: parsed.value,
  };
  if (
    new TextEncoder().encode(JSON.stringify(pack)).length >
    CUSTOM_APPEARANCE_THEME_PACK_MAX_BYTES
  )
    throw new Error('Theme pack is too large.');
  return pack;
}

export function parseCustomAppearanceThemePack(
  input: unknown,
):
  | { ok: true; value: CustomAppearanceThemePack }
  | { ok: false; violations: CustomAppearanceViolation[] } {
  const invalid = (message: string) => ({
    ok: false as const,
    violations: [{ kind: 'invalid-shape' as const, message }],
  });
  if (typeof input === 'string') {
    if (
      input.length > CUSTOM_APPEARANCE_THEME_PACK_MAX_BYTES ||
      new TextEncoder().encode(input).length >
        CUSTOM_APPEARANCE_THEME_PACK_MAX_BYTES
    )
      return invalid('Theme pack is too large.');
    try {
      input = JSON.parse(input);
    } catch {
      return invalid('Theme pack must be valid JSON.');
    }
  }
  if (
    !isPlainObject(input) ||
    input.format !== 'station-appearance' ||
    input.version !== 1 ||
    Object.keys(input).some(
      (key) => !['format', 'version', 'appearance'].includes(key),
    )
  )
    return invalid('Unsupported theme pack format, version or fields.');
  const parsed = parseCustomAppearance(input.appearance);
  if (!parsed.ok) return parsed;
  const pack: CustomAppearanceThemePack = {
    format: 'station-appearance',
    version: 1,
    appearance: parsed.value,
  };
  if (
    new TextEncoder().encode(JSON.stringify(pack)).length >
    CUSTOM_APPEARANCE_THEME_PACK_MAX_BYTES
  )
    return invalid('Theme pack is too large.');
  return { ok: true, value: pack };
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
  css: `At most ${CUSTOM_APPEARANCE_CSS_MAX_LENGTH} characters, applied after Station's styles. No @import, @font-face, backslash escapes, image-set(), cross-fade(), image(), src(), attr(), or url() other than data: (and #fragment in filter, mask, clip-path and marker). Allowed at-rules: ${CUSTOM_CSS_ALLOWED_AT_RULES.map((r) => `@${r}`).join(', ')}. Use the hook selectors; class names change without notice. In a data: SVG inside url(), use single quotes or percent-encode double quotes (%22): a double quote inside a single-quoted string is refused. When you set a background, set its text colour too: contrast is rated on the palette, not on your CSS. In the render report, a stripped entry for (sheet) means the browser refused the whole CSS. Custom CSS is switched off while any approval or consent prompt is on screen.`,
  roles: APPEARANCE_ROLE_PROPERTIES,
  hooks: APPEARANCE_HOOKS,
  openPath: '/appearance',
} as const;
