import type { Server } from 'node:http';
import { type HttpBindings, serve } from '@hono/node-server';
import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { Hono } from 'hono';
import { afterEach } from 'vitest';
import { createAuthRoutes } from '../routes/system/auth.js';
import { createOrchestrationRequestPrincipalResolver } from '../runtime/bootstrap/orchestration-request-principal.js';
import { configureRuntimeHttp } from '../runtime/bootstrap/runtime-http.js';
import { configureRuntimePublicRoutes } from '../runtime/routes/runtime-routes.js';
import { EventBus } from '../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../services/ssh/environment-security-service.js';
import { trackTempDirs } from './temp-dirs.js';

const makeTempDir = trackTempDirs();
const servers = new Set<Server>();
afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
  servers.clear();
});
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return this;
  },
  setLevel() {},
  getLevel() {
    return 'info' as const;
  },
};
type Bindings = HttpBindings;

/** Two in-process HTTP listeners use the production admission/principal compositions. */
export async function peerChatRuntime(retainedHomeDir?: string) {
  const homeDir = retainedHomeDir ?? makeTempDir('station-peer-chat-boundary-');
  const security = new EnvironmentSecurityService({ homeDir, environment: {} });
  await security.initialize();
  const app = new Hono<{ Bindings: Bindings }>();
  configureRuntimePublicRoutes(app as never, security, () => true);
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: new EventBus(),
    security: {
      allowedOrigins: [],
      verifyCredential: (credential, request) =>
        request
          ? security.authorizeCredential(credential, request)
          : security.verifyCredential(credential),
      recognizeCredential: (credential) =>
        security.verifyCredential(credential),
      resolveGrantedScope: (credential) =>
        security.resolveGrantedScope(credential),
      resolveCredentialAuthority: (credential) =>
        security.verifyOperatorCredential(credential)
          ? 'operator-credential'
          : security.identifyDevice(credential)
            ? 'device-credential'
            : undefined,
      resolveCredentialDeviceId: (credential) =>
        security.identifyDevice(credential)?.id,
      resolveCredentialDeviceKind: (credential) =>
        security.identifyDevice(credential)?.kind,
      resolveCredentialLocality: (credential) =>
        security.credentialLocality(credential),
      resolveCredentialMintKind: (credential) =>
        security.credentialMintKind(credential),
      resolveCredentialOwnerStanding: (credential) =>
        security.credentialHasOwnerStanding(credential),
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  const principal = createOrchestrationRequestPrincipalResolver({
    environmentSecurityService: security,
  });
  app.route(
    '/api/auth',
    createAuthRoutes({ security, resolveRequestPrincipal: principal }),
  );
  const listen = async () => {
    const server = await new Promise<Server>((resolve) => {
      const listener = serve(
        { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
        () => resolve(listener as Server),
      );
    });
    servers.add(server);
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Runtime did not bind its owned port');
    return `http://127.0.0.1:${address.port}`;
  };
  const pair = (
    scope: string,
    kind: 'device' | 'delegation' = 'device',
    person?: string,
  ): { credential: string; device: PairedDevice } => {
    const pairing = security.devicePairing;
    const offer = pairing.createOffer({
      endpoint: 'https://receiver.test',
      scope,
      kind,
    });
    const request = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: kind === 'delegation' ? 'Source Station' : 'Phone',
      ...(person
        ? {
            source: 'tailnet' as const,
            requester: { provider: 'tailscale-serve' as const, login: person },
          }
        : { source: 'pairing-code' as const }),
    });
    pairing.confirmRequest(
      request.requestId,
      { kind: 'presented-credential' },
      person
        ? {
            principalId: humanPrincipal('tailscale-serve', person, person).id,
            kind: 'verified-ingress',
          }
        : undefined,
    );
    return pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });
  };
  const call = (path: string, credential: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${credential}`);
    return app.request(path, { ...init, headers }, {
      incoming: { socket: { remoteAddress: '100.96.12.7' } },
    } as Bindings);
  };
  return { app, security, pair, call, principal, homeDir, listen };
}
