import { errorMessage } from '../../utils/error-message.js';

/**
 * Whole-request ceiling (connect, headers and body) for one HTTP embedding
 * call. Deliberately generous: an index rebuild sends every chunk of a root in
 * a single request, and a local model on CPU can take minutes to answer it.
 * The point is that a stalled endpoint ends in an error rather than holding a
 * rebuild or an upload open indefinitely, not that embedding is fast.
 */
const EMBEDDING_REQUEST_TIMEOUT_MS = 300_000;

/** How much of an error response body is quoted in the thrown message. */
const EMBEDDING_ERROR_BODY_SNIPPET_CHARS = 300;

/**
 * The start of an error response's body, on one line. Reads no further than
 * the snippet needs, so an endpoint that answers an error status with an
 * endless body cannot hold the read open or grow memory.
 */
async function errorBodySnippet(response: Response): Promise<string> {
  try {
    let text = '';
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      while (text.length <= EMBEDDING_ERROR_BODY_SNIPPET_CHARS) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      await reader.cancel().catch(() => undefined);
    } else {
      text = await response.text();
    }
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > EMBEDDING_ERROR_BODY_SNIPPET_CHARS
      ? `${line.slice(0, EMBEDDING_ERROR_BODY_SNIPPET_CHARS)}…`
      : line;
  } catch {
    return '';
  }
}

/**
 * POSTs one embedding request and returns the parsed JSON body.
 *
 * An error status throws with the status and a bounded snippet of the body
 * (Ollama answers a missing model with 404 `{"error": ...}`), and a body that
 * is not JSON throws too. Before this, both shapes fell through to the caller
 * as `undefined` vectors or a bare TypeError.
 */
export async function postEmbeddingRequest({
  providerName,
  url,
  headers,
  body,
}: {
  providerName: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const snippet = await errorBodySnippet(response);
    throw new Error(
      `${providerName} embedding request failed with HTTP ${response.status}${
        snippet ? `: ${snippet}` : '.'
      }`,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(
      `${providerName} embedding response is not JSON: ${errorMessage(error)}`,
    );
  }
}

/**
 * Narrows a provider's answer to one non-empty numeric vector per input text.
 * Callers pair vectors with their inputs by position, so a short, long or
 * ragged answer must fail here rather than be published against the wrong
 * text.
 */
export function assertEmbeddingVectors(
  providerName: string,
  vectors: unknown,
  expectedCount: number,
): number[][] {
  if (!Array.isArray(vectors)) {
    throw new Error(`${providerName} embedding response carried no vectors.`);
  }
  if (vectors.length !== expectedCount) {
    throw new Error(
      `${providerName} embedding response carried ${vectors.length} vectors for ${expectedCount} inputs.`,
    );
  }
  for (const vector of vectors) {
    if (
      !Array.isArray(vector) ||
      vector.length === 0 ||
      !vector.every((value) => typeof value === 'number')
    ) {
      throw new Error(
        `${providerName} embedding response carried a vector that is not a non-empty array of numbers.`,
      );
    }
  }
  return vectors as number[][];
}
