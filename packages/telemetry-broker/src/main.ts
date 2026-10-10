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
  constants.O_RDONLY | constants.O_NOFOLLOW,
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
  operatorKey = (await secretFile.readFile('utf8')).trim();
} finally {
  await secretFile.close();
}
const port = Number(process.env.STATION_TELEMETRY_BROKER_PORT ?? '43891');
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid telemetry receiver port');
const pool = new Pool({
  connectionString: databaseUrl,
  max: 4,
  connectionTimeoutMillis: 1500,
  statement_timeout: 3000,
});
const store = new PgProductRepository(pool);
await store.migrate();
await store.retain();
const app = createProductBroker(store, operatorKey);
const server = createServer(getRequestListener(app.fetch));
server.listen(port, process.env.STATION_TELEMETRY_BROKER_HOST ?? '127.0.0.1');
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
  server.close(() => {
    void pool.end();
  });
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.stdout.write(`Telemetry product receiver listening on port ${port}\n`);
