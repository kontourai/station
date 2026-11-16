import { type Context, Hono } from 'hono';
import type { PairingScopeContextStore } from '../../security/pairing-route-scopes.js';
import {
  type RemoteStationReadAuthority,
  remoteStationReadDecision,
} from '../../security/remote-station-read-authority.js';
import { getBudgetPrincipal } from '../../security/runtime-request-security.js';
import type { PeerCredentialStore } from '../../services/peers/peer-credential-store.js';
import { SSH_PROBE_MAX_SECONDS } from '../../services/ssh/openssh-reachability.js';
import {
  listConnectedRemoteSessions,
  MAX_REMOTE_HISTORY_CURSOR_LENGTH,
  MAX_REMOTE_SESSION_HISTORY_TURNS,
  RemoteSessionHistoryError,
  type RemoteSessionHistoryFailure,
  type RemoteSessionHistoryFetcher,
  type RemoteSessionsFetcher,
  type RemoteSessionsResult,
  readConnectedRemoteSessionHistory,
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

/** Profile ids and thread ids are opaque, single path segments. */
const REMOTE_HISTORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

/**
 * No failure is a 401: this Station authenticated its own caller, and a 401
 * here would read to the client as its own credential being refused.
 */
const REMOTE_HISTORY_FAILURES: Record<
  RemoteSessionHistoryFailure,
  { status: 404 | 409 | 502; message: string }
> = {
  environment_unavailable: {
    status: 409,
    message: 'That computer is not connected. Connect it, then try again.',
  },
  authentication_required: {
    status: 409,
    message:
      'This Station has no working credential for that computer. Reconnect it to repair access.',
  },
  not_found: { status: 404, message: 'Session not found on that computer.' },
  unreachable: {
    status: 502,
    message: 'That computer did not answer in time. Try again.',
  },
  too_large: {
    status: 502,
    message:
      "That computer's session page is larger than this Station relays. Update Station there, then try again.",
  },
  invalid_response: {
    status: 502,
    message:
      "That computer's Station returned history this Station cannot show. Update it, then try again.",
  },
};

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
  /** For tests: how one remote history page is fetched over the tunnel. */
  fetchRemoteHistory?: RemoteSessionHistoryFetcher,
  /**
   * Who may read another Station's sessions through this one. Absent means
   * nobody: both remote reads fail closed until runtime composition binds it.
   */
  remoteReads?: RemoteStationReadAuthority,
) {
  const app = new Hono();

  /**
   * The remote Station authorizes the stored outbound peer bearer, which is
   * Station-wide: it does not say which local caller asked. So the local
   * caller must be the one person that bearer stands for, as the paired
   * Station chat relay requires over the same credential
   * (`peer-chat-routes.ts`): the bound owner, still current, and never a
   * request an agent could have sent. A hosted Station has no tenant binding
   * for that bearer, so it serves neither read (its handshake withdraws
   * `remoteSessionHistory` to match).
   */
  const refuseRemoteRead = (c: Context): Response | undefined => {
    const decision = remoteStationReadDecision(remoteReads, c.req.raw);
    if (decision === 'admitted') return undefined;
    return decision === 'unavailable'
      ? c.json(
          {
            success: false,
            error: 'This Station does not read other computers.',
          },
          404,
        )
      : c.json({ success: false, error: 'Forbidden' }, 403);
  };

  app.get('/hosts', async (c) => {
    try {
      return c.json({ success: true, data: await service.discover() });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 503);
    }
  });

  // archive#1097 R1: read-only session aggregation across every connected
  // SSH environment, for the Home work list. Registered before `/:id` —
  // Hono matches route definitions in order, so a param route defined first
  // would swallow this literal path.
  app.get('/sessions', async (c) => {
    const refused = refuseRemoteRead(c);
    if (refused) return refused;
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

  // One read-only history page of a session that lives on a connected SSH
  // environment's Station (attached external sessions included: the remote
  // Station discovered those on its own host). Under the `/sessions` prefix
  // on purpose, so it takes that leaf's `orchestration:operate` scope in
  // pairing-route-scopes.ts. Never dials: an environment that is not
  // connected answers `environment_unavailable`.
  app.get('/sessions/:environmentId/:threadId/history', async (c) => {
    const refused = refuseRemoteRead(c);
    if (refused) return refused;
    const environmentId = param(c, 'environmentId');
    const threadId = param(c, 'threadId');
    const cursor = c.req.query('cursor');
    const turnLimitText = c.req.query('turnLimit');
    const turnLimit =
      turnLimitText === undefined ? 10 : Number.parseInt(turnLimitText, 10);
    if (
      !REMOTE_HISTORY_ID.test(environmentId) ||
      !REMOTE_HISTORY_ID.test(threadId) ||
      (cursor !== undefined &&
        (cursor.length === 0 ||
          cursor.length > MAX_REMOTE_HISTORY_CURSOR_LENGTH)) ||
      (turnLimitText !== undefined && !/^[0-9]{1,2}$/u.test(turnLimitText)) ||
      turnLimit < 1 ||
      turnLimit > MAX_REMOTE_SESSION_HISTORY_TURNS
    ) {
      return c.json(
        { success: false, error: 'Invalid remote session history request' },
        400,
      );
    }
    try {
      const data = await readConnectedRemoteSessionHistory(
        service,
        environmentId,
        threadId,
        { ...(cursor !== undefined ? { cursor } : {}), turnLimit },
        fetchRemoteHistory,
        peerCredentials,
        c.req.raw.signal,
      );
      return c.json({ success: true, data });
    } catch (error) {
      if (error instanceof RemoteSessionHistoryError) {
        const { status, message } = REMOTE_HISTORY_FAILURES[error.reason];
        return c.json(
          { success: false, error: message, code: error.reason },
          status,
        );
      }
      return c.json(
        {
          success: false,
          error: 'Could not read this session from the other computer.',
          code: 'unreachable',
        },
        502,
      );
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
