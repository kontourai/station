import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { build } from 'esbuild';
import { Hono } from 'hono';
import { configureRuntimeHttp } from '../runtime/bootstrap/runtime-http.js';
import { createConsentApp } from '../runtime/consent/consent-listener.js';
import {
  configureDevicePairingHostRoutes,
  configureDevicePairingPublicRoutes,
} from '../runtime/routes/runtime-routes.js';
import { isRuntimeRequestPrincipalCurrent } from '../security/runtime-request-security.js';
import { ConsentChannelService } from '../services/consent/consent-channel.js';
import { OperatorPasskeyEnrollmentService } from '../services/identity/operator-passkey-enrollment.js';
import { LazyOperatorPasskeyRegistry } from '../services/identity/operator-passkey-registry.js';
import { OperatorSessionService } from '../services/identity/operator-sessions.js';
import type { EventBus } from '../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../services/ssh/environment-security-service.js';
import { createLogger } from '../utils/logger.js';

const home = process.argv[2];
if (!home) throw new Error('operator_session_fixture_home_required');
const registry = new LazyOperatorPasskeyRegistry(home);
const servers: Array<ReturnType<typeof serve>> = [];
async function start() {
  const tls = {
    key: readFileSync(join(home, 'key.pem')),
    cert: readFileSync(join(home, 'cert.pem')),
  };
  const security = new EnvironmentSecurityService({ homeDir: home });
  await security.initialize();
  const pairing = security.devicePairing;
  const api = new Hono();
  const appServer = serve({
    fetch: api.fetch,
    hostname: '127.0.0.1',
    port: 0,
    createServer: createHttpsServer,
    serverOptions: tls,
  });
  servers.push(appServer);
  if (!appServer.listening)
    await new Promise<void>((resolve) => appServer.once('listening', resolve));
  const appOrigin = `https://localhost:${(appServer.address() as AddressInfo).port}`;
  let consent: Hono;
  const consentServer = serve({
    fetch: (request) => consent.fetch(request),
    hostname: '127.0.0.1',
    port: 0,
    createServer: createHttpsServer,
    serverOptions: tls,
  });
  servers.push(consentServer);
  if (!consentServer.listening)
    await new Promise<void>((resolve) =>
      consentServer.once('listening', resolve),
    );
  const consentOrigin = `https://localhost:${(consentServer.address() as AddressInfo).port}`;
  const channel = new ConsentChannelService({ trustedOrigin: consentOrigin });
  channel.markListening((consentServer.address() as AddressInfo).port);
  const sessions = new OperatorSessionService({
    registry,
    origin: consentOrigin,
    identifyDevice: (credential) => security.identifyDevice(credential),
    epoch: () =>
      security.pseudonymizePairingAuditSource('operator-session-epoch.v1'),
  });
  const passkeys = new OperatorPasskeyEnrollmentService({
    registry,
    origin: consentOrigin,
  });
  consent = createConsentApp({
    channel,
    credentials: security,
    passkeys,
    sessions,
  });
  const bundled = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client'; import {PairedDevicesPanel} from './packages/connect/src/react/connection-manager-modal/PairedDevicesPanel'; import './src-ui/src/index.css'; import './packages/connect/src/react/ConnectionManagerModal.css'; createRoot(document.getElementById('root')).render(<PairedDevicesPanel apiBase={location.origin} getCredential={() => undefined} onPairDevice={() => {}} onBack={() => {}}/>);`,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    outdir: 'operator-s3-browser',
    logLevel: 'silent',
    external: ['/fonts/*', '/favicon-*'],
    loader: { '.woff2': 'empty', '.woff': 'empty' },
  });
  const script = bundled.outputFiles.find((file) =>
    file.path.endsWith('.js'),
  )!.text;
  const css = bundled.outputFiles.find((file) =>
    file.path.endsWith('.css'),
  )!.text;
  api.get('/', (c) =>
    c.html(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paired devices</title><link rel="stylesheet" href="/fixture.css"></head><body style="margin:24px;max-width:700px"><h1>Paired devices</h1><div id="root"></div><script src="/fixture.js"></script></body></html>',
    ),
  );
  api.get('/fixture.js', (c) =>
    c.body(script, 200, { 'Content-Type': 'text/javascript' }),
  );
  api.get('/fixture.css', (c) =>
    c.body(css, 200, { 'Content-Type': 'text/css' }),
  );
  api.get('/.well-known/station/v1', async (c) =>
    c.json(await security.getPublicHandshake()),
  );
  api.post('/.well-known/station/v1/proof', async (c) =>
    c.json(await security.createPublicProof((await c.req.json()).nonce)),
  );
  configureDevicePairingPublicRoutes(api as never, pairing, {
    allowedOrigins: [appOrigin],
  });
  configureRuntimeHttp({
    app: api as never,
    logger: createLogger({ name: 'operator-s3-browser' }),
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      operatorSessions: sessions,
      allowedOrigins: [appOrigin],
      verifyCredential: (credential, request) =>
        request
          ? security.authorizeCredential(credential, request)
          : security.verifyCredential(credential),
      recognizeCredential: (credential) =>
        security.verifyCredential(credential),
      resolveCredentialAuthority: (credential) =>
        security.verifyOperatorCredential(credential)
          ? 'operator-credential'
          : security.identifyDevice(credential)
            ? 'device-credential'
            : undefined,
      resolveGrantedScope: (credential) =>
        security.resolveGrantedScope(credential),
    },
  });
  configureDevicePairingHostRoutes(api as never, pairing, {
    operatorPasskeys: passkeys,
    operatorSessions: sessions,
    verifyOperatorCredential: (credential) =>
      security.verifyOperatorCredential(credential),
    isRequestPrincipalCurrent: (request) =>
      isRuntimeRequestPrincipalCurrent(request, security),
    isApprovalCurrent: (request) =>
      isRuntimeRequestPrincipalCurrent(request, security),
  });
  const cliServer = serve({
    fetch: api.fetch,
    hostname: '127.0.0.1',
    port: 0,
  });
  servers.push(cliServer);
  if (!cliServer.listening)
    await new Promise<void>((resolve) => cliServer.once('listening', resolve));
  const cliOrigin = `http://127.0.0.1:${(cliServer.address() as AddressInfo).port}`;

  process.send?.({ appOrigin, consentOrigin, cliOrigin });
}
const logger = createLogger({ name: 'operator-session-browser-fixture' });
async function close() {
  for (const server of servers) {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  registry.close();
  process.exit(0);
}
process.on('SIGTERM', () => void close());
process.on('disconnect', () => void close());
start().catch((error) => {
  logger.error('Operator session browser fixture failed', { error });
  process.exit(1);
});
