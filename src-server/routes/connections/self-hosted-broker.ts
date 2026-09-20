import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type {
  BrokerScope,
  SelfHostedBrokerService,
} from '../../services/connections/self-hosted-broker-service.js';

export function createSelfHostedBrokerRoutes(service: SelfHostedBrokerService) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (c.req.method === 'OPTIONS') {
      const headers = c.req
        .header('access-control-request-headers')
        ?.toLowerCase()
        .split(',')
        .map((value) => value.trim())
        .sort()
        .join(',');
      if (
        !origin ||
        !service.isOriginAllowed(origin) ||
        c.req.header('access-control-request-method') !== 'POST' ||
        headers !== 'authorization,content-type,x-broker-credential-id'
      )
        return c.json({ error: 'broker_credential_refused' }, 401);
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Methods', 'POST');
      c.header(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Broker-Credential-Id',
      );
      c.header('Vary', 'Origin');
      return c.body(null, 204);
    }
    await next();
    if (origin && service.isOriginAllowed(origin)) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
    }
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) => c.json({ error: 'request_too_large' }, 413),
    }),
  );
  const parse = async (c: Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new Error('invalid_request');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error('invalid_request');
    const secret = c.req
      .header('authorization')
      ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const id = c.req.header('x-broker-credential-id');
    if (!secret || !id) throw new Error('broker_credential_refused');
    const record = body as Record<string, unknown>;
    const scope = record.scope as Record<string, unknown> | undefined;
    if (!scope || c.req.header('origin') !== scope.browserOrigin)
      throw new Error('broker_credential_refused');
    return { body: record, credential: { id, secret } };
  };
  function exact(
    value: unknown,
    keys: string[],
  ): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid_request');
    if (Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
      throw new Error('invalid_request');
  }
  const invoke =
    (fn: (c: Context) => Promise<unknown> | unknown) => async (c: Context) => {
      try {
        return c.json(await fn(c));
      } catch (error) {
        const candidate = error instanceof Error ? error.message : '';
        const known = new Set([
          'invalid_request',
          'invalid_station_id',
          'invalid_enrollment_id',
          'invalid_generation',
          'invalid_browser_origin',
          'invalid_client_id',
          'invalid_nonce',
          'offer_too_large',
          'answer_too_large',
          'broker_credential_refused',
          'stale_generation',
          'lease_conflict',
          'pending_limit',
          'connection_replayed',
          'connection_unavailable',
        ]);
        const message = known.has(candidate) ? candidate : 'broker_unavailable';
        return c.json(
          { error: message },
          message === 'broker_unavailable'
            ? 500
            : message.includes('invalid') || message.includes('too_large')
              ? 400
              : message.includes('conflict') || message.includes('replayed')
                ? 409
                : 401,
        );
      }
    };
  app.post(
    '/leases/register',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope']);
      return service.register(body.scope as BrokerScope, credential);
    }),
  );
  app.post(
    '/stations/status',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope']);
      return service.status(body.scope as BrokerScope, credential);
    }),
  );
  app.post(
    '/connections/offers',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope']);
      return { offers: service.offers(body.scope as BrokerScope, credential) };
    }),
  );
  app.post(
    '/connections',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope', 'connection']);
      const connection = body.connection;
      exact(connection, ['clientId', 'nonce', 'offerSdp']);
      return service.open(
        body.scope as BrokerScope,
        credential,
        connection as { clientId: string; nonce: string; offerSdp: string },
      );
    }),
  );
  app.post(
    '/connections/answer',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope', 'connection']);
      const connection = body.connection;
      exact(connection, ['clientId', 'nonce', 'answerSdp', 'stationProof']);
      service.answer(
        body.scope as BrokerScope,
        credential,
        connection as {
          clientId: string;
          nonce: string;
          answerSdp: string;
          stationProof: string;
        },
      );
      return { accepted: true };
    }),
  );
  app.post(
    '/connections/read',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope', 'clientId', 'nonce']);
      return service.read(
        body.scope as BrokerScope,
        credential,
        String(body.clientId),
        String(body.nonce),
      );
    }),
  );
  app.post(
    '/leases/renew',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope', 'expectedRevision']);
      return service.renew(
        body.scope as BrokerScope,
        credential,
        Number(body.expectedRevision),
      );
    }),
  );
  app.post(
    '/leases/withdraw',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope']);
      service.withdraw(body.scope as BrokerScope, credential);
      return { withdrawn: true };
    }),
  );
  return app;
}
