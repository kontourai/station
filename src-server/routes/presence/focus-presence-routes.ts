/**
 * `POST /api/presence/focus` (#2585): a UI client reports whether its
 * document is focused, visible, or hidden.
 *
 * The surface the report lands on is derived from the credential the runtime
 * auth gate already accepted, never from the body: a paired device reports as
 * `device:<id>` (re-resolved from its live record, so a revoked device is
 * refused), the operator credential as `local:<clientSessionId>`. Station's
 * internal token and delegation grants (another Station, not a person) have
 * no focus to report and are refused. The body supplies only the reporting
 * document's session id and its state.
 */
import {
  FOCUS_STATES,
  type FocusState,
} from '@kontourai/station-contracts/presence';
import { Hono } from 'hono';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type {
  FocusPresence,
  FocusReporter,
} from '../../services/presence/focus-presence.js';
import { CLIENT_SESSION_ID_PATTERN } from '../../services/ssh/client-connection-presence.js';

const MAX_BODY_BYTES = 512;

export interface FocusPresenceRouteDeps {
  readonly presence: Pick<FocusPresence, 'report'>;
  readonly identifyDevice: (
    credential: string,
  ) => { readonly id: string; readonly kind?: string } | null;
}

function isFocusState(value: unknown): value is FocusState {
  return (
    typeof value === 'string' &&
    (FOCUS_STATES as readonly string[]).includes(value)
  );
}

function resolveFocusReporter(
  request: Request,
  clientSessionId: string,
  identifyDevice: FocusPresenceRouteDeps['identifyDevice'],
): FocusReporter | undefined {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  if (principal?.kind !== 'credential') return undefined;
  if (principal.authority === 'operator-credential') {
    return { kind: 'local', clientSessionId };
  }
  if (principal.authority !== 'device-credential') return undefined;
  const device = identifyDevice(principal.credential);
  if (!device || device.kind === 'delegation') return undefined;
  return { kind: 'device', deviceId: device.id };
}

export function createFocusPresenceRoutes(deps: FocusPresenceRouteDeps) {
  const app = new Hono();

  app.post('/focus', async (c) => {
    const raw = await c.req.text().catch(() => undefined);
    if (raw === undefined || raw.length > MAX_BODY_BYTES) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const record = body as Record<string, unknown>;
    const { clientSessionId, state } = record;
    if (
      Object.keys(record).some(
        (key) => key !== 'clientSessionId' && key !== 'state',
      ) ||
      typeof clientSessionId !== 'string' ||
      !CLIENT_SESSION_ID_PATTERN.test(clientSessionId) ||
      !isFocusState(state)
    ) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const reporter = resolveFocusReporter(
      c.req.raw,
      clientSessionId.toLowerCase(),
      deps.identifyDevice,
    );
    if (!reporter) {
      return c.json({ error: 'focus_surface_unavailable' }, 403);
    }
    const result = deps.presence.report(
      reporter,
      clientSessionId.toLowerCase(),
      state,
    );
    if (!result.accepted) {
      c.header(
        'Retry-After',
        String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
      );
      return c.json({ error: 'rate_limited' }, 429);
    }
    return c.body(null, 204);
  });

  return app;
}
