/**
 * Which OpenAI-compatible endpoints Station KNOWS enumerate their models, and
 * what an empty `GET /models` therefore means for a given connection
 * (archive#3653).
 *
 * "OpenAI-compatible" is one adapter over a whole family of servers, so the
 * semantics cannot live on the adapter CLASS. api.openai.com and api.groq.com
 * publish real catalogues and an empty list from them is an authoritative
 * "this account has no models" — the same statement Anthropic's empty list
 * makes. A self-hosted llama.cpp, an LM Studio on localhost, or any endpoint
 * an operator typed in themselves may serve chat perfectly well and answer
 * `{"data":[]}`, and for those an empty list carries no statement at all.
 *
 * The discriminator is therefore knowledge, not naming: an endpoint on this
 * list is one Station has a reason to believe enumerates. Absence is
 * UNCERTAINTY, and uncertainty is exactly why an empty answer from it cannot
 * be read as a fact about the account. Adding a named cloud service to the
 * product's provider presets without adding it here is a drift the preset
 * conformance test catches.
 */

export type OpenAICompatCatalogSemantics = 'no-models' | 'no-catalog';

/**
 * Hosts whose OpenAI-compatible catalogue route is authoritative. Kept as
 * bare hosts because the PATH varies per vendor (`/v1`, `/openai/v1`,
 * `/inference/v1`) and is not part of the service's identity. Each is
 * compared as the full origin `https://<host>` on the default port — see
 * `recognisedOrigin` for why scheme, port and userinfo are not discarded.
 */
export const ENUMERATING_OPENAI_COMPAT_HOSTS: readonly string[] = [
  'api.openai.com',
  'openrouter.ai',
  'api.groq.com',
  'api.fireworks.ai',
  'api.meta.ai',
  'api.x.ai',
  'api.mistral.ai',
  'api.deepseek.com',
  'api.together.xyz',
  'api.cerebras.ai',
  'ai-gateway.vercel.sh',
];

/**
 * The endpoint's authority, or `null` when this is not one of the recognised
 * cloud endpoints.
 *
 * Delta2 review MEDIUM-1: this compared `URL.hostname` alone, which discards
 * scheme, port and userinfo — so `https://api.openai.com:8443/v1` and
 * `http://api.openai.com/v1` inherited OpenAI's catalogue guarantee. Neither
 * is the endpoint the list vouches for: a different port is a different
 * service (commonly a local proxy or a test double), and plain HTTP to a
 * cloud API is not that API. The comparison is therefore on the whole origin
 * — scheme, host and port together — against `https://<host>` exactly.
 *
 * Userinfo disqualifies outright. `URL.origin` drops it, so
 * `https://user@api.openai.com/v1` would otherwise compare equal while
 * naming a credentialled endpoint the list says nothing about.
 */
/**
 * The origin a base URL names, or null when Station cannot vouch for it.
 * Exported so route identity (model-inventory.ts) and catalogue semantics
 * agree on what counts as the same endpoint.
 */
export function recognisedOpenAICompatOrigin(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  return url.origin;
}

/**
 * What an empty catalogue from this base URL means.
 *
 * A base URL Station cannot parse, or one it does not recognise, is an
 * endpoint it knows nothing about — `'no-catalog'`, so a configured selector
 * may stand in for the missing enumeration. A recognised service keeps the
 * default `'no-models'` and its empty list stays authoritative.
 */
export function openAICompatCatalogSemantics(
  baseUrl: string | undefined,
): OpenAICompatCatalogSemantics {
  const origin = recognisedOpenAICompatOrigin(baseUrl ?? '');
  if (!origin) return 'no-catalog';
  return ENUMERATING_OPENAI_COMPAT_HOSTS.some(
    (host) => origin === `https://${host}`,
  )
    ? 'no-models'
    : 'no-catalog';
}
