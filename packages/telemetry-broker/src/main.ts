import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Pool } from 'pg';
import { createProductBroker } from './app.js';
import { PgProductRepository } from './store.js';

let databaseUrl = process.env.STATION_TELEMETRY_BROKER_DATABASE_URL;
const databaseUrlFile = process.env.STATION_TELEMETRY_BROKER_DATABASE_URL_FILE;
const operatorKeyFile = process.env.STATION_TELEMETRY_BROKER_OPERATOR_KEY_FILE;
if ((!databaseUrl && !databaseUrlFile) || !operatorKeyFile)
  throw new Error('Database and private operator-key file must be configured');
if (databaseUrl && databaseUrlFile)
  throw new Error('Select one database credential source');
if (process.platform === 'win32')
  throw new Error(
    'The receiver secret-file profile requires a qualified Unix host',
  );
async function readPrivateCredential(
  file: string,
  limit: number,
): Promise<string> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > limit
    )
      throw new Error('Credential must be a private, owned regular file');
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error('Credential file is too large');
    return bytes.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await handle.close();
  }
}
const operatorKey = await readPrivateCredential(operatorKeyFile, 256);
if (!/^sto_[A-Za-z0-9_-]{43}$/.test(operatorKey))
  throw new Error('A valid private operator credential is required');
if (databaseUrlFile) {
  databaseUrl = await readPrivateCredential(databaseUrlFile, 4096);
  try {
    const address = new URL(databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(address.protocol) ||
      !address.hostname ||
      address.pathname.length < 2 ||
      address.hash
    )
      throw new Error();
  } catch {
    throw new Error('A valid PostgreSQL connection URL file is required');
  }
}
if (!databaseUrl) throw new Error('A database connection URL is required');
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
const app = createProductBroker(store, operatorKey);
const server = createServer(getRequestListener(app.fetch));
server.listen(port, process.env.STATION_TELEMETRY_BROKER_HOST ?? '127.0.0.1');
server.maxConnections = 64;
server.setTimeout(5000);
server.requestTimeout = 5000;
server.headersTimeout = 5000;
const credentialRefresh = setInterval(() => {
  void store
    .refreshCredentials()
    .catch(() =>
      process.stderr.write('Telemetry credential refresh did not complete\n'),
    );
}, 30_000);
credentialRefresh.unref();
const finalizeClosedDays = () => {
  void store.lite
    .finalize()
    .catch(() =>
      process.stderr.write('Telemetry finalization did not complete\n'),
    );
};
const finalization = setInterval(finalizeClosedDays, 3600000);
finalization.unref();
finalizeClosedDays();
const retainExpiredRows = () => {
  void store
    .retain()
    .catch(() =>
      process.stderr.write('Telemetry retention did not complete\n'),
    );
};
const retention = setInterval(retainExpiredRows, 3600000);
retention.unref();
retainExpiredRows();
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(retention);
  clearInterval(finalization);
  clearInterval(credentialRefresh);
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
