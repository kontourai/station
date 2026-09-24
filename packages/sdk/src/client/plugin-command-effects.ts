/**
 * Plugin command effects over HTTP (kontourai/station#1418, #1419).
 *
 * Thin, React-free fetchers over the routes in
 * `src-server/routes/plugins/plugin-command-effect-routes.ts`. Admission and
 * settlement both answer with an ordinary JSON envelope for every REFUSED or
 * unsettled outcome (never an HTTP error status alone), so these functions
 * never throw for a business refusal — only for a genuinely malformed
 * response, which the caller (the client coordinator,
 * `src-ui/src/components/plugin-command-effect-coordinator.ts`) treats the
 * same as a network failure: the admission's fate is unknown, so it cancels
 * rather than guesses.
 */
import type {
  PluginCommandEffectAdmissionRequest,
  PluginCommandEffectReceipt,
  PluginCommandEffectRefusalReason,
  PluginCommandEffectSettlementRequest,
  PluginCommandEffectSettlementResult,
} from '@kontourai/station-contracts/plugin-command-effect';
import { mutateJson } from './http.js';

export type PluginCommandEffectAdmitOutcome =
  | { kind: 'admitted'; receipt: PluginCommandEffectReceipt }
  | { kind: 'refused'; reason: PluginCommandEffectRefusalReason }
  | { kind: 'network-error' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isReceipt(value: unknown): value is PluginCommandEffectReceipt {
  if (!isRecord(value) || !isRecord(value.effect)) return false;
  return (
    typeof value.effectId === 'string' &&
    typeof value.requestId === 'string' &&
    typeof value.pluginId === 'string' &&
    typeof value.commandId === 'string' &&
    typeof value.installationGeneration === 'string' &&
    (value.effect.kind === 'navigate' || value.effect.kind === 'seed-composer')
  );
}

/** `POST /api/plugins/:name/command-effects`. Admission is LP-A. */
export async function admitPluginCommandEffect(
  apiBase: string,
  pluginId: string,
  request: PluginCommandEffectAdmissionRequest,
  options: { signal?: AbortSignal } = {},
): Promise<PluginCommandEffectAdmitOutcome> {
  let response: Response;
  try {
    response = await mutateJson(
      `${apiBase}/api/plugins/${encodeURIComponent(pluginId)}/command-effects`,
      'POST',
      { signal: options.signal },
      request,
    );
  } catch {
    return { kind: 'network-error' };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'network-error' };
  }
  if (!isRecord(body)) return { kind: 'network-error' };
  if (body.success === true && isReceipt(body.receipt)) {
    return { kind: 'admitted', receipt: body.receipt };
  }
  if (body.success === false && typeof body.reason === 'string') {
    return {
      kind: 'refused',
      reason: body.reason as PluginCommandEffectRefusalReason,
    };
  }
  return { kind: 'network-error' };
}

/**
 * `POST /api/plugins/command-effects/settlements`. Settlement is LP-K.
 *
 * `keepalive` lets a `pagehide` flush survive page teardown; it bypasses the
 * SDK's broker/credential transport (native and relay callers do not use
 * `pagehide` at all, and `fetch`'s `keepalive` flag has no analogue there),
 * so a settlement sent this way relies on the browser's ambient session
 * (same-origin cookies) rather than an explicit bearer credential. That is a
 * disclosed gap for a remote broker connection; the retry on the next
 * `flush` (bfcache `pageshow`, or the next scheduled attempt) goes through
 * the normal path.
 */
export async function settlePluginCommandEffects(
  apiBase: string,
  request: PluginCommandEffectSettlementRequest,
  options: { keepalive?: boolean } = {},
): Promise<readonly PluginCommandEffectSettlementResult[] | null> {
  const url = `${apiBase}/api/plugins/command-effects/settlements`;
  let response: Response;
  try {
    if (options.keepalive) {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        keepalive: true,
        body: JSON.stringify(request),
      });
    } else {
      response = await mutateJson(url, 'POST', {}, request);
    }
  } catch {
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (
    !isRecord(body) ||
    body.success !== true ||
    !Array.isArray(body.results)
  ) {
    return null;
  }
  return body.results as PluginCommandEffectSettlementResult[];
}
