/** Node-runtime port of packages/shared/src/redaction.ts. */
export const REDACTED = '[REDACTED]';
export const MAX_ENCODED_JSON_DEPTH = 5;
const PATTERNS = [
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /\bBearer\s+[^\s"'`,;]+/gi,
  /\bBasic\s+[A-Za-z0-9+/_=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
];
const SIZING = new Set([
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
const METADATA = new Set([
  'count',
  'expires',
  'expiresat',
  'expiry',
  'limit',
  'ttl',
  'usage',
]);

function segments(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function secretKey(key) {
  const parts = segments(key);
  const joined = parts.join('');
  if (
    parts.includes('apikey') ||
    parts.some((part, index) => part === 'api' && parts[index + 1] === 'key')
  )
    return true;
  if (
    parts.some((part) =>
      [
        'authorization',
        'cookie',
        'credential',
        'credentials',
        'passphrase',
        'password',
        'secret',
      ].includes(part),
    )
  )
    return true;
  if (
    joined.includes('privatekey') &&
    parts.includes('private') &&
    parts.includes('key')
  )
    return true;
  const tokens = parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => ['token', 'tokens', 'tokenizer'].includes(part));
  if (!tokens.length) return false;
  return !tokens.every(
    ({ part, index }) =>
      part === 'tokenizer' ||
      (part === 'tokens'
        ? parts.every((candidate, i) => i === index || SIZING.has(candidate))
        : METADATA.has(parts.slice(index + 1).join(''))),
  );
}

function redactValue(value) {
  const quote = value[0];
  const quoted = (quote === '"' || quote === "'") && value.at(-1) === quote;
  const inner = quoted ? value.slice(1, -1) : value;
  const scheme = /^(Bearer|Basic)\s+/i.exec(inner)?.[1];
  const result = scheme ? `${scheme} ${REDACTED}` : REDACTED;
  return quoted ? `${quote}${result}${quote}` : result;
}

function redactCanonicalTokens(text) {
  let output = text.replace(
    /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    REDACTED,
  );
  for (const pattern of PATTERNS)
    output = output.replace(
      pattern,
      pattern.source.includes('Bearer')
        ? `Bearer ${REDACTED}`
        : pattern.source.includes('Basic')
          ? `Basic ${REDACTED}`
          : REDACTED,
    );
  return output;
}

function redactTrailingCanonicalPrefix(text) {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g, REDACTED)
    .replace(/(?:AKIA|ASIA)[0-9A-Z]{0,15}$/g, REDACTED)
    .replace(/gh[pousr]_[A-Za-z0-9]{0,35}$/g, REDACTED)
    .replace(/github_pat_[A-Za-z0-9_]{0,21}$/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{0,19}$/g, REDACTED)
    .replace(/:\/\/[^\s/@:]+:[^\s/@]*$/g, `://${REDACTED}`);
}

function redactPlainText(text) {
  const json = redactCanonicalTokens(text).replace(
    /"([^"\\]+)"(\s*:\s*)("(?:\\.|[^"\\])*"|[^,\r\n}\]]+)/g,
    (match, key, separator, value) =>
      secretKey(key)
        ? `"${key}"${separator}${redactValue(value.trim())}`
        : match,
  );
  // Scan path/query-like values before the broad contextual matcher. On
  // Windows, backslashes let that matcher consume an entire path such as
  // `E:\\tmp\\token=secret` as one nonsecret value and shield the nested key.
  const nested = json.replace(
    /\b([A-Za-z][A-Za-z0-9_-]*)\s*(=|:)\s*[^\s\\/?&;]+/g,
    (match, key, separator) =>
      secretKey(key) ? `${key}${separator}${REDACTED}` : match,
  );
  const contextual = nested.replace(
    /(^|[?&;\s])(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z][A-Za-z0-9_-]*))(\s*(?:=|:)\s*)("(?:\\.|[^"\\])*"|'[^']*'|\S+)(?=$|[&;\r\n])/gim,
    (match, boundary, double, single, plain, separator, value) => {
      const key = double ?? single ?? plain ?? '';
      if (!secretKey(key)) return match;
      const rendered = double ? `"${double}"` : single ? `'${single}'` : plain;
      return `${boundary}${rendered}${separator}${redactValue(value)}`;
    },
  );
  const output = contextual.replace(
    /\b([A-Za-z][A-Za-z0-9_-]*)\s*(=|:)\s*("(?:\\.|[^"\\])*"|'[^']*'|\S+)/g,
    (match, key, separator, raw) =>
      secretKey(key) ? `${key}${separator}${redactValue(raw)}` : match,
  );
  return redactTrailingCanonicalPrefix(
    redactCanonicalTokens(output).replace(
      /:\/\/[^\s/@:]+:[^\s/@]+@/g,
      `://${REDACTED}@`,
    ),
  );
}

function parseStructuredJson(value) {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' || (parsed && typeof parsed === 'object')
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function redactStructuredValue(value, depth) {
  if (typeof value === 'string') {
    const nested = parseStructuredJson(value);
    if (nested === undefined) return redactPlainText(value);
    // A sixth encoded JSON layer is intentionally not interpreted. Keeping it
    // could retain a secret hidden beyond the bounded parser depth, so redact
    // the whole value rather than treating it as harmless text.
    if (depth >= MAX_ENCODED_JSON_DEPTH) return REDACTED;
    return JSON.stringify(redactStructuredValue(nested, depth + 1));
  }
  if (Array.isArray(value))
    return value.map((item) => redactStructuredValue(item, depth));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      secretKey(key) ? REDACTED : redactStructuredValue(item, depth),
    ]),
  );
}

function redactEncodedJsonStrings(text) {
  return text.replace(/"((?:\\.|[^"\\])*)"/g, (match, encoded) => {
    let decoded;
    try {
      decoded = JSON.parse(`"${encoded}"`);
    } catch {
      return match;
    }
    const nested = parseStructuredJson(decoded);
    if (nested === undefined) return match;
    // One string layer was decoded to reach this value. Count it so five
    // encoded layers are interpreted and the sixth becomes a fail-closed
    // placeholder rather than a potentially secret-bearing opaque string.
    return JSON.stringify(redactStructuredValue(nested, 1));
  });
}

/**
 * Canonical persistence redactor for stdout, stderr, and text attachments.
 * It redacts ordinary log forms and recursively encoded JSON strings through
 * five layers; deeper payloads are omitted fail-closed by redactStructuredValue.
 */
export function redactVerificationOutput(value) {
  return redactPlainText(redactEncodedJsonStrings(String(value)));
}

export function redactVerificationValue(value, depth = 0) {
  return redactStructuredValue(value, depth);
}

/** Safe streaming mode deliberately buffers until flush: no independent prefix/suffix redaction. */
export function createVerificationRedactor({
  maxBytes = 2 * 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64)
    throw new Error('maxBytes must be at least 64');
  let raw = '';
  let overflow = false;
  return {
    push(chunk) {
      if (typeof chunk !== 'string')
        throw new Error('redaction chunks must be strings');
      if (!overflow) {
        if (Buffer.byteLength(raw) + Buffer.byteLength(chunk) > maxBytes) {
          raw = '';
          overflow = true;
        } else raw += chunk;
      }
      return '';
    },
    flush() {
      return overflow
        ? '[output omitted: source exceeded redaction buffer]'
        : redactVerificationOutput(raw);
    },
  };
}
