const REDACTED = '[REDACTED]';
const REDACTED_URL = '[REDACTED_URL]';
const REDACTED_PATH = '[REDACTED_PATH]';
const TRUNCATION_SUFFIX = '…[TRUNCATED]';

/** Bounds a free-text field that can cross a persistence or client boundary. */
export const MAX_SANITIZED_TEXT_LENGTH = 4_096;
export const MAX_SANITIZED_ERROR_STACK_FRAMES = 24;
export const MAX_SANITIZED_ERROR_STACK_LENGTH = 8_192;

const URL_PATTERN = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s<>"'`]+/gi;
// Preserve a surrounding quote/bracket delimiter while removing the complete
// path. Node's ENOENT and module-load errors commonly quote their path rather
// than placing it after whitespace or `(` like a stack frame does.
const QUOTED_POSIX_ABSOLUTE_PATH_PATTERN = /(^|[\s(])(['"])\/[^\r\n]*?\2/gm;
const QUOTED_WINDOWS_ABSOLUTE_PATH_PATTERN =
  /(^|[\s(])(['"])[a-z]:\\[^\r\n]*?\2/gim;
// V8 source locations end in `:line:column`. That delimiter lets unquoted
// paths containing spaces be removed without consuming a following stack line
// or unrelated message text.
const POSIX_STACK_SOURCE_LOCATION_PATTERN =
  /(^|[\s(])\/[^\r\n]*?:\d+:\d+(?=\)?(?:\s|$))/gm;
const WINDOWS_STACK_SOURCE_LOCATION_PATTERN =
  /(^|[\s(])[a-z]:\\[^\r\n]*?:\d+:\d+(?=\)?(?:\s|$))/gim;
const POSIX_ABSOLUTE_PATH_PATTERN = /(^|[\s([])\/[^\s()<>"'\],;]+/gm;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /(^|[\s([])[a-z]:\\[^\s()<>"'\],;]+/gim;

const SECRET_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  replacement: string;
}> = [
  { pattern: /([?&]capability=)[A-Za-z0-9_-]+/g, replacement: `$1${REDACTED}` },
  { pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/g, replacement: REDACTED },
  { pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g, replacement: REDACTED },
  { pattern: /github_pat_[A-Za-z0-9_]{22,}/g, replacement: REDACTED },
  {
    pattern: /\bBearer\s+[^\s"'`,;]+/gi,
    replacement: `Bearer ${REDACTED}`,
  },
  {
    pattern: /\bBasic\s+[A-Za-z0-9+/_=-]+/gi,
    replacement: `Basic ${REDACTED}`,
  },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: REDACTED },
];

// Redact complete URL credentials before contextual fields interpret a colon
// inside a password (#1922). Passwords may contain `@`; the greedy password
// group uses the last `@` before a path/quote/whitespace boundary (#1896).
const CONNECTION_STRING_CREDENTIAL_PATTERN =
  /([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s'"/:@]+:[^\s'"/]+@/gi;

// Native asset URLs can contain a launch secret. Keep the plugin identity
// and source coordinates useful to a bug report, never the query or fragment.
function assetLocation(location: string): string {
  const coordinates = /:\d+(?::\d+)?$/.exec(location)?.[0] ?? '';
  const url = coordinates ? location.slice(0, -coordinates.length) : location;
  const path = url.split(/[?#]/, 1)[0] ?? '';
  const localPath = path.replace(
    /^(?:station-plugin:\/\/localhost|https?:\/\/station-plugin\.localhost)/i,
    '',
  );
  const asset = localPath.startsWith('/api/plugins/')
    ? localPath
    : path.slice(path.lastIndexOf('/') + 1);
  return `${asset}${coordinates}`;
}

function redactPluginAssetUrls(text: string): string {
  return text.replace(
    /\b(?:station-plugin:\/\/localhost|https?:\/\/station-plugin\.localhost)\/[^\s<>"'`()\],，。；：！？、）》】」』〉〕］｝＞＇＂]+/gi,
    (location) => {
      const punctuation = /\.+$/.exec(location)?.[0] ?? '';
      const url = punctuation
        ? location.slice(0, -punctuation.length)
        : location;
      return `${assetLocation(url)}${punctuation}`;
    },
  );
}

/** Stack locations retain plugin paths or filenames, plus source coordinates. */
export function redactStackLocations(text: string): string {
  return redactSecrets(text).replace(/[^\s()@]*\/[^\s()]*/g, assetLocation);
}

const TOKEN_SIZING_SEGMENTS = new Set([
  'budget',
  'cache',
  'completion',
  'context',
  'count',
  'default',
  'input',
  'limit',
  'max',
  'min',
  'output',
  'prompt',
  'total',
]);

const TOKEN_METADATA_SUFFIXES = new Set([
  'count',
  'expires',
  'expiresat',
  'expiry',
  'limit',
  'ttl',
  'usage',
]);

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Complete key names that are credentials even though their word segments are
 * not. Compared against the segment-joined form, so `MYSQL_PWD`, `mysql-pwd`
 * and `mysqlPwd` all match while a bare `pwd` does not.
 */
const WHOLE_NAME_SECRET_KEYS = new Set(['pgpassword', 'mysqlpwd']);

export function isSecretField(key: string): boolean {
  const segments = keySegments(key);
  const joined = segments.join('');
  if (
    segments.includes('apikey') ||
    segments.some(
      (segment, index) => segment === 'api' && segments[index + 1] === 'key',
    )
  ) {
    return true;
  }
  if (
    segments.some((segment) =>
      [
        'authorization',
        'cookie',
        'credential',
        'credentials',
        // `creds` is what a hand-written CLI flag or env var actually says
        // (`--creds=`, `AWS_CREDS`); the long forms above never matched it.
        'creds',
        'passphrase',
        'password',
        'secret',
      ].includes(segment),
    )
  ) {
    return true;
  }
  // Whole-name credential vocabulary that segments into words carrying no
  // secret signal of their own — `PGPASSWORD` is one segment, and `MYSQL_PWD`
  // splits into `mysql` + `pwd`, neither of which should be secret alone
  // (`pwd` is also "print working directory"). Matched as complete names only.
  if (WHOLE_NAME_SECRET_KEYS.has(joined)) return true;
  if (
    joined.includes('privatekey') &&
    segments.includes('private') &&
    segments.includes('key')
  ) {
    return true;
  }

  // Token-bearing keys are secret unless every token segment satisfies one of
  // three narrow exceptions: `tokenizer`; plural `tokens` surrounded only by
  // sizing vocabulary; or singular `token` followed by a metadata suffix.
  // Sizing prefixes never exempt singular tokens (`outputToken` is secret),
  // while suffix metadata does (`contextTokenLimit` is not secret).
  const tokenSegments = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) =>
      ['token', 'tokens', 'tokenizer'].includes(segment),
    );
  if (tokenSegments.length === 0) return false;
  return !tokenSegments.every(({ segment, index }) => {
    if (segment === 'tokenizer') return true;
    if (segment === 'tokens') {
      return segments.every(
        (candidate, candidateIndex) =>
          candidateIndex === index || TOKEN_SIZING_SEGMENTS.has(candidate),
      );
    }
    return TOKEN_METADATA_SUFFIXES.has(segments.slice(index + 1).join(''));
  });
}

function redactContextValue(value: string): string {
  const quote = value[0];
  const isQuoted = (quote === '"' || quote === "'") && value.at(-1) === quote;
  const inner = isQuoted ? value.slice(1, -1) : value;
  const scheme = /^(Bearer|Basic)\s+/i.exec(inner)?.[1];
  const redacted = scheme ? `${scheme} ${REDACTED}` : REDACTED;
  return isQuoted ? `${quote}${redacted}${quote}` : redacted;
}

function redactContextualFields(text: string): string {
  const jsonRedacted = text.replace(
    /"([^"\\]+)"(\s*:\s*)("(?:\\.|[^"\\])*"|[^,\r\n}\]]+)/g,
    (match, key: string, separator: string, value: string) =>
      isSecretField(key)
        ? `"${key}"${separator}${redactContextValue(value.trim())}`
        : match,
  );

  const keys =
    /((?:^|[?&;:\s])--?|^|[?&;:\s])(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z][A-Za-z0-9_-]*))(\s*(?:=|:)\s*)/gim;
  const values =
    /\[REDACTED\](?=$|[\s&;])|"(?:\\.|[^"\\])*"(?=$|[\s&;])|'[^']*'(?=$|[\s&;])|(?:(?!\s-|\s[A-Za-z][A-Za-z0-9_-]*[ \t]*[=:])[^&;\r\n])*/y;
  const secretKeys = new Map<string, boolean>();
  let output = '';
  let copied = 0;
  for (
    let match = keys.exec(jsonRedacted);
    match !== null;
    match = keys.exec(jsonRedacted)
  ) {
    const [, boundary, double, single, plain, separator] = match;
    const key = double ?? single ?? plain ?? '';
    let secret = secretKeys.get(key);
    if (secret === undefined) {
      secret = isSecretField(key);
      secretKeys.set(key, secret);
    }
    if (!secret) {
      // A harmless unquoted value must not shield later credential keys.
      // Keep quoted values opaque, as they may contain ordinary example text.
      const next = jsonRedacted[keys.lastIndex];
      if (next === '"' || next === "'") {
        values.lastIndex = keys.lastIndex;
        const value = values.exec(jsonRedacted);
        if (value) keys.lastIndex = values.lastIndex;
      } else if (/[:\s]$/.test(separator)) keys.lastIndex -= 1;
      continue;
    }
    values.lastIndex = keys.lastIndex;
    const value = values.exec(jsonRedacted);
    if (!value) continue;
    const rendered = double ? `"${double}"` : single ? `'${single}'` : plain;
    output +=
      jsonRedacted.slice(copied, match.index) +
      `${boundary}${rendered}${separator}${redactContextValue(value[0])}`;
    copied = values.lastIndex;
    keys.lastIndex = copied;
  }
  return output + jsonRedacted.slice(copied);
}

function redactKnownCredentials(text: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, { pattern, replacement }) =>
      redacted.replace(pattern, replacement),
    redactContextualFields(
      text.replace(CONNECTION_STRING_CREDENTIAL_PATTERN, `$1${REDACTED}@`),
    ),
  );
}

/** Detects known credential shapes without treating URL cleanup as a secret. */
export function containsKnownCredential(text: string): boolean {
  return redactKnownCredentials(text) !== text;
}

/**
 * Redacts KNOWN credential shapes from free text:
 *
 * - Connection-string `user:pass@` credentials are removed before field scanning.
 * - **Contextual**, `redactContextualFields`: a `key: value` / `key=value` pair
 *   (JSON, query string, env line, or a `--flag=value` command line) whose KEY
 *   `isSecretField` — `apiKey`, `authorization`, `cookie`, `credential(s)`,
 *   `creds`, `passphrase`, `password`, `secret`, `privateKey`, most `token`
 *   spellings, and the whole names in `WHOLE_NAME_SECRET_KEYS`.
 * - Native plugin asset URLs become plugin paths with source coordinates,
 *   without queries or fragments; capability query values are also redacted
 *   when the origin has already been removed.
 * - **Pattern**, `SECRET_PATTERNS`: AWS access-key ids, GitHub tokens and PATs,
 *   `Bearer`/`Basic` authorization values, and `sk-` API keys.
 *
 * It is NOT a guarantee that no secret survives. A high-entropy token in a
 * field name this does not recognise is returned as written. Callers that
 * present the result to a person should say "known credential shapes are
 * redacted", not "secrets are removed".
 *
 * Unlike {@link sanitizeFreeText} this keeps ordinary URLs and absolute paths.
 * Native plugin asset URLs are the exception above. A caller that needs all
 * locations gone should use that function instead.
 */
export function redactSecrets(text: string): string {
  return redactKnownCredentials(redactPluginAssetUrls(text));
}

function requireTextLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('sanitized text limit must be a positive safe integer');
  }
  return limit;
}

/**
 * Redacts known secret formats and removes complete URLs and absolute paths
 * from free text.
 *
 * A URL can disclose a private path, provider, query token, fragment, or
 * inline credentials even when none individually match a secret pattern.
 * This is deliberately stricter than `redactSecrets`: operational fields
 * should carry structured URL metadata when it is safe to expose it, never a
 * raw URL copied from an external error or CLI stderr stream. `limit` is a
 * JavaScript UTF-16 code-unit cap, not a byte cap; callers that persist a
 * serialized payload must apply a byte cap at that payload boundary too.
 */
export function sanitizeFreeText(
  text: string,
  limit = MAX_SANITIZED_TEXT_LENGTH,
): string {
  if (typeof text !== 'string') {
    throw new TypeError('free-text sanitizer requires a string');
  }
  const maximum = requireTextLimit(limit);
  const sanitized = redactSecrets(text)
    .replace(URL_PATTERN, REDACTED_URL)
    .replace(QUOTED_POSIX_ABSOLUTE_PATH_PATTERN, `$1$2${REDACTED_PATH}$2`)
    .replace(QUOTED_WINDOWS_ABSOLUTE_PATH_PATTERN, `$1$2${REDACTED_PATH}$2`)
    .replace(POSIX_STACK_SOURCE_LOCATION_PATTERN, `$1${REDACTED_PATH}`)
    .replace(WINDOWS_STACK_SOURCE_LOCATION_PATTERN, `$1${REDACTED_PATH}`)
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, `$1${REDACTED_PATH}`)
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, `$1${REDACTED_PATH}`);
  if (sanitized.length <= maximum) return sanitized;
  if (maximum <= TRUNCATION_SUFFIX.length) {
    return TRUNCATION_SUFFIX.slice(0, maximum);
  }
  return `${sanitized.slice(0, maximum - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

export interface SanitizedError {
  readonly type: string;
  readonly message: string;
  readonly stack?: string;
}

/**
 * Converts a real Error to the only error shape safe for durable logs and
 * diagnostics. Unknown thrown values are rejected instead of stringified,
 * because implicit coercion can expose arbitrary provider or CLI output.
 */
export function sanitizeError(error: unknown): SanitizedError {
  if (!(error instanceof Error)) {
    throw new TypeError('error sanitizer requires an Error instance');
  }
  const stack = error.stack;
  const sanitizedStack =
    typeof stack === 'string'
      ? sanitizeFreeText(stack, MAX_SANITIZED_ERROR_STACK_LENGTH)
          .split(/\r?\n/)
          .slice(0, MAX_SANITIZED_ERROR_STACK_FRAMES + 1)
          .join('\n')
      : undefined;
  return {
    type: sanitizeFreeText(error.name || 'Error', 128),
    message: sanitizeFreeText(error.message),
    ...(sanitizedStack ? { stack: sanitizedStack } : {}),
  };
}

export function redactDeep<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  const MAX_JSON_STRING_DEPTH = 5;

  const redact = (current: unknown, jsonStringDepth = 0): unknown => {
    if (typeof current === 'string') {
      if (jsonStringDepth >= MAX_JSON_STRING_DEPTH) {
        // Fail closed at the recursion cap: content still JSON-encoded this
        // deep can hide secret-named keys behind escaping the contextual
        // patterns cannot see, so drop it rather than return encoded text.
        try {
          const parsed = JSON.parse(current);
          if (
            typeof parsed === 'string' ||
            (parsed !== null && typeof parsed === 'object')
          ) {
            return REDACTED;
          }
        } catch {
          // Not JSON: safe to fall through to textual redaction.
        }
        return sanitizeFreeText(current);
      }
      try {
        const parsed = JSON.parse(current);
        if (
          typeof parsed === 'string' ||
          (parsed !== null && typeof parsed === 'object')
        ) {
          return JSON.stringify(redact(parsed, jsonStringDepth + 1));
        }
      } catch {
        // Ordinary strings are redacted as text below.
      }
      return sanitizeFreeText(current);
    }
    if (current === null || typeof current !== 'object') return current;
    if (current instanceof Date) return new Date(current.getTime());
    // `Error`'s `message`/`stack` are non-enumerable, so a generic object walk
    // would silently turn them into `{}`. Preserve the useful fields only in
    // their bounded, free-text-sanitized shape.
    if (current instanceof Error) return sanitizeError(current);

    const prior = seen.get(current);
    if (prior !== undefined) return prior;

    if (Array.isArray(current)) {
      const result: unknown[] = [];
      seen.set(current, result);
      for (const item of current) result.push(redact(item, jsonStringDepth));
      return result;
    }

    const result: Record<string, unknown> = {};
    seen.set(current, result);
    for (const [key, child] of Object.entries(current)) {
      result[key] = isSecretField(key)
        ? REDACTED
        : redact(child, jsonStringDepth);
    }
    return result;
  };

  return redact(value) as T;
}
