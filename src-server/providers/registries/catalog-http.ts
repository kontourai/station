import type { ModelCatalogRequest } from '../llm/model-provider-types.js';

export const DEFAULT_MODEL_CATALOG_MAX_ENTRIES = 1000;
export const DEFAULT_MODEL_CATALOG_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MODEL_CATALOG_MAX_PAGES = 32;

export interface CatalogByteBudget {
  remainingBytes: number;
}

export function catalogLimit(options?: ModelCatalogRequest): number {
  return Math.max(
    1,
    Math.min(
      options?.maxEntries ?? DEFAULT_MODEL_CATALOG_MAX_ENTRIES,
      DEFAULT_MODEL_CATALOG_MAX_ENTRIES,
    ),
  );
}

export function catalogResponseByteLimit(
  options?: ModelCatalogRequest,
): number {
  return Math.max(
    1,
    Math.min(
      options?.maxResponseBytes ?? DEFAULT_MODEL_CATALOG_MAX_RESPONSE_BYTES,
      DEFAULT_MODEL_CATALOG_MAX_RESPONSE_BYTES,
    ),
  );
}

export function createCatalogByteBudget(
  options?: ModelCatalogRequest,
): CatalogByteBudget {
  return { remainingBytes: catalogResponseByteLimit(options) };
}

/**
 * A catalog route that answered with an error status.
 *
 * The status is carried structurally rather than left to be re-parsed out of
 * the message, because two very different facts hide behind "the catalog
 * request failed": 401/403 means the provider refused these credentials, and
 * 404/405/501 means this endpoint simply has no catalog route — which says
 * nothing about whether it can chat (station RT-06 delta review H1).
 */
export class ModelCatalogHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Model catalog request failed with HTTP ${status}.`);
    this.name = 'ModelCatalogHttpError';
    this.status = status;
  }
}

/**
 * The HTTP status a provider error carries, if it carries one at all.
 *
 * `ModelCatalogHttpError` is Station's own; `statusCode` is what ai-sdk's
 * `APICallError` (and most provider SDKs) put on a rejected request. Reading
 * the field is what keeps "the provider refused" structural — the alternative,
 * looking for "401" in the message, is exactly the string-matching these typed
 * errors exist to remove. Shared by catalog classification and the explicit
 * test's chat probe so both name the same fact the same way.
 */
export function providerHttpErrorStatus(error: unknown): number | undefined {
  if (error instanceof ModelCatalogHttpError) return error.status;
  if (!error || typeof error !== 'object') return undefined;
  const candidate =
    (error as { statusCode?: unknown }).statusCode ??
    (error as { status?: unknown }).status;
  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

/**
 * The response was not a catalog: right status, wrong or unusable body.
 *
 * Station RT-06 delta2 review M1: a body that does not parse as JSON, and a
 * body too large to read within the catalog budget, are BOTH this — the
 * endpoint answered, its answer is simply not a catalog. Leaving them as
 * generic `Error`s classified them as `unreachable` (a transport failure),
 * which is a claim about the network rather than about the response that
 * actually arrived.
 */
export class ModelCatalogShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCatalogShapeError';
  }
}

function parseCatalogJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ModelCatalogShapeError(
      `Model catalog response is not JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function readBoundedJson(
  response: Response,
  options?: ModelCatalogRequest,
  budget?: CatalogByteBudget,
): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelCatalogHttpError(response.status);
  }

  const maxBytes = Math.min(
    catalogResponseByteLimit(options),
    budget?.remainingBytes ?? Number.POSITIVE_INFINITY,
  );
  if (maxBytes < 1) {
    await response.body?.cancel();
    throw new ModelCatalogShapeError(
      'Model catalog response exceeds the byte limit.',
    );
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new ModelCatalogShapeError(
      'Model catalog response exceeds the byte limit.',
    );
  }

  if (!response.body) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > maxBytes) {
      throw new ModelCatalogShapeError(
        'Model catalog response exceeds the byte limit.',
      );
    }
    if (budget) budget.remainingBytes -= bytes;
    return parseCatalogJson(text);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new ModelCatalogShapeError(
        'Model catalog response exceeds the byte limit.',
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (budget) budget.remainingBytes -= totalBytes;
  return parseCatalogJson(new TextDecoder().decode(bytes));
}
