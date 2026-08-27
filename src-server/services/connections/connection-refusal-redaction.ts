/**
 * Strip a connection's own secrets out of a provider refusal before it is
 * shown to anyone.
 *
 * A refusal is the only honest answer to "why did this connection fail"
 * (station RT-06), and provider transports routinely echo the request back
 * inside the error — a key in a query string, a header dump, a normalized URL.
 * So the message is carried, never logged, and passes through here first.
 *
 * WHAT IT COVERS
 * - Every string leaf of the connection config, at any depth (objects and
 *   arrays), not just the top level. Traversal is genuinely unbounded — a
 *   depth cap would silently stop covering a credential nested deeper than
 *   the cap (delta review M1) — and is cycle-safe by identity.
 * - Values of 8+ characters regardless of the key they sit under.
 * - Values of 4+ characters under a secret-shaped key name (`apiKey`,
 *   `clientSecret`, `accessToken`, `password`, `passphrase`, `credential`).
 * - Each secret's URL-encoded (`encodeURIComponent`) and base64 forms
 *   (standard and URL-safe, padded and unpadded), because a transport may
 *   have encoded it before putting it in the message.
 * - The host and origin of any config value that parses as a URL, so a
 *   normalized rendering that no longer contains the literal base URL is
 *   still covered.
 *
 * WHAT IT CANNOT COVER, and why this is a best-effort scrub rather than a
 * guarantee:
 * - Any other transformation — a hash, a truncation ("sk-ant-…000"), a
 *   different case folding, a provider that reformats the value.
 * - A secret this connection does not hold: an ambient `ANTHROPIC_API_KEY`
 *   in the process environment, or an AWS credential resolved from the
 *   default chain, never appears in `connection.config` and so is invisible
 *   here.
 * - Non-secret identifiers a provider may include (an account or org id).
 *
 * WHERE THE SCRUBBED TEXT GOES. Not one surface: it is returned by
 * `POST /api/connections/:id/test`, and it is projected into
 * `readinessEvidence.check.reason`, which the Connections hub card, the
 * provider detail panel and the provider list rail all render. It is
 * deliberately kept out of logs and telemetry — the providers themselves log
 * only fixed strings — but any API consumer of this Station can read it, so
 * the scrub is the boundary, not the UI.
 *
 * STALENESS BOUNDARY. A receipt is bound to the connection's stored
 * configuration fingerprint, which does NOT cover ambient credential
 * material: rotating the key inside an AWS profile or the default credential
 * chain, renewing an external token, or DNS/provider recovery all fix a
 * refusal without changing a single stored byte. The refusal therefore stands
 * until the next discovery or explicit test observes otherwise. That is the
 * intended past-receipt semantics — execution is never gated on it — but it
 * means "Check failed" can outlive its cause by one listing.
 *
 * It deliberately over-redacts: any 8+ character config string is replaced,
 * which can blank a model id or a region out of an otherwise readable
 * message. A diagnostic that is harder to read is a cheaper failure than a
 * credential that escapes.
 */

const SECRET_SHAPED_KEY =
  /(?:^|[^a-z])(?:api[-_]?key|key|secret|token|password|passphrase|credential)(?:$|[^a-z])/i;
const SECRET_SHAPED_MIN_LENGTH = 4;
const ANY_VALUE_MIN_LENGTH = 8;
const MAX_REASON_LENGTH = 400;
const REDACTED = '[redacted]';

function isSecretShapedKey(key: string): boolean {
  return SECRET_SHAPED_KEY.test(key) || /key|secret|token|password/i.test(key);
}

/**
 * Every string leaf, however deep. Iterative rather than recursive so a
 * pathological config cannot blow the stack, and `seen` makes a cyclic object
 * terminate instead of looping — a JSON-loaded config cannot contain a cycle,
 * but this also runs on in-memory config objects.
 */
function collectStringLeaves(
  root: unknown,
  out: Array<{ key: string; value: string }>,
): void {
  const seen = new WeakSet<object>();
  const stack: Array<{ key: string; value: unknown }> = [
    { key: '', value: root },
  ];
  while (stack.length > 0) {
    const { key, value } = stack.pop() as { key: string; value: unknown };
    if (typeof value === 'string') {
      out.push({ key, value });
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value as object)) continue;
    seen.add(value as object);
    if (Array.isArray(value)) {
      for (const entry of value) stack.push({ key, value: entry });
      continue;
    }
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      stack.push({ key: childKey, value: childValue });
    }
  }
}

function base64Forms(secret: string): string[] {
  let standard: string;
  try {
    standard = Buffer.from(secret, 'utf8').toString('base64');
  } catch {
    return [];
  }
  const unpadded = standard.replace(/=+$/, '');
  const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_');
  return [standard, unpadded, urlSafe, urlSafe.replace(/=+$/, '')];
}

function urlForms(value: string): string[] {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return [];
  try {
    const url = new URL(value);
    if (!url.host) return [];
    // `origin` and `host` both, because a normalized rendering may keep only
    // one of them.
    return [url.origin, url.host, url.hostname];
  } catch {
    return [];
  }
}

/** Every rendering of this connection's secrets that a message might contain. */
export function connectionSecretEchoes(
  config: Record<string, unknown>,
): string[] {
  const leaves: Array<{ key: string; value: string }> = [];
  collectStringLeaves(config, leaves);

  const echoes = new Set<string>();
  for (const { key, value } of leaves) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    for (const host of urlForms(trimmed)) echoes.add(host);
    const secretish =
      trimmed.length >= ANY_VALUE_MIN_LENGTH ||
      (trimmed.length >= SECRET_SHAPED_MIN_LENGTH && isSecretShapedKey(key));
    if (!secretish) continue;
    echoes.add(trimmed);
    const encoded = encodeURIComponent(trimmed);
    if (encoded !== trimmed) echoes.add(encoded);
    for (const form of base64Forms(trimmed)) echoes.add(form);
  }
  // Longest first: a shorter echo that is a substring of a longer one must not
  // punch a hole in it and leave the remainder readable.
  return [...echoes].sort((a, b) => b.length - a.length);
}

export function redactConnectionSecretEchoes(
  message: string,
  config: Record<string, unknown>,
): string {
  const redacted = connectionSecretEchoes(config).reduce(
    (current, echo) => current.split(echo).join(REDACTED),
    message,
  );
  return redacted.length > MAX_REASON_LENGTH
    ? `${redacted.slice(0, MAX_REASON_LENGTH)}…`
    : redacted;
}
