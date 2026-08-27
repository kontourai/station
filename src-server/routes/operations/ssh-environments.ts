import { Hono } from 'hono';
import type { PairingScopeContextStore } from '../../security/pairing-route-scopes.js';
import { getBudgetPrincipal } from '../../security/runtime-request-security.js';
import type { PeerCredentialStore } from '../../services/peers/peer-credential-store.js';
import { SSH_PROBE_MAX_SECONDS } from '../../services/ssh/openssh-reachability.js';
import {
  listConnectedRemoteSessions,
  type RemoteSessionsFetcher,
  type RemoteSessionsResult,
} from '../../services/ssh/remote-session-reader.js';
import type { SshEnvironmentService } from '../../services/ssh/ssh-environment-service.js';
import {
  isSshProbeAdmissionRefusal,
  SshProbeAdmission,
} from '../../services/ssh/ssh-probe-admission.js';
import {
  errorMessage,
  getBody,
  param,
  sshEnvironmentCreateSchema,
  sshEnvironmentProbeSchema,
  validate,
} from '../schemas/schemas.js';

function errorStatus(message: string): 400 | 404 | 409 | 500 {
  if (/not found/i.test(message)) return 404;
  if (/mismatch|incompatible/i.test(message)) return 409;
  if (/invalid|required|must|alias|path|port/i.test(message)) return 400;
  return 500;
}

export function createSshEnvironmentRoutes(
  service: SshEnvironmentService,
  listRemoteSessions: (
    service: SshEnvironmentService,
    fetchSessions?: RemoteSessionsFetcher,
    peerCredentials?: Pick<PeerCredentialStore, 'get'>,
  ) => Promise<RemoteSessionsResult> = listConnectedRemoteSessions,
  peerCredentials?: Pick<PeerCredentialStore, 'get'>,
  /**
   * One admission gate per route instance, so its counters live exactly as
   * long as the server that owns the processes it bounds.
   */
  admission: SshProbeAdmission = new SshProbeAdmission({
    retryAfterSeconds: SSH_PROBE_MAX_SECONDS,
  }),
) {
  const app = new Hono();

  app.get('/hosts', async (c) => {
    try {
      return c.json({ success: true, data: await service.discover() });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 503);
    }
  });

  // station#1097 R1: read-only session aggregation across every connected
  // SSH environment, for the Home work list. Registered before `/:id` —
  // Hono matches route definitions in order, so a param route defined first
  // would swallow this literal path.
  app.get('/sessions', async (c) => {
    try {
      return c.json({
        success: true,
        data: peerCredentials
          ? await listRemoteSessions(service, undefined, peerCredentials)
          : await listRemoteSessions(service),
      });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 503);
    }
  });

  // "Test connection" before anything is saved (audit CI-R1/CI-R14).
  // Registered before `/:id` for the same reason `/hosts` is: Hono matches
  // in definition order, so a param route defined first would swallow it.
  // Read-only — it creates no profile and accepts no host key — but it is a
  // POST because it makes an outbound connection attempt with a body.
  app.post('/probe', validate(sshEnvironmentProbeSchema), async (c) => {
    // sol review finding 4: this is the one route that starts an outbound
    // process at a caller-named host, so it is admitted before it runs. The
    // key is the server-established budget principal (a hash of the verified
    // credential) — never anything the caller can choose. A request that
    // arrives without one ran outside the security boundary; it is bounded
    // as a single shared principal rather than exempted.
    const principal = getBudgetPrincipal(
      c as unknown as PairingScopeContextStore,
    );
    const ticket = admission.admit(principal?.key ?? 'unattributed');
    if (isSshProbeAdmissionRefusal(ticket)) {
      c.header('Retry-After', String(ticket.retryAfterSeconds));
      return c.json(
        {
          success: false,
          error:
            ticket.scope === 'principal'
              ? 'A connection test is already running. Wait for it to finish, then test again.'
              : 'Station is already running as many connection tests as it allows at once. Try again shortly.',
        },
        429,
      );
    }
    try {
      const body = getBody(c) as { hostAlias: string };
      return c.json({ success: true, data: await service.probe(body) });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    } finally {
      ticket.release();
    }
  });

  app.get('/', (c) => c.json({ success: true, data: service.list() }));

  app.get('/:id', (c) => {
    const data = service.get(param(c, 'id'));
    return data
      ? c.json({ success: true, data })
      : c.json({ success: false, error: 'SSH environment not found' }, 404);
  });

  app.post('/', validate(sshEnvironmentCreateSchema), async (c) => {
    try {
      const body = getBody(c);
      return c.json({ success: true, data: await service.add(body) }, 201);
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post('/:id/connect', async (c) => {
    try {
      return c.json({
        success: true,
        data: await service.connect(param(c, 'id')),
      });
    } catch (error) {
      const message = errorMessage(error);
      return c.json({ success: false, error: message }, errorStatus(message));
    }
  });

  app.post('/:id/disconnect', async (c) => {
    try {
      return c.json({
        success: true,
        data: await service.disconnect(param(c, 'id')),
      });
    } catch (error) {
      const message = errorMessage(error);
      return c.json({ success: false, error: message }, errorStatus(message));
    }
  });

  app.delete('/:id', async (c) => {
    try {
      const removed = await service.remove(param(c, 'id'));
      return removed
        ? c.json({ success: true })
        : c.json({ success: false, error: 'SSH environment not found' }, 404);
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
