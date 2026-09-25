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
 * document's session id (which must equal its `X-Station-Client-Session`
 * header), its state, and its send counter `seq`. A report older than one
 * already applied for that document is answered 204 and changes nothing.
 */
import {
  FOCUS_STATES,
  type FocusState,
} from '@kontourai/station-contracts/presence';
import { type Context, Hono } from 'hono';
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
  /**
   * The canonical request principal id for this request (the runtime passes
   * its one orchestration principal resolver). Throwing means the caller has
   * no resolvable person, and the report is refused.
   */
  readonly resolvePrincipalId: (c: Context) => string;
}

type UnattributedReporter =
  | { readonly kind: 'device'; readonly deviceId: string }
  | { readonly kind: 'local'; readonly clientSessionId: string };

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
): UnattributedReporter | undefined {
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
    const { clientSessionId, state, seq } = record;
    if (
      Object.keys(record).some(
        (key) => key !== 'clientSessionId' && key !== 'state' && key !== 'seq',
      ) ||
      typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      typeof clientSessionId !== 'string' ||
      !CLIENT_SESSION_ID_PATTERN.test(clientSessionId) ||
      !isFocusState(state)
    ) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    // Presence elsewhere (SSE liveness, stream logs) keys on this header. A
    // report naming a different document than the header could never be
    // joined to it, so refuse the mismatch rather than store two identities.
    const header = c.req.header('x-station-client-session');
    if (header?.toLowerCase() !== clientSessionId.toLowerCase()) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const surface = resolveFocusReporter(
      c.req.raw,
      clientSessionId.toLowerCase(),
      deps.identifyDevice,
    );
    let principalId: string | undefined;
    if (surface) {
      try {
        principalId = deps.resolvePrincipalId(c);
      } catch {
        principalId = undefined;
      }
    }
    if (!surface || !principalId) {
      return c.json({ error: 'focus_surface_unavailable' }, 403);
    }
    const reporter: FocusReporter = { ...surface, principalId };
    const result = deps.presence.report(
      reporter,
      clientSessionId.toLowerCase(),
      state,
      seq,
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
