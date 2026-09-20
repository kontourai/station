import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { serve } from '@hono/node-server';
import {
  mutateJsonFileWithGuardedRead,
  readJsonFile,
} from '@kontourai/station-shared/json-file-storage';
import { Hono } from 'hono';
import { createSelfHostedBrokerRoutes } from '../src-server/routes/connections/self-hosted-broker.js';
import {
  createBrokerCredentialBundle,
  SelfHostedBrokerService,
  validateBrokerScope,
} from '../src-server/services/connections/self-hosted-broker-service.js';

const mode = process.argv[2];
const configPath = process.argv[3];
if (!['init', 'serve'].includes(mode ?? ''))
  throw new Error(
    'Usage: station-self-hosted-broker <init|serve> /absolute/private-config.json',
  );
if (!configPath || !isAbsolute(configPath))
  throw new Error(
    'Usage: station-self-hosted-broker <init|serve> /absolute/private-config.json',
  );
const configInfo = lstatSync(configPath);
if (
  !configInfo.isFile() ||
  configInfo.isSymbolicLink() ||
  configInfo.uid !== process.getuid?.() ||
  (configInfo.mode & 0o077) !== 0 ||
  configInfo.size > 128 * 1024
)
  throw new Error('Broker config must be a private bounded file');
const bytes = readFileSync(configPath);
if (bytes.length > 128 * 1024) throw new Error('Broker config exceeds 128 KiB');
const input: unknown = JSON.parse(bytes.toString('utf8'));
if (!input || typeof input !== 'object' || Array.isArray(input))
  throw new Error('Invalid broker config');
const config = input as Record<string, unknown>;
if (
  Object.keys(config).sort().join(',') !==
    'credentialsPath,databasePath,port,provision,version' ||
  config.version !== 'station-self-hosted-broker/v1' ||
  !isAbsolute(String(config.databasePath)) ||
  !isAbsolute(String(config.credentialsPath)) ||
  !Number.isInteger(config.port) ||
  (config.port as number) < 0 ||
  (config.port as number) > 65535 ||
  config.port === 3000 ||
  config.port === 3141 ||
  !Array.isArray(config.provision)
)
  throw new Error('Invalid broker config');
if (mode === 'init') {
  if (config.provision.length !== 1)
    throw new Error('Broker init provisions exactly one generation');
  const scope = validateBrokerScope(config.provision[0]);
  const bundle = createBrokerCredentialBundle();
  const record = {
    version: 'station-self-hosted-broker-credentials/v1',
    scope,
    bundle,
  };
  const committed = await mutateJsonFileWithGuardedRead<typeof record | null>(
    String(config.credentialsPath),
    null,
    async () => {
      const info = lstatSync(String(config.credentialsPath));
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0
      )
        throw new Error('Existing broker credentials are not private');
      return readJsonFile<typeof record>(
        String(config.credentialsPath),
        record,
        { maxBytes: 128 * 1024, label: 'Broker credentials' },
      );
    },
    (prior) => {
      if (prior === null) return record;
      const credential = (value: unknown) => {
        const candidate = value as Record<string, unknown>;
        return Boolean(
          value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).sort().join(',') === 'id,secret' &&
            /^[A-Za-z0-9_-]{22}$/.test(String(candidate.id)) &&
            /^[A-Za-z0-9_-]{43}$/.test(String(candidate.secret)),
        );
      };
      if (
        !prior ||
        typeof prior !== 'object' ||
        Object.keys(prior).sort().join(',') !== 'bundle,scope,version' ||
        prior.version !== record.version ||
        JSON.stringify(prior.scope) !== JSON.stringify(scope) ||
        !prior.bundle ||
        Object.keys(prior.bundle).sort().join(',') !== 'connector,routing' ||
        !credential(prior.bundle.connector) ||
        !credential(prior.bundle.routing)
      )
        throw new Error('Existing broker credentials name another operation');
      return prior;
    },
    { maxBytes: 128 * 1024, label: 'Broker credentials' },
  );
  if (!committed) throw new Error('Broker credential publication failed');
  const service = new SelfHostedBrokerService(String(config.databasePath));
  try {
    service.provision(scope, 60_000, committed.bundle);
  } catch (error) {
    service.close();
    throw error;
  }
  service.close();
  process.exit(0);
}
if (config.provision.length !== 0)
  throw new Error('Broker serve does not provision credentials');
const app = new Hono();
const service = new SelfHostedBrokerService(String(config.databasePath));
app.route('/broker/v1', createSelfHostedBrokerRoutes(service));
const server = serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port: config.port as number,
});
server.once('listening', () => {
  const address = server.address();
  if (address && typeof address !== 'string')
    process.stdout.write(
      `STATION_SELF_HOSTED_BROKER ${JSON.stringify({ host: '127.0.0.1', port: address.port })}\n`,
    );
});
const stop = () =>
  server.close(() => {
    service.close();
    process.exitCode = 0;
  });
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
