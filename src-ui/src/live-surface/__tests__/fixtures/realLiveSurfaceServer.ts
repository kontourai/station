/**
 * The REAL live-surface server for viewer tests (#90): the production
 * registry, control lease, hub and HTTP routes, over the test-only
 * synthetic producer. A viewer's transport calls the routes in process, so
 * what the hook and canvas send is what the server receives, and what the
 * server answers (leases, epoch causes, refusals, held-input releases) is
 * what they get: no fixture decides causality or pressed state.
 *
 * Every viewer is the same person on the same device (two tabs share one
 * server controller); `agentClaim` takes control as an agent would.
 */
import { Hono } from 'hono';

const SURFACE = 'browser:real-1';
export const REAL_SURFACE = SURFACE;
export const REAL_API = 'http://station.test';
export const REAL_PERSON = {
  principal: 'human:local:me',
  device: 'device:mine',
} as const;

/**
 * The public handshake a host serves (shape captured from a running
 * install), with this build's real capability flags, or without the live
 * surface one for an older host.
 */
function handshake(
  flags: Record<string, boolean>,
  epochCause: boolean,
): unknown {
  const capabilities = { ...flags };
  if (!epochCause) delete capabilities.liveSurfaceEpochCause;
  return {
    schemaVersion: 1,
    environmentId: '00000000-0000-4000-8000-000000000000',
    authentication: { scheme: 'bearer', protocolVersion: 1 },
    transports: { http: 1, sse: 1, websocket: 1 },
    compatibility: {
      serverVersion: '0.1.11',
      protocolVersion: 3,
      minClientProtocol: 1,
      capabilities: {
        productTelemetryAcknowledgement: 2,
        remoteAuth: 1,
        devicePairing: 1,
        environmentProof: 1,
        clientProtocolHeader: 1,
      },
    },
    capabilities,
  };
}

export async function realLiveSurfaceServer(
  options: { epochCause?: boolean } = {},
) {
  const [
    { LiveSurfaceRegistry, claimAgentControl },
    routesModule,
    producerModule,
    flagsModule,
  ] = await Promise.all([
    import('../../../../../src-server/services/live-surface/registry'),
    import('../../../../../src-server/routes/live-surface'),
    import(
      '../../../../../src-server/__test-utils__/synthetic-live-surface-producer'
    ),
    import('../../../../../src-server/capabilities/station-capability-flags'),
  ]);
  const registry = new LiveSurfaceRegistry();
  const producer = new producerModule.SyntheticLiveSurfaceProducer(SURFACE, {
    backpressure: false,
  });
  registry.register(producer, { authorize: () => true });
  const app = new Hono().route(
    '/api/live-surfaces',
    routesModule.createLiveSurfaceRoutes(registry, {
      isRequestPrincipalCurrent: () => true,
      // One person and device unless a viewer acts as someone else.
      resolveHumanCaller: (c) => {
        const other = c.req.header('x-test-person');
        return other
          ? { principal: other, device: `device:${other}` }
          : { ...REAL_PERSON };
      },
      principalRecheckMs: 0,
    }),
  );
  const flags = { ...flagsModule.STATION_CAPABILITY_FLAGS } as Record<
    string,
    boolean
  >;
  const epochCause = options.epochCause !== false;

  /** What every viewer's requests did, in order, for assertions. */
  const requests: { url: string; body: unknown }[] = [];
  /**
   * One viewer's transport. `loseAnswer`, when it returns true for a
   * request, lets the server apply it and then fails the request as if the
   * answer was lost on the way back.
   */
  const transport =
    (
      viewer: {
        /** Act as a different person (another controller). */
        person?: string;
        loseAnswer?: (url: string, body: unknown) => boolean;
        hang?: (url: string, body: unknown) => boolean;
      } = {},
    ) =>
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/.well-known/station/v1'))
        return Response.json(handshake(flags, epochCause));
      const body =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      if (!url.includes('/frames')) requests.push({ url, body });
      if (viewer.hang?.(url, body))
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      const headers = new Headers(init?.headers);
      if (viewer.person) headers.set('x-test-person', viewer.person);
      const response = await app.request(url.replace(REAL_API, ''), {
        ...init,
        headers,
      });
      if (viewer.loseAnswer?.(url, body)) {
        await response.text().catch(() => '');
        throw new TypeError('network connection was lost');
      }
      return response;
    };

  const entry = () => {
    const found = registry.get(SURFACE);
    if (!found) throw new Error('surface not registered');
    return found;
  };
  return {
    producer,
    registry,
    transport,
    requests,
    /** The lease as the server holds it now. */
    lease: () => entry().lease.snapshot(),
    /** An agent takes control (it never preempts a live human hold). */
    agentClaim: () =>
      claimAgentControl(
        entry(),
        { kind: 'agent', principal: 'agent:coder', sessionId: 'agent-1' },
        REAL_PERSON.principal,
      ),
    /** Publish a frame so viewers have a picture (input needs one). */
    emitFrame: () => producer.emit(),
    /**
     * What the surface has down right now, replayed from every event the
     * producer received (a held-input cancel arrives as ordinary releases).
     */
    remotePressed: () => {
      const down = new Set<string>();
      for (const event of producer.dispatched) {
        if (
          event.kind === 'pointer' &&
          (event.type === 'down' || event.type === 'up')
        ) {
          const id = `button:${event.button ?? 'left'}`;
          if (event.type === 'down') down.add(id);
          else down.delete(id);
        }
        if (event.kind === 'key') {
          const id = `key:${event.code || event.key}`;
          if (event.type === 'down') down.add(id);
          else down.delete(id);
        }
      }
      return [...down];
    },
    dispose: () => registry.dispose(),
  };
}
