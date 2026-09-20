import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { SelfHostedBrokerService } from '../../services/connections/self-hosted-broker-service.js';

export function createSelfHostedBrokerRoutes(service: SelfHostedBrokerService) {
  const app = new Hono();
  app.use(
    '*',
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) => c.json({ error: 'request_too_large' }, 413),
    }),
  );
  const parse = async (c: any) => {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error('invalid_request');
    const secret = c.req
      .header('authorization')
      ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const id = c.req.header('x-broker-credential-id');
    if (!secret || !id) throw new Error('broker_credential_refused');
    const scope = (body as Record<string, any>).scope;
    if (!scope || c.req.header('origin') !== scope.browserOrigin)
      throw new Error('broker_credential_refused');
    return { body, credential: { id, secret } };
  };
  const exact = (value: Record<string, unknown>, keys: string[]) => {
    if (Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
      throw new Error('invalid_request');
  };
  const invoke =
    (fn: (c: any) => Promise<unknown> | unknown) => async (c: any) => {
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
    '/connections/offers',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope']);
      return { offers: service.offers(body.scope, credential) };
    }),
  );
  app.post(
    '/connections',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope', 'connection']);
      exact(body.connection, ['clientId', 'nonce', 'offerSdp']);
      return service.open(body.scope, credential, body.connection);
    }),
  );
  app.post(
    '/connections/answer',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope', 'connection']);
      exact(body.connection, [
        'clientId',
        'nonce',
        'answerSdp',
        'stationProof',
      ]);
      service.answer(body.scope, credential, body.connection);
      return { accepted: true };
    }),
  );
  app.post(
    '/connections/read',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope', 'clientId', 'nonce']);
      return service.read(body.scope, credential, body.clientId, body.nonce);
    }),
  );
  app.post(
    '/leases/renew',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope', 'expectedRevision']);
      return service.renew(body.scope, credential, body.expectedRevision);
    }),
  );
  app.post(
    '/leases/withdraw',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope']);
      service.withdraw(body.scope, credential);
      return { withdrawn: true };
    }),
  );
  return app;
}
