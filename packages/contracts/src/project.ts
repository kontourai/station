import type { AgentId } from './agent-identity.js';
import type { EnvironmentRef } from './execution-target.js';
import type { KnowledgeNamespaceConfig } from './knowledge.js';
import type { ProjectMemberAction } from './project-membership.js';
import type { WorkspaceIsolationMode } from './workspace-isolation.js';

export interface ProjectConfig {
  id: string;
  name: string;
  slug: string;
  icon?: string;
  description?: string;
  workingDirectory?: string;
  /** Default workspace mode for newly started project threads. */
  defaultWorkspaceIsolation?: WorkspaceIsolationMode;
  /** Environment used when project execution does not select one explicitly. */
  defaultEnvironment?: EnvironmentRef;
  defaultProviderId?: string;
  defaultModel?: string;
  /** Agent used for new chats when this project has no remembered choice. */
  defaultAgent?: AgentId;
  defaultEmbeddingProviderId?: string;
  defaultEmbeddingModel?: string;
  similarityThreshold?: number;
  topK?: number;
  agents?: AgentId[];
  knowledgeNamespaces?: KnowledgeNamespaceConfig[];
  /**
   * Server-owned explicit sidebar position (station#3315). Assigned by the
   * reorder operation; projects without one list after positioned ones, in
   * name order, so an unordered workspace stays deterministic.
   */
  position?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMetadata {
  id: string;
  slug: string;
  name: string;
  icon?: string;
  description?: string;
  hasWorkingDirectory: boolean;
  workingDirectory?: string;
  layoutCount: number;
  hasKnowledge: boolean;
  defaultProviderId?: string;
  /** See {@link ProjectConfig.position}; the list route returns projects sorted by it. */
  position?: number;
  /**
   * #3370: the directory this project resolves to on this Station (identity
   * not verified). Present on the operator's own project list; absent from a
   * member's view and from servers that predate it.
   */
  runsAt?: ProjectRunsAt;
}

/**
 * The directory a project resolves to on this Station, from the records the
 * session start reads (manifest, binding, working directory and the
 * manifest's `executionRoot`). The start's git identity check is NOT run, so
 * a path here is the directory the records name, not a verified checkout of
 * the project's repository: a start may still refuse it. It is also not
 * where every chat runs: a chat in a worktree-isolated project runs in its
 * own worktree, and a project with no directory leaves it to the agent.
 *
 * - `folder`: the project's own working directory, as stored.
 * - `execution-root`: a different directory the manifest selects, through a
 *   binding or its `executionRoot`; absolute.
 * - `none`: no directory; the agent decides (home, an ACP connection's
 *   folder, or a private Station-managed one).
 * - `unavailable`: a start would be refused (a missing folder or binding, an
 *   execution root outside its checkout…); `reason` says why.
 * - `unchecked`: Station did not find out this time, because the folder did
 *   not answer in time or other folders were still being checked. Not a
 *   refusal: the start resolves it for real. `reason` says which.
 */
export type ProjectRunsAt =
  | { kind: 'folder'; path: string }
  | { kind: 'execution-root'; path: string }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'unchecked'; reason: string };

export interface MemberProjectView {
  version: 'station.member-project/v1';
  kind: 'member-project';
  id: string;
  slug: string;
  name: string;
  icon?: string;
  description?: string;
  actions: readonly ProjectMemberAction[];
}

export interface ProjectIconCandidate {
  /** Path relative to the selected workspace; never exposes another directory. */
  relativePath: string;
  /** Same-origin, in-memory image payload. Station never uploads discovered artwork. */
  dataUrl: string;
  mediaType: string;
  source: 'manifest' | 'favicon' | 'app-icon' | 'logo';
}

/**
 * The one derivation of "that project name is already taken", shared by the
 * server (`POST /api/projects`'s 409) and by the New Project modal's pre-POST
 * check (4-HOME-007). Both sides answer the same sentence from the same
 * inputs, so the modal cannot promise something the route would contradict.
 *
 * It lives in contracts rather than in either half because both halves are
 * consumers: `src-server/routes/projects/projects.ts` computes it from the
 * project store, `src-ui`'s `useNewProjectSlugAvailability` from the already
 * cached `['projects']` list.
 */
export interface ProjectSlugConflict {
  /** The slug the request would have created, which is already in use. */
  takenSlug: string;
  /** The first free `<slug>-N`, computed from the SAME set of taken slugs. */
  suggestedSlug: string;
}

/**
 * First unused `<base>-2`, `<base>-3`, … for a base slug that is taken.
 * Mirrors `ProjectService.createProject`'s own suffix loop for a caller that
 * omits a slug, so a suggestion and an auto-derived slug never disagree.
 */
export function nextAvailableProjectSlug(
  baseSlug: string,
  takenSlugs: Iterable<string>,
): string {
  const taken = new Set(takenSlugs);
  if (!taken.has(baseSlug)) return baseSlug;
  let suffix = 2;
  while (taken.has(`${baseSlug}-${suffix}`)) suffix += 1;
  return `${baseSlug}-${suffix}`;
}

/**
 * Resolves a create request against the project slugs that exist, or
 * `undefined` when the slug is free. `undefined` means "nothing is taken",
 * never "unknown" — a caller that has not loaded the project list must not
 * call this at all rather than read a false clearance from it.
 */
export function findProjectSlugConflict(
  slug: string,
  takenSlugs: Iterable<string>,
): ProjectSlugConflict | undefined {
  const taken = new Set(takenSlugs);
  if (!taken.has(slug)) return undefined;
  return {
    takenSlug: slug,
    suggestedSlug: nextAvailableProjectSlug(slug, taken),
  };
}

/** The sentence both halves render for {@link findProjectSlugConflict}. */
export function describeProjectSlugConflict(
  name: string,
  conflict: ProjectSlugConflict,
): string {
  return `A project called '${name}' already exists. The slug '${conflict.suggestedSlug}' is available.`;
}

/**
 * What a stored `ProjectConfig.icon` may be. ONE authority for a rule with
 * three callers on both sides of the wire: the create and update routes
 * refuse a value with a problem, the settings and New Project pickers refuse
 * it before the request, and `ProjectIcon` renders nothing it would refuse.
 *
 * Two shapes are icons, and nothing else is:
 *
 * - **A glyph**: an emoji or a short symbol, at most
 *   {@link PROJECT_ICON_MAX_GLYPH_LENGTH} UTF-16 code units, with no `/`,
 *   `\`, `:` or control character and no leading `~`. That alphabet is why
 *   no glyph can be a filesystem path, a URL or a `brand:` reference — the
 *   portable manifest copies `icon` verbatim and refuses an absolute or
 *   tilde path there (`validateProjectManifest`, §3.2), so a path stored here
 *   would make the project's manifest unreadable.
 *   It must also have a visible character, and contains no bidirectional
 *   control or lone surrogate (`glyph-characters`); a ZWJ joining emoji is
 *   fine.
 * - **An inline image**: a base64 `data:` URL of one of
 *   {@link PROJECT_ICON_IMAGE_MEDIA_TYPES}, whose decoded bytes start with
 *   that format's signature and number at most
 *   {@link PROJECT_ICON_MAX_IMAGE_BYTES}. This is the shape
 *   `project-icon-discovery.ts` produces and the bound it reads under, so
 *   every discovered candidate is storable and nothing larger is.
 *
 * Remote and same-origin URLs are refused rather than stored: the renderer
 * never hotlinks (`BrandIcon` loads no remote artwork), so a stored URL would
 * be an icon nothing could show; and a same-origin `/path` is an absolute
 * path to the manifest.
 */
export const PROJECT_ICON_MAX_GLYPH_LENGTH = 16;
/** Decoded image bytes; discovery reads candidates under the same bound. */
export const PROJECT_ICON_MAX_IMAGE_BYTES = 128 * 1024;
export const PROJECT_ICON_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
] as const;
export type ProjectIconImageMediaType =
  (typeof PROJECT_ICON_IMAGE_MEDIA_TYPES)[number];

export type ProjectIconProblem =
  | 'not-a-string'
  | 'empty'
  | 'glyph-too-long'
  | 'glyph-shape'
  | 'glyph-characters'
  | 'image-type'
  | 'image-encoding'
  | 'image-too-large'
  | 'image-signature';

/** The sentence each side shows for a {@link ProjectIconProblem}. */
export const PROJECT_ICON_PROBLEM_MESSAGES: Record<ProjectIconProblem, string> =
  {
    'not-a-string': 'A project icon must be text.',
    empty: 'A project icon cannot be blank.',
    'glyph-too-long': `Use an emoji or a symbol of at most ${PROJECT_ICON_MAX_GLYPH_LENGTH} characters.`,
    'glyph-shape':
      'Use an emoji or a short symbol. Links, file paths and text with /, \\ or : are not icons.',
    'glyph-characters':
      'Use an emoji or a symbol you can see. Hidden formatting characters are not icons.',
    'image-type': 'Use a PNG, JPEG, WebP or ICO image.',
    'image-encoding': 'That image could not be read.',
    'image-too-large': `Use an image of at most ${PROJECT_ICON_MAX_IMAGE_BYTES / 1024} KB.`,
    'image-signature': 'That file is not the image type it claims to be.',
  };

// The media type is captured loosely so that any type outside the allowed
// list, including a differently cased one, reports `image-type`.
const PROJECT_ICON_DATA_URL_PATTERN =
  /^data:([^;,]*);base64,([A-Za-z0-9+/]*={0,2})$/;
const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// A control character, a separator a path or URL needs, or a leading tilde.
const GLYPH_FORBIDDEN_PATTERN = /[\p{Cc}/\\:]|^~/u;
// Bidirectional controls (they reorder the text drawn around the icon, which
// is how a name can be made to read as something else) and lone surrogates
// (half an emoji, which renders as a replacement box).
const GLYPH_HIDDEN_PATTERN =
  /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]|\p{Cs}/u;
// A character that draws something. Format characters (ZWJ, ZWSP, the word
// joiner), separators, combining marks and variation selectors only modify
// or space the characters around them, and the Hangul fillers draw blank.
// ZWJ inside an emoji sequence passes because the emoji beside it is visible.
const GLYPH_VISIBLE_PATTERN =
  /[^\p{Cf}\p{Z}\p{M}\p{Cc}\p{Cs}\u115F\u1160\u3164\uFFA0]/u;
const IMAGE_FILE_NAME_PATTERN = /\.(?:png|jpe?g|webp|ico|gif|svg)$/i;

/**
 * Whether `bytes` begin with the signature of `mediaType`. Shared with
 * workspace artwork discovery, which checks files before offering them.
 */
export function projectIconSignatureMatches(
  bytes: ArrayLike<number>,
  mediaType: string,
): boolean {
  const at = (index: number) => (index < bytes.length ? bytes[index] : -1);
  switch (mediaType) {
    case 'image/png':
      return [137, 80, 78, 71, 13, 10, 26, 10].every(
        (byte, index) => at(index) === byte,
      );
    case 'image/jpeg':
      return at(0) === 0xff && at(1) === 0xd8;
    case 'image/x-icon':
      return at(0) === 0 && at(1) === 0 && at(2) === 1 && at(3) === 0;
    case 'image/webp': {
      const ascii = (from: number, to: number) => {
        let text = '';
        for (let index = from; index < to; index += 1) {
          text += String.fromCharCode(at(index));
        }
        return text;
      };
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    }
    default:
      return false;
  }
}

/** Decodes only the first bytes of a base64 payload: enough for a signature. */
function decodeBase64Prefix(payload: string, byteCount: number): number[] {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of payload) {
    if (char === '=' || bytes.length >= byteCount) break;
    buffer = (buffer << 6) | BASE64_ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

/**
 * Why `value` is not a storable project icon, or `undefined` when it is one.
 * An empty or absent icon is the CALLER's "no icon" (the routes read `''` and
 * `null` as a clear); it is never passed here as an icon to store.
 */
export function projectIconProblem(
  value: unknown,
): ProjectIconProblem | undefined {
  if (typeof value !== 'string') return 'not-a-string';
  if (value.trim().length === 0) return 'empty';
  if (value.startsWith('data:')) {
    const match = PROJECT_ICON_DATA_URL_PATTERN.exec(value);
    if (!match) return 'image-encoding';
    const [, mediaType, payload] = match;
    if (
      !(PROJECT_ICON_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)
    ) {
      return 'image-type';
    }
    if (payload.length === 0 || payload.length % 4 !== 0) {
      return 'image-encoding';
    }
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    const byteLength = (payload.length / 4) * 3 - padding;
    if (byteLength > PROJECT_ICON_MAX_IMAGE_BYTES) return 'image-too-large';
    if (
      !projectIconSignatureMatches(decodeBase64Prefix(payload, 12), mediaType)
    )
      return 'image-signature';
    return undefined;
  }
  if (
    value !== value.trim() ||
    GLYPH_FORBIDDEN_PATTERN.test(value) ||
    IMAGE_FILE_NAME_PATTERN.test(value)
  ) {
    return 'glyph-shape';
  }
  if (GLYPH_HIDDEN_PATTERN.test(value) || !GLYPH_VISIBLE_PATTERN.test(value)) {
    return 'glyph-characters';
  }
  if (value.length > PROJECT_ICON_MAX_GLYPH_LENGTH) return 'glyph-too-long';
  return undefined;
}

/** Whether a stored icon is an inline image (vs a glyph). Assumes it is valid. */
export function isProjectIconImage(icon: string): boolean {
  return icon.startsWith('data:');
}
