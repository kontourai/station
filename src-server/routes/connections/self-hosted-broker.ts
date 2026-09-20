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
    return { body, credential: { id, secret } };
  };
  const invoke =
    (fn: (c: any) => Promise<unknown> | unknown) => async (c: any) => {
      try {
        return c.json(await fn(c));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'broker_refused';
        return c.json(
          { error: message },
          message.includes('invalid')
            ? 400
            : message.includes('conflict') || message.includes('replayed')
              ? 409
              : 401,
        );
      }
    };
  app.post(
    '/connections',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      return service.open(body.scope, credential, body.connection);
    }),
  );
  app.post(
    '/connections/answer',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      service.answer(body.scope, credential, body.connection);
      return { accepted: true };
    }),
  );
  app.post(
    '/connections/read',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      return service.read(body.scope, credential, body.clientId, body.nonce);
    }),
  );
  app.post(
    '/leases/renew',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      return service.renew(body.scope, credential, body.expectedExpiresAt);
    }),
  );
  app.post(
    '/leases/withdraw',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      service.withdraw(body.scope, credential);
      return { withdrawn: true };
    }),
  );
  return app;
}
