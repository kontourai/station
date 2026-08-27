/**
 * Turns transport failures into text a person can act on.
 *
 * Before this module the whole story a user got for a Station that wasn't
 * running was `Error: fetch failed` — and for a Station that accepted the
 * connection but never answered, nothing at all, forever. Both are now named
 * along with the base URL that was actually used *and where that URL came
 * from* (`--api-base`, a named Station, the default Station, or the loopback
 * fallback), because "can't reach Station" is only actionable
 * once you know which Station the CLI picked and why.
 */

import type { ApiBaseSource, ResolvedApiBase } from './core-api.js';

/** How a resolved base URL is described in an error, e.g. `(default)`. */
export function describeApiBaseSource(resolved: ResolvedApiBase): string {
  const bySource: Record<ApiBaseSource, string> = {
    'api-base-flag': 'from --api-base',
    'station-flag': `from --station=${resolved.station ?? ''}`,
    'station-env': `from STATION_TARGET=${resolved.station ?? ''}`,
    'project-station': `project Station selection "${resolved.station ?? ''}"`,
    'default-station': `default Station "${resolved.station ?? ''}"`,
    'active-local': 'active local desktop Station',
    loopback: 'default',
  };
  return bySource[resolved.source];
}

function errorChainCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return (
    name === 'StationRequestTimeoutError' ||
    name === 'TimeoutError' ||
    errorChainCode(error) === 'UND_ERR_HEADERS_TIMEOUT' ||
    errorChainCode(error) === 'UND_ERR_BODY_TIMEOUT'
  );
}

function timeoutSeconds(error: unknown): string {
  const ms = (error as { timeoutMs?: unknown }).timeoutMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'the time limit';
  return `${Math.round(ms / 1000)}s`;
}

const TARGET_HINT =
  'target another Station with --station=<name> or --api-base=<url>';

/**
 * A deadline miss the client cannot report as a failure: the request was a
 * mutation, so the server may have applied it after the client stopped
 * waiting. The error text must not assert a failure it did not observe, and
 * must not invite a blind retry of a write.
 *
 * The judgement is read, never re-derived. `StationRequestTimeoutError.mutation`
 * is set where both inputs exist — the method that was sent, and the
 * operation's own `readOnly` declaration for the write-shaped methods Station
 * uses for reads (`POST /api/knowledge/index/search` and friends). Re-deriving
 * it from the verb here is exactly how a search comes to tell a user their
 * knowledge base may have changed. Anything else — an unclassified `mutation`,
 * a bare `TimeoutError` from a raw `fetch` call site — keeps the read-style
 * message, which claims nothing about state.
 *
 * Exported because `config set` composes its own follow-on hint and needs the
 * same answer this function gives `explainRequestFailure`; a second reading of
 * the same error is a second chance to read it differently.
 */
export function isIndeterminateWriteFailure(error: unknown): boolean {
  return (
    isTimeout(error) && (error as { mutation?: unknown }).mutation === true
  );
}

/**
 * Rewrites a transport failure into an actionable sentence, or returns
 * `undefined` when the error is not a transport failure and should be
 * reported as-is (an HTTP 404, a validation error, a bad flag …).
 */
export function explainRequestFailure(
  error: unknown,
  resolved: ResolvedApiBase | undefined,
): string | undefined {
  if (!resolved) return undefined;
  const where = `${resolved.apiBase} (${describeApiBaseSource(resolved)})`;

  if (isTimeout(error)) {
    if (isIndeterminateWriteFailure(error)) {
      return (
        `Gave up waiting for Station at ${where} after ` +
        `${timeoutSeconds(error)}. The request was a write and may still ` +
        'have been applied — the client stopped waiting before Station ' +
        'answered, so it cannot tell. Check whether it took effect before ' +
        'retrying. If Station is simply slow, ' +
        'STATION_REQUEST_TIMEOUT_MS=<ms> raises the deadline for the next ' +
        'attempt.'
      );
    }
    return (
      `Station at ${where} did not respond within ${timeoutSeconds(error)}. ` +
      'Check it with ./station doctor, raise the limit with ' +
      `STATION_REQUEST_TIMEOUT_MS=<ms>, or ${TARGET_HINT}.`
    );
  }

  const code = errorChainCode(error);
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return (
      `Can't reach Station at ${where}. Is it running? ` +
      `Start it with ./station start, or ${TARGET_HINT}.`
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return (
      `Can't resolve the host in ${where}. Check the address, ` +
      'or list your Stations with `station stations list`.'
    );
  }
  if (code === 'ETIMEDOUT') {
    return (
      `Can't reach Station at ${where} — the connection timed out. ` +
      `Check the network path, or ${TARGET_HINT}.`
    );
  }
  // Node surfaces every transport failure as a bare `TypeError: fetch failed`
  // with the real reason buried in `cause`. If we could not name the cause
  // above, still say which Station was targeted rather than printing the
  // opaque original.
  if (
    error instanceof TypeError &&
    /fetch failed|network|load failed/i.test(error.message)
  ) {
    return (
      `Can't reach Station at ${where}. Is it running? ` +
      `Start it with ./station start, or ${TARGET_HINT}.`
    );
  }

  return undefined;
}
