import { once } from 'node:events';
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, Socket } from 'node:net';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { EnvironmentSecurityService } from '../../src-server/services/ssh/environment-security-service.js';
import {
  installNativeFreshNodeNetworkGuard,
  loadNativeFreshFixturePlan,
  prepareNativeFreshFixture,
  readNativeFreshPrivateJson,
} from '../lib/native-fresh-relay-fixture.js';

const makeTempDir = trackTempDirs();
const revision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('fresh fixture prepares a genuine unpaired Station and refuses private-plan scope substitution or unsafe custody', async () => {
  const directory = join(makeTempDir('native-fresh-plan-'), 'run');
  const prepared = await prepareNativeFreshFixture(directory, revision);
  const path = join(directory, 'plan.json');
  expect(loadNativeFreshFixturePlan(path)).toEqual(prepared);
  const security = new EnvironmentSecurityService({
    homeDir: join(directory, 'home'),
  });
  await security.initialize();
  expect(security.devicePairing.listDevices()).toEqual([]);
  expect(prepared).not.toHaveProperty('credential');
  expect(prepared.stationTrust).not.toHaveProperty('privateKey');
  writeFileSync(
    path,
    JSON.stringify({
      ...prepared,
      scope: {
        ...prepared.scope,
        stationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    }),
  );
  expect(() => loadNativeFreshFixturePlan(path)).toThrow(
    'fixture_scope_mismatch',
  );
  writeFileSync(path, JSON.stringify(prepared));
  chmodSync(path, 0o644);
  expect(() => loadNativeFreshFixturePlan(path)).toThrow(
    'fixture_private_file_required',
  );
  chmodSync(path, 0o600);
  const linked = join(directory, 'linked.json');
  symlinkSync(path, linked);
  expect(() => readNativeFreshPrivateJson(linked)).toThrow(
    'fixture_private_file_required',
  );
  expect(
    JSON.parse(readFileSync(join(directory, 'operator.json'), 'utf8')),
  ).toHaveProperty('credential');
});

test('disposable native fixture network guard permits its real local listener and refuses foreign HTTPS, unowned local ports and Unix sockets', async () => {
  const directory = join(makeTempDir('native-fresh-network-'), 'run');
  const plan = await prepareNativeFreshFixture(directory, revision);
  const server = createServer((socket) => socket.end('fixed small text'));
  server.listen(plan.port, '127.0.0.1');
  await once(server, 'listening');
  const original = Socket.prototype.connect;
  try {
    installNativeFreshNodeNetworkGuard(plan);
    const client = createConnection({ host: '127.0.0.1', port: plan.port });
    const chunks: Buffer[] = [];
    client.on('data', (value) =>
      chunks.push(typeof value === 'string' ? Buffer.from(value) : value),
    );
    await once(client, 'end');
    expect(Buffer.concat(chunks).toString('utf8')).toBe('fixed small text');
    expect(() => createConnection({ host: 'example.com', port: 443 })).toThrow(
      'fixture_node_destination_refused',
    );
    expect(() =>
      createConnection({ host: 'relay-test.kontourai.com', port: 80 }),
    ).toThrow('fixture_node_destination_refused');
    expect(() =>
      createConnection({ host: '127.0.0.1', port: plan.port + 4 }),
    ).toThrow('fixture_node_destination_refused');
    expect(() =>
      createConnection({ path: '/private/tmp/native-fixture-unowned.sock' }),
    ).toThrow();
  } finally {
    Socket.prototype.connect = original;
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
});
