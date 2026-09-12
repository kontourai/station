/// <reference path="../../src-server/veritas-engine.d.ts" />
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { configureRuntimeHttp } from '../../src-server/runtime/bootstrap/runtime-http.js';
import {
  configureDevicePairingHostRoutes,
  configureDevicePairingPublicRoutes,
  isRuntimeRequestPrincipalCurrent,
} from '../../src-server/runtime/routes/runtime-routes.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../src-server/security/runtime-request-security.js';
import { EventBus } from '../../src-server/services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../src-server/services/ssh/environment-security-service.js';
import { createLogger } from '../../src-server/utils/logger.js';

// A production security composition, not a full Station application or guest UI.
export async function startLocalSecurityEndpoint(home: string, marker: string) {
  const security = new EnvironmentSecurityService({ homeDir: home });
  const record = await security.initialize();
  const app = new Hono();
  const pairing = security.devicePairing;
  configureDevicePairingPublicRoutes(app as never, pairing);
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'local-collaboration-lab', level: 'error' }),
    eventBus: new EventBus(),
    security: {
      verifyCredential: (credential, request) =>
        request
          ? security.authorizeCredential(credential, request)
          : security.verifyCredential(credential),
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
    },
  });
  configureDevicePairingHostRoutes(app as never, pairing, {
    verifyOperatorCredential: (credential) =>
      security.verifyOperatorCredential(credential),
    isApprovalCurrent: (request) =>
      isRuntimeRequestPrincipalCurrent(request, security),
  });
  app.get('/api/projects/local-lab-probe', (c) => {
    const actor = getRuntimeAuthenticatedRequestPrincipal(c.req.raw);
    const device = actor && security.identifyDevice(actor.credential);
    if (!device) return c.json({ error: 'paired_device_required' }, 403);
    return c.json({
      marker,
      environmentId: record.environmentId,
      deviceId: device.id,
      person: device.principalBinding?.subject ?? null,
      identityEvidence: 'synthetic-fixture',
    });
  });
  const cert = readFileSync(join(home, 'tls.crt'));
  const server = createServer(
    {
      cert,
      key: readFileSync(join(home, 'tls.key')),
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    },
    getRequestListener(app.fetch),
  );
  let requests = 0;
  let rejectedTlsHandshakes = 0;
  server.on('tlsClientError', (error: NodeJS.ErrnoException) => {
    if (error.code?.startsWith('ERR_SSL_')) rejectedTlsHandshakes++;
  });
  server.on('request', () => {
    requests++;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (
    !address ||
    typeof address === 'string' ||
    [3000, 3141].includes(address.port)
  ) {
    server.close();
    throw new Error('Invalid or reserved local endpoint port');
  }
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    cert,
    operatorCredential: record.credential,
    security,
    requests: () => requests,
    rejectedTlsHandshakes: () => rejectedTlsHandshakes,
    close() {
      if (closing) return closing;
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      return closing;
    },
  };
}
