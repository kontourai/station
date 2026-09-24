import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeConnectionOpenV2,
  SelfHostedBrokerNativeRedemptionProofV2,
  SelfHostedBrokerNativeRouteInvitationV2,
  SelfHostedBrokerNativeScopeV2,
  SelfHostedBrokerRouteInvitationV1,
} from '@kontourai/station-contracts/self-hosted-broker';
import {
  SELF_HOSTED_BROKER_NATIVE_CONNECTION_ANSWER_VERSION,
  SELF_HOSTED_BROKER_NATIVE_CONNECTION_OFFER_VERSION,
  SELF_HOSTED_BROKER_NATIVE_CONNECTION_READ_VERSION,
  SELF_HOSTED_BROKER_NATIVE_GRANT_RETIRE_VERSION,
} from '@kontourai/station-contracts/self-hosted-broker';
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
    // The final client grant may be retired by this request. Preserve the
    // pre-request CORS decision so a committed success remains observable;
    // each handler still authenticates its exact credential independently.
    const allowedOrigin = Boolean(origin && service.isOriginAllowed(origin));
    if (c.req.method === 'OPTIONS') {
      const pathname = new URL(c.req.url).pathname;
      if (/\/native\/(?:connections(?:\/.*)?|grants\/retire)$/.test(pathname))
        return c.json({ error: 'broker_credential_refused' }, 401);
      const redeem = pathname.endsWith('/grants/redeem');
      const headers = c.req
        .header('access-control-request-headers')
        ?.toLowerCase()
        .split(',')
        .map((value) => value.trim())
        .sort()
        .join(',');
      if (
        !origin ||
        !allowedOrigin ||
        c.req.header('access-control-request-method') !== 'POST' ||
        headers !==
          (redeem
            ? 'content-type'
            : 'authorization,content-type,x-broker-credential-id')
      )
        return c.json({ error: 'broker_credential_refused' }, 401);
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Methods', 'POST');
      c.header(
        'Access-Control-Allow-Headers',
        redeem
          ? 'Content-Type'
          : 'Authorization, Content-Type, X-Broker-Credential-Id',
      );
      c.header('Vary', 'Origin');
      return c.body(null, 204);
    }
    await next();
    if (origin && allowedOrigin) {
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
  const parseNativeClient = async (c: Context) => {
    if (
      c.req.header('origin') ||
      c.req.header('cookie') ||
      c.req.header('content-type')?.toLowerCase() !== 'application/json'
    )
      throw new Error('broker_credential_refused');
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
    return {
      body: body as Record<string, unknown>,
      credential: { id, secret },
    };
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
          'invalid_scope',
          'invalid_station_id',
          'invalid_enrollment_id',
          'invalid_generation',
          'invalid_browser_origin',
          'invalid_broker_origin',
          'invalid_invitation',
          'invalid_native_scope',
          'invalid_native_surface',
          'invalid_native_proof',
          'invalid_native_invitation',
          'invalid_native_connection',
          'invalid_invitation_lifetime',
          'invalid_signing_key_id',
          'invalid_signing_generation',
          'invalid_grant_id',
          'invalid_client_id',
          'invalid_nonce',
          'offer_too_large',
          'answer_too_large',
          'broker_credential_refused',
          'stale_generation',
          'lease_conflict',
          'pending_limit',
          'invitation_limit',
          'grant_limit',
          'invitation_refused',
          'native_invitation_refused',
          'grant_unavailable',
          'connection_replayed',
          'connection_unavailable',
        ]);
        const message = known.has(candidate) ? candidate : 'broker_unavailable';
        return c.json(
          { error: message },
          message === 'broker_unavailable'
            ? 500
            : message.endsWith('_limit')
              ? 429
              : message.includes('invalid') || message.includes('too_large')
                ? 400
                : message.includes('conflict') || message.includes('replayed')
                  ? 409
                  : 401,
        );
      }
    };
  app.post(
    '/native/connections/open',
    invoke(async (c) => {
      const { body, credential } = await parseNativeClient(c);
      exact(body, ['scope', 'surface', 'connection']);
      const connection = body.connection;
      exact(connection, ['version', 'nonce', 'offerSdp']);
      return service.openNativeConnection(
        body.scope as SelfHostedBrokerNativeScopeV2,
        credential,
        body.surface as SelfHostedBrokerNativeClientSurfaceV2,
        connection as unknown as SelfHostedBrokerNativeConnectionOpenV2,
      );
    }),
  );
  app.post(
    '/native/connections/read',
    invoke(async (c) => {
      const { body, credential } = await parseNativeClient(c);
      exact(body, ['version', 'scope', 'surface', 'nonce']);
      if (body.version !== SELF_HOSTED_BROKER_NATIVE_CONNECTION_READ_VERSION)
        throw new Error('invalid_native_connection');
      if (typeof body.nonce !== 'string') throw new Error('invalid_nonce');
      return service.readNativeConnection(
        body.scope as SelfHostedBrokerNativeScopeV2,
        credential,
        body.surface as SelfHostedBrokerNativeClientSurfaceV2,
        body.nonce,
      );
    }),
  );
  app.post(
    '/native/grants/retire',
    invoke(async (c) => {
      const { body, credential } = await parseNativeClient(c);
      exact(body, ['version', 'scope', 'surface']);
      if (body.version !== SELF_HOSTED_BROKER_NATIVE_GRANT_RETIRE_VERSION)
        throw new Error('invalid_native_connection');
      service.retireOwnNativeClientGrant(
        body.scope as SelfHostedBrokerNativeScopeV2,
        credential,
        body.surface as SelfHostedBrokerNativeClientSurfaceV2,
      );
      return {
        version: SELF_HOSTED_BROKER_NATIVE_GRANT_RETIRE_VERSION,
        retired: true,
      };
    }),
  );
  app.post(
    '/native/connections/offers',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope', 'surface', 'limit', 'version']);
      if (body.version !== SELF_HOSTED_BROKER_NATIVE_CONNECTION_OFFER_VERSION)
        throw new Error('invalid_native_connection');
      return {
        offers: service.nativeOffers(
          body.scope as BrokerScope,
          credential,
          body.surface as SelfHostedBrokerNativeClientSurfaceV2,
          Number(body.limit),
        ),
      };
    }),
  );
  app.post(
    '/native/connections/answer',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope', 'surface', 'connection', 'version']);
      if (body.version !== SELF_HOSTED_BROKER_NATIVE_CONNECTION_ANSWER_VERSION)
        throw new Error('invalid_native_connection');
      const connection = body.connection;
      exact(connection, [
        'clientId',
        'nonce',
        'stationSigningKeyId',
        'stationSigningGeneration',
        'answerSdp',
        'stationProof',
      ]);
      return service.answerNativeConnection(
        body.scope as BrokerScope,
        credential,
        {
          version: SELF_HOSTED_BROKER_NATIVE_CONNECTION_ANSWER_VERSION,
          surface: body.surface as SelfHostedBrokerNativeClientSurfaceV2,
          ...(connection as {
            clientId: string;
            nonce: string;
            stationSigningKeyId: string;
            stationSigningGeneration: number;
            answerSdp: string;
            stationProof: string;
          }),
        },
      );
    }),
  );
  app.post(
    '/native/grants/invitations/issue',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, [
        'scope',
        'brokerOrigin',
        'surface',
        'stationSigningKeyId',
        'stationSigningGeneration',
      ]);
      return service.issueNativeInvitation({
        scope: body.scope as BrokerScope,
        routingCredential: credential,
        brokerOrigin: body.brokerOrigin as string,
        surface:
          body.surface as SelfHostedBrokerNativeRouteInvitationV2['surface'],
        stationSigningKeyId: body.stationSigningKeyId as string,
        stationSigningGeneration: body.stationSigningGeneration as number,
      });
    }),
  );
  app.post(
    '/native/grants/list',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope']);
      return service.listNativeClientGrants(
        body.scope as BrokerScope,
        credential,
      );
    }),
  );
  app.post(
    '/native/grants/revoke',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope', 'grantId']);
      if (typeof body.grantId !== 'string') throw new Error('invalid_request');
      service.revokeNativeClientGrant(
        body.scope as BrokerScope,
        credential,
        body.grantId,
      );
      return { revoked: true };
    }),
  );
  app.post(
    '/native/grants/redeem',
    invoke(async (c) => {
      if (
        c.req.header('origin') ||
        c.req.header('cookie') ||
        c.req.header('authorization') ||
        c.req.header('x-broker-credential-id') ||
        c.req.header('content-type')?.toLowerCase() !== 'application/json'
      )
        throw new Error('broker_credential_refused');
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new Error('invalid_request');
      }
      exact(body, ['invitation', 'proof']);
      const record = body as Record<string, unknown>;
      return service.redeemNativeInvitation(
        record.invitation as SelfHostedBrokerNativeRouteInvitationV2,
        record.proof as SelfHostedBrokerNativeRedemptionProofV2,
      );
    }),
  );
  app.post(
    '/grants/redeem',
    invoke(async (c) => {
      if (
        c.req.header('authorization') ||
        c.req.header('x-broker-credential-id') ||
        c.req.header('cookie') ||
        c.req.header('content-type')?.toLowerCase() !== 'application/json'
      )
        throw new Error('broker_credential_refused');
      const origin = c.req.header('origin');
      if (!origin) throw new Error('broker_credential_refused');
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new Error('invalid_request');
      }
      exact(body, ['invitation']);
      return service.redeemInvitation(
        body.invitation as SelfHostedBrokerRouteInvitationV1,
        origin,
      );
    }),
  );
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
    '/grants/revoke',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope', 'grantId']);
      service.revokeClientGrant(
        body.scope as BrokerScope,
        credential,
        String(body.grantId),
      );
      return { revoked: true };
    }),
  );
  app.post(
    '/grants/retire',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope']);
      service.retireOwnClientGrant(body.scope as BrokerScope, credential);
      return { retired: true };
    }),
  );
  app.post(
    '/connections/offers',
    invoke(async (c) => {
      const { body, credential } = await parse(c);
      exact(body, ['scope', 'limit']);
      return {
        offers: service.offers(
          body.scope as BrokerScope,
          credential,
          Number(body.limit),
        ),
      };
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
