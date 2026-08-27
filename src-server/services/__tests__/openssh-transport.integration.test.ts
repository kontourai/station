import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { encodeDevicePairingPayload } from '@kontourai/station-connect';
import {
  DEVICE_PAIRING_PROTOCOL_VERSION,
  DEVICE_PAIRING_SCOPE,
} from '@kontourai/station-contracts';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { SshEnvironmentService } from '../ssh/ssh-environment-service.js';
import {
  type HermeticOpenSshFixture,
  startHermeticOpenSshFixture,
} from './helpers/hermetic-openssh.js';

async function listenOnLoopback(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  return {
    port,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function reserveReleasedPort(): Promise<number> {
  const reservation = await listenOnLoopback();
  await reservation.close();
  return reservation.port;
}

function readWebSocket(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('WebSocket fixture timed out'));
    }, 5_000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      socket.close();
      resolve(JSON.parse(data.toString()));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe.sequential('hermetic system OpenSSH transport', () => {
  let fixture: HermeticOpenSshFixture;

  beforeAll(async () => {
    fixture = await startHermeticOpenSshFixture();
  }, 30_000);

  afterAll(async () => {
    await fixture?.close();
  });

  test('crosses ProxyJump and a collision-safe loopback forward for Station protocols', async () => {
    const collision = await listenOnLoopback();
    const fallbackPort = await reserveReleasedPort();
    const states: unknown[] = [];
    const adapter = fixture.createAdapter({
      trust: 'trusted',
      reservePorts: [collision.port, fallbackPort],
    });
    const tunnel = adapter.createTunnel({
      alias: fixture.targetAlias,
      remotePort: fixture.remotePort,
      connectTimeoutMs: 10_000,
      onStateChange: (state) => states.push(state),
    });

    try {
      const connected = await tunnel.start();
      expect(connected).toMatchObject({
        phase: 'connected',
        localUrl: `http://127.0.0.1:${fallbackPort}`,
        host: { proxyJump: fixture.jumpAlias },
      });
      expect(states).toContainEqual({ phase: 'starting', attempt: 2 });

      await expect(
        tunnel.probeWorker(fixture.remoteProjectPath),
      ).resolves.toMatchObject({
        protocolVersion: 1,
        remoteProjectPath: fixture.remoteProjectPath,
        environmentId: fixture.environmentId,
      });

      const base = `http://127.0.0.1:${fallbackPort}`;
      await expect(
        fetch(`${base}/api/system/status`).then((value) => value.json()),
      ).resolves.toEqual({
        ready: true,
        fixture: 'http',
      });
      await expect(
        fetch(`${base}/api/files?path=fixture.ts`).then((value) =>
          value.json(),
        ),
      ).resolves.toEqual({
        path: 'fixture.ts',
        content: 'export const transported = true;\n',
      });
      await expect(
        fetch(`${base}/api/events`).then((value) => value.text()),
      ).resolves.toContain('event: station.fixture');
      await expect(
        fetch(`${base}/api/orchestration/sessions`, { method: 'POST' }).then(
          (value) => value.json(),
        ),
      ).resolves.toEqual({ sessionId: 'fixture-session', status: 'running' });
      await expect(
        readWebSocket(`ws://127.0.0.1:${fallbackPort}/terminal`),
      ).resolves.toEqual({
        channel: 'terminal',
        data: 'fixture-shell',
      });
      await expect(
        readWebSocket(`ws://127.0.0.1:${fallbackPort}/api/orchestration/ws`),
      ).resolves.toEqual({ channel: 'runtime-session', status: 'streaming' });

      expect(fixture.jumpForwardRequests).toContainEqual({
        destination: '127.0.0.1',
        port: fixture.targetSshPort,
      });
      expect(fixture.targetForwardRequests).toContainEqual({
        destination: '127.0.0.1',
        port: fixture.remotePort,
      });
      const serializedStates = JSON.stringify(states);
      for (const secret of fixture.secretMaterial) {
        expect(serializedStates).not.toContain(secret);
      }
    } finally {
      await tunnel.stop();
      await collision.close();
    }
  }, 30_000);

  test('maps first-connect and changed-key failures to bounded recovery states', async () => {
    const firstConnectStates: unknown[] = [];
    const firstConnect = fixture
      .createAdapter({ trust: 'missing' })
      .createTunnel({
        alias: fixture.targetAlias,
        remotePort: fixture.remotePort,
        connectTimeoutMs: 5_000,
        onStateChange: (state) => firstConnectStates.push(state),
      });
    await expect(firstConnect.start()).resolves.toEqual({
      phase: 'host-key',
      reason: 'confirmation-required',
    });

    const changedStates: unknown[] = [];
    const changed = fixture.createAdapter({ trust: 'changed' }).createTunnel({
      alias: fixture.targetAlias,
      remotePort: fixture.remotePort,
      connectTimeoutMs: 5_000,
      onStateChange: (state) => changedStates.push(state),
    });
    await expect(changed.start()).resolves.toEqual({
      phase: 'host-key',
      reason: 'changed',
    });

    const diagnostics = JSON.stringify([firstConnectStates, changedStates]);
    for (const secret of fixture.secretMaterial) {
      expect(diagnostics).not.toContain(secret);
    }
  }, 20_000);

  test('binds identity and project, drops transport, and resumes without persisting secrets', async () => {
    const stationHome = join(fixture.directory, 'station-home');
    const service = new SshEnvironmentService(stationHome, {
      adapter: fixture.createAdapter({ trust: 'trusted' }),
    });
    await service.initialize();
    const added = await service.add({
      hostAlias: fixture.targetAlias,
      remoteProjectPath: fixture.remoteProjectPath,
      remotePort: fixture.remotePort,
    });

    const first = await service.connect(added.profile.id);
    expect(first.state, JSON.stringify(first.state)).toMatchObject({
      phase: 'connected',
    });
    expect(first.profile).toMatchObject({
      environmentId: fixture.environmentId,
      remoteHome: expect.stringMatching(/^\//),
      verifiedProjectPath: fixture.remoteProjectPath,
      workerProtocolVersion: 1,
    });

    fixture.dropTargetConnections();
    await vi.waitFor(() => {
      expect(service.get(added.profile.id)?.state).toMatchObject({
        phase: 'disconnected',
      });
    });
    const resumed = await service.connect(added.profile.id);
    expect(resumed.state).toMatchObject({ phase: 'connected' });
    expect(resumed.profile.environmentId).toBe(first.profile.environmentId);
    expect(resumed.profile.hostIdentity).toBe(first.profile.hostIdentity);

    const persisted = await readFile(
      join(stationHome, 'environments', 'ssh.json'),
      'utf8',
    );
    const pairingPayload = encodeDevicePairingPayload({
      protocolVersion: DEVICE_PAIRING_PROTOCOL_VERSION,
      environmentId: fixture.environmentId,
      offerId: 'hermetic-offer',
      challenge: 'hermetic-one-time-challenge',
      manualCode: 'HERMETIC1',
      endpoint:
        resumed.state.phase === 'connected' ? resumed.state.localUrl : '',
      scope: DEVICE_PAIRING_SCOPE,
      expiresAt: Date.now() + 60_000,
    });
    const exportedSurfaces = [
      persisted,
      JSON.stringify(resumed.profile),
      resumed.state.phase === 'connected' ? resumed.state.localUrl : '',
      pairingPayload,
    ].join('\n');
    expect(exportedSurfaces).not.toMatch(/https?:\/\/[^/]*@/);
    expect(persisted).not.toContain('127.0.0.1');
    for (const secret of fixture.secretMaterial) {
      expect(exportedSurfaces).not.toContain(secret);
    }
    await service.shutdown();
  }, 30_000);

  test('rejects an incompatible remote worker through the real encrypted transport', async () => {
    const stationHome = join(fixture.directory, 'incompatible-home');
    const service = new SshEnvironmentService(stationHome, {
      adapter: fixture.createAdapter({
        trust: 'trusted',
        workerNodeVersion: 'v22.0.0',
      }),
    });
    await service.initialize();
    const added = await service.add({
      hostAlias: fixture.targetAlias,
      remoteProjectPath: fixture.remoteProjectPath,
      remotePort: fixture.remotePort,
    });

    const rejected = await service.connect(added.profile.id);
    expect(rejected.state).toMatchObject({
      phase: 'error',
      reason: 'worker-incompatible',
      action: expect.stringContaining('Update Station and Node.js'),
    });
    await service.shutdown();
  }, 20_000);
});
