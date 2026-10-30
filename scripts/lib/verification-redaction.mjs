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

// Advance past a value only when its key is secret. A harmless container or
// assignment must not hide another key inside its value from the scan.
function redactKeyValues(
  text,
  keys,
  values,
  render,
  key = (match) => match[1],
) {
  let output = '';
  let copied = 0;
  let match;
  while ((match = keys.exec(text)) !== null) {
    if (!secretKey(key(match))) continue;
    values.lastIndex = keys.lastIndex;
    const value = values.exec(text);
    if (!value) continue;
    output += text.slice(copied, match.index) + render(match, value[0]);
    copied = values.lastIndex;
    keys.lastIndex = copied;
  }
  return output + text.slice(copied);
}

function redactPlainText(text) {
  const json = redactKeyValues(
    redactCanonicalTokens(text),
    /"([^"\\]+)"(\s*:\s*)/g,
    /\[REDACTED\]|"(?:\\.|[^"\\])*"|[^,\r\n}\]]+/y,
    (match, value) => `"${match[1]}"${match[2]}${redactValue(value.trim())}`,
  );
  // Scan path/query-like values before the broad contextual matcher. On
  // Windows, backslashes let that matcher consume an entire path such as
  // `E:\\tmp\\token=secret` as one nonsecret value and shield the nested key.
  const nested = redactKeyValues(
    json,
    /\b([A-Za-z][A-Za-z0-9_-]*)[^\S\r\n]*(=|:)[^\S\r\n]*/g,
    /\[REDACTED\]|[^\s\\/?&;]+/y,
    (match) => `${match[1]}${match[2]}${REDACTED}`,
    assignmentKey,
  );
  const contextual = redactKeyValues(
    nested,
    /(^|[?&;\s])(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z][A-Za-z0-9_-]*))(\s*(?:=|:)\s*)/gim,
    /(\[REDACTED\]|"(?:\\.|[^"\\])*"|'[^']*'|\S+)(?=$|[&;\r\n])/y,
    (match, value) => {
      const [, boundary, double, single, plain, separator] = match;
      const rendered = double ? `"${double}"` : single ? `'${single}'` : plain;
      return `${boundary}${rendered}${separator}${redactValue(value)}`;
    },
    (match) => match[2] ?? match[3] ?? match[4] ?? '',
  );
  const output = redactKeyValues(
    contextual,
    /\b([A-Za-z][A-Za-z0-9_-]*)\s*(=|:)\s*/g,
    /\[REDACTED\]|"(?:\\.|[^"\\])*"|'[^']*'|\S+/y,
    (match, raw) => `${match[1]}${match[2]}${redactValue(raw)}`,
    assignmentKey,
  );
  return redactTrailingCanonicalPrefix(
    redactCanonicalTokens(output).replace(
      /:\/\/[^\s/@:]+:[^\s/@]+@/g,
      `://${REDACTED}@`,
    ),
  );
}

// This canonical npm script is a phase command, not a credential assignment.
// Keep other colon-delimited credential values subject to redaction.
function assignmentKey(match) {
  return match[1] === 'credential-ledger-exclusive' &&
    match[2] === ':' &&
    match.input.slice(0, match.index).endsWith('npm run test:full:') &&
    /^raw(?=$|[\s"'])/.test(match.input.slice(match.index + match[0].length))
    ? ''
    : match[1];
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
    // Preserve the outer JSON string layer, including on repeated passes.
    return JSON.stringify(redactStructuredValue(decoded, 0));
  });
}

/**
 * Canonical persistence redactor for stdout, stderr, and text attachments.
 * It redacts ordinary log forms and recursively encoded JSON strings through
 * five layers; deeper payloads are omitted fail-closed by redactStructuredValue.
 */
export function redactVerificationOutput(value) {
  const text = String(value);
  const structured = parseStructuredJson(text);
  if (structured !== undefined) {
    const redacted = redactStructuredValue(structured, 0);
    if (JSON.stringify(redacted) === JSON.stringify(structured)) return text;
    return `${JSON.stringify(redacted, null, text.includes('\n') ? 2 : undefined)}${text.endsWith('\n') ? '\n' : ''}`;
  }
  return redactPlainText(redactEncodedJsonStrings(text));
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
