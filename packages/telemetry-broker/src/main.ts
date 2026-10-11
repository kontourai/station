import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Pool } from 'pg';
import { createProductBroker } from './app.js';
import { PgProductRepository } from './store.js';

const databaseUrl = process.env.STATION_TELEMETRY_BROKER_DATABASE_URL;
const operatorKeyFile = process.env.STATION_TELEMETRY_BROKER_OPERATOR_KEY_FILE;
if (!databaseUrl || !operatorKeyFile)
  throw new Error('Database and private operator-key file must be configured');
if (process.platform === 'win32')
  throw new Error(
    'The receiver secret-file profile requires a qualified Unix host',
  );
const secretFile = await open(
  operatorKeyFile,
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
);
let operatorKey: string;
try {
  const metadata = await secretFile.stat();
  if (
    !metadata.isFile() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size > 256
  )
    throw new Error(
      'Operator credential must be a private, owned regular file',
    );
  const bytes = Buffer.alloc(257);
  const { bytesRead } = await secretFile.read(bytes, 0, bytes.length, 0);
  if (bytesRead > 256) throw new Error('Operator credential file is too large');
  operatorKey = bytes.subarray(0, bytesRead).toString('utf8').trim();
} finally {
  await secretFile.close();
}
if (!/^sto_[A-Za-z0-9_-]{43}$/.test(operatorKey))
  throw new Error('A valid private operator credential is required');
const port = Number(process.env.STATION_TELEMETRY_BROKER_PORT ?? '43891');
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid telemetry receiver port');
const pool = new Pool({
  connectionString: databaseUrl,
  max: 4,
  connectionTimeoutMillis: 1500,
  statement_timeout: 3000,
  query_timeout: 3500,
  idle_in_transaction_session_timeout: 5000,
});
pool.on('error', () =>
  process.stderr.write('Telemetry database connection failed\n'),
);
const store = new PgProductRepository(pool);
await store.migrate();
await store.retain();
const app = createProductBroker(store, operatorKey);
const server = createServer(getRequestListener(app.fetch));
server.listen(port, process.env.STATION_TELEMETRY_BROKER_HOST ?? '127.0.0.1');
server.maxConnections = 64;
server.setTimeout(5000);
server.requestTimeout = 5000;
server.headersTimeout = 5000;
const retention = setInterval(() => {
  void store
    .retain()
    .catch(() =>
      process.stderr.write('Telemetry retention did not complete\n'),
    );
}, 3600000);
retention.unref();
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(retention);
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    process.exitCode = 1;
  }, 6000);
  deadline.unref();
  server.close(() => {
    void pool.end().finally(() => clearTimeout(deadline));
  });
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.stdout.write(`Telemetry product receiver listening on port ${port}\n`);
