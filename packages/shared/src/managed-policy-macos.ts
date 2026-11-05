/**
 * macOS side of the managed policy (#4523): the managed preferences a
 * configuration profile installs for the `io.kontourai.station` domain.
 *
 * Only the device-level file is read. A user-level profile lands under
 * `/Library/Managed Preferences/<user>/`, which a user's own enrollment can
 * write, and is ignored. The file is read with the same checks as the policy
 * file (no link, regular file, root-owned chain), and its bytes are converted
 * by `/usr/bin/plutil` given by absolute path, so an earlier PATH entry
 * cannot answer for it.
 */
import { spawnSync } from 'node:child_process';

/** The configuration profile payload type and preference domain. */
export const MACOS_POLICY_DOMAIN = 'io.kontourai.station';
export const MACOS_MANAGED_PREFERENCES_PATH = `/Library/Managed Preferences/${MACOS_POLICY_DOMAIN}.plist`;
const PLUTIL = '/usr/bin/plutil';
const PLUTIL_TIMEOUT_MS = 10_000;

/**
 * Keys macOS or an MDM writes beside a payload's own keys. They describe
 * the profile, not the policy; no policy key has these names, so dropping
 * them cannot hide a restriction. Any other unknown key reaches the parser
 * and is refused there.
 */
const PROFILE_METADATA_KEYS: ReadonlySet<string> = new Set([
  'PayloadDescription',
  'PayloadDisplayName',
  'PayloadEnabled',
  'PayloadIdentifier',
  'PayloadOrganization',
  'PayloadType',
  'PayloadUUID',
  'PayloadVersion',
  '_manualProfile',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withoutProfileMetadata(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !PROFILE_METADATA_KEYS.has(key)),
  );
}

/**
 * The policy document in installed managed preferences. A custom payload
 * (PayloadType `io.kontourai.station`) installs its keys directly; a
 * `com.apple.ManagedClient.preferences` payload, which many MDM "custom
 * settings" screens write, installs them as `Forced[0].mcx_preference_settings`.
 * Only that exact wrapper is unwrapped: anything else beside it is passed
 * on whole, so the parser refuses it.
 */
export function managedPreferencesDocument(preferences: unknown): unknown {
  const stripped = withoutProfileMetadata(preferences);
  if (!isPlainObject(stripped)) return stripped;
  const keys = Object.keys(stripped);
  const forced = stripped.Forced;
  if (
    keys.length === 1 &&
    keys[0] === 'Forced' &&
    Array.isArray(forced) &&
    forced.length === 1 &&
    isPlainObject(forced[0]) &&
    Object.keys(forced[0]).length === 1 &&
    isPlainObject(forced[0].mcx_preference_settings)
  )
    return withoutProfileMetadata(forced[0].mcx_preference_settings);
  return stripped;
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXmlText(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity, body: string) => {
      if (body[0] === '#')
        return String.fromCodePoint(
          body[1] === 'x' || body[1] === 'X'
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10),
        );
      return XML_ENTITIES[body] ?? entity;
    },
  );
}

/** The element names an XML property list may hold. */
const PLIST_ELEMENTS = new Set([
  'plist',
  'dict',
  'array',
  'key',
  'string',
  'integer',
  'real',
  'true',
  'false',
  'date',
  'data',
]);

/**
 * Markup Station can read in a property list: a comment, CDATA, a
 * processing instruction, a DOCTYPE without an internal subset (which could
 * define entities), or an element tag. Anything else that starts with `<`
 * is not tokenized and refuses the profile.
 */
const PLIST_MARKUP =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*>|<(\/?)([A-Za-z][\w.:-]*)([^<>]*)>/g;

/**
 * Why an XML property list cannot be trusted as a policy, or null: the
 * dotted path of the first key repeated within one `<dict>` (plutil keeps
 * the last of two equal keys, so a second `limits` would silently erase the
 * first one's restrictions; the policy file refuses that, and so does the
 * profile), or markup this scanner does not recognize. The scan fails
 * closed: a `<key >` or `<key x="y">` plutil still reads as a key, so an
 * element tag in any form but the plain one (only `<plist>` carries
 * attributes) is refused rather than skipped. Binary property lists are
 * written by tools that cannot repeat a key and are not scanned.
 */
export function plistKeyScanProblem(xml: string): string | null {
  // A frame per open container; `seen` is null for an array.
  const frames: Array<{ path: string; seen: Set<string> | null }> = [];
  let pendingKey: string | null = null;
  /** The raw text of an open `<key>`, or null outside one. */
  let keyRaw: string | null = null;
  let offset = 0;
  for (const match of xml.matchAll(PLIST_MARKUP)) {
    const [token, closing, name, rest] = match;
    const index = match.index ?? 0;
    const between = xml.slice(offset, index);
    offset = index + token.length;
    if (between.includes('<'))
      return 'it holds markup Station cannot read as a property list';
    if (keyRaw !== null) keyRaw += between;
    if (name === undefined) {
      // A comment, CDATA, processing instruction or DOCTYPE. Inside a key
      // its text is part of the key, as `plistKeyText` reads it.
      if (keyRaw !== null) keyRaw += token;
      continue;
    }
    // Whitespace is allowed where XML allows it (`<key >` is a key, and is
    // read as one); attributes only on `<plist>`.
    const shapeOk =
      name === 'plist' ||
      (closing ? /^\s*$/.test(rest) : /^\s*\/?$/.test(rest));
    if (!PLIST_ELEMENTS.has(name) || !shapeOk)
      return `it holds the tag ${JSON.stringify(token.slice(0, 64))}, which Station does not read as a property list element`;
    const selfClosing = !closing && rest.trimEnd().endsWith('/');
    if (keyRaw !== null) {
      if (name !== 'key' || !closing)
        return 'a <key> holds markup Station cannot read';
      const top = frames[frames.length - 1];
      const text = plistKeyText(keyRaw);
      keyRaw = null;
      if (!top?.seen) continue;
      const path = top.path ? `${top.path}.${text}` : text;
      if (top.seen.has(text)) return `it repeats the key ${path}`;
      top.seen.add(text);
      pendingKey = path;
      continue;
    }
    if (name === 'key') {
      if (closing || selfClosing) return 'it holds a <key> Station cannot read';
      keyRaw = '';
      continue;
    }
    const top = frames[frames.length - 1];
    if (name === 'dict' || name === 'array') {
      if (closing) frames.pop();
      else if (!selfClosing)
        frames.push({
          path: top?.seen ? (pendingKey ?? top.path) : (top?.path ?? ''),
          seen: name === 'dict' ? new Set() : null,
        });
      pendingKey = null;
    } else if (name !== 'plist') {
      // A value (`<string>`, `<true/>`, …) consumes the pending key.
      pendingKey = null;
    }
  }
  if (keyRaw !== null) return 'a <key> is not closed';
  if (xml.slice(offset).includes('<'))
    return 'it holds markup Station cannot read as a property list';
  return null;
}

/**
 * The dotted path of the first key repeated within one `<dict>` of an XML
 * property list, or null (see {@link plistKeyScanProblem}, which also
 * refuses markup it cannot read).
 */
export function duplicatePlistKeyPath(xml: string): string | null {
  const problem = plistKeyScanProblem(xml);
  return problem?.startsWith('it repeats the key ')
    ? problem.slice('it repeats the key '.length)
    : null;
}

/** A `<key>`'s text: comments dropped, CDATA kept literally, entities decoded. */
function plistKeyText(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part) =>
      part.startsWith('<![CDATA[') ? part.slice(9, -3) : decodeXmlText(part),
    )
    .join('');
}

/** A property list's bytes as JSON text, or why they cannot be converted. */
export type PlistConverter = (
  bytes: Buffer,
) => { ok: true; json: string } | { ok: false; reason: string };

/**
 * Convert with `/usr/bin/plutil`, reading the bytes on stdin. plutil
 * refuses a `<date>` or `<data>` value for JSON, which no policy holds.
 */
export function plutilConverter(executable: string = PLUTIL): PlistConverter {
  return (bytes) => {
    const result = spawnSync(executable, ['-convert', 'json', '-o', '-', '-'], {
      input: bytes,
      encoding: 'utf8',
      timeout: PLUTIL_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: {},
    });
    if (result.error)
      return {
        ok: false,
        reason: `${executable} could not run (${(result.error as NodeJS.ErrnoException).code ?? result.error.message})`,
      };
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '')
        .trim()
        .split('\n')[0];
      return {
        ok: false,
        reason: `it is not a property list Station can read${detail ? ` (${detail})` : ''}`,
      };
    }
    return { ok: true, json: result.stdout };
  };
}
