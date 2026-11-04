/**
 * A registry read that follows redirects itself, checking every hop BEFORE it
 * is requested (#4521 review). `fetch` follows redirects on its own, so a
 * check on the configured location alone is bypassed by a 302, and a check on
 * the final URL comes after the disallowed host was already contacted.
 *
 * Every hop:
 * - never goes from https to anything else (no downgrade), with or without a
 *   managed policy;
 * - must be http or https;
 * - passes the caller's `permitHop`, which is how `limits.registries`
 *   allowedUrls governs a manifest read.
 */
const MAX_REGISTRY_REDIRECTS = 5;

/** A redirect the registry read refused to follow; nothing was requested. */
export class RegistryRedirectRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryRedirectRefusal';
  }
}

/**
 * Why `to` may not be requested after `from` redirected to it, or undefined
 * to follow it.
 */
export type RegistryHopPolicy = (from: URL, to: URL) => string | undefined;

export async function fetchRegistryResource(
  url: string | URL,
  init: Omit<RequestInit, 'redirect'> = {},
  permitHop: RegistryHopPolicy = () => undefined,
): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    const response = await fetch(current.href, {
      ...init,
      redirect: 'manual',
    });
    const location =
      response.status >= 300 && response.status < 400
        ? response.headers.get('location')
        : null;
    if (location === null) return response;
    await response.body?.cancel().catch(() => {});
    if (hop >= MAX_REGISTRY_REDIRECTS)
      throw new RegistryRedirectRefusal(
        `Registry read refused: more than ${MAX_REGISTRY_REDIRECTS} redirects.`,
      );
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new RegistryRedirectRefusal(
        'Registry read refused: the redirect target is not a URL.',
      );
    }
    if (next.protocol !== 'https:' && next.protocol !== 'http:')
      throw new RegistryRedirectRefusal(
        `Registry read refused: a redirect to ${next.protocol} cannot be followed.`,
      );
    if (current.protocol === 'https:' && next.protocol !== 'https:')
      throw new RegistryRedirectRefusal(
        'Registry read refused: a redirect from https to http would let the registry be altered in transit.',
      );
    const refusal = permitHop(current, next);
    if (refusal !== undefined) throw new RegistryRedirectRefusal(refusal);
    current = next;
  }
}
