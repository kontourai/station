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
import type { ApiRequestScope } from './http.js';
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

/**
 * `POST /api/plugins/:name/command-effects`. Admission is LP-A.
 *
 * `options.requestScope` binds the call to the host authority the command
 * was chosen under, exactly as for settlement: if the Station has switched
 * since, `mutateJson` refuses before dispatch and this reports
 * `network-error`, so an admission is never sent under another Station's
 * credential or none.
 */
export async function admitPluginCommandEffect(
  apiBase: string,
  pluginId: string,
  request: PluginCommandEffectAdmissionRequest,
  options: { signal?: AbortSignal; requestScope?: ApiRequestScope } = {},
): Promise<PluginCommandEffectAdmitOutcome> {
  let response: Response;
  try {
    response = await mutateJson(
      `${apiBase}/api/plugins/${encodeURIComponent(pluginId)}/command-effects`,
      'POST',
      {
        signal: options.signal,
        ...(options.requestScope ? { requestScope: options.requestScope } : {}),
      },
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
 * `keepalive` lets a `pagehide` flush survive page teardown, but it bypasses
 * the SDK's authenticated transport ENTIRELY (`credentials: 'include'` sends
 * only the browser's ambient same-origin session cookie — never an explicit
 * bearer, and never anything for a native shell's Rust-owned credential or a
 * browser-relay/broker connection's own exchange). It is therefore the
 * CALLER's responsibility to pass `keepalive: true` only when this
 * document's Station credential is genuinely a same-origin browser cookie
 * ("device session"); the client coordinator
 * (`src-ui/src/components/plugin-command-effect-coordinator.ts`) is the
 * production caller and derives that eligibility from a live signal before
 * ever setting this flag (kontourai/station#1418, #1419 review, MEDIUM —
 * this used to be used on every `pagehide` regardless of auth mode, which
 * silently could not authenticate for desktop or a remote-paired browser).
 * Outside that one case, a `pagehide` flush must instead attempt the normal
 * authenticated path here (`keepalive: false`): best-effort, since teardown
 * may still cut it off, and never a claim of delivery either way — the
 * retry on the next `flush` (bfcache `pageshow`, or the next scheduled
 * attempt) is what actually closes the loop for desktop and remote-paired
 * connections; a `pagehide` that cannot complete in time may leave the
 * effect outstanding for the operator to resolve.
 *
 * `options.requestScope` (kontourai/station#1418, #1419 review round 2,
 * HIGH) is the host authority THIS settlement's admission was captured
 * under. On the non-keepalive path it is handed to `mutateJson`, which binds
 * the call to that exact authority and fails BEFORE dispatch
 * (`StationRequestAuthorityError`, caught below and turned into `null`, the
 * same as any other unreachable settle) if the ambient credential resolver
 * has since moved on to a different Station. Without it, `mutateJson` would
 * resolve whatever credential is CURRENTLY active and — since that
 * credential's origin will not match `apiBase` once the Station has
 * switched — silently attach no `Authorization` header at all, sending this
 * settlement unauthenticated to a Station it can never succeed against. The
 * keepalive path is unaffected: it bypasses the SDK transport (and this
 * scoping) entirely, by design (see above).
 */
export async function settlePluginCommandEffects(
  apiBase: string,
  request: PluginCommandEffectSettlementRequest,
  options: { keepalive?: boolean; requestScope?: ApiRequestScope } = {},
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
      response = await mutateJson(
        url,
        'POST',
        options.requestScope ? { requestScope: options.requestScope } : {},
        request,
      );
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
