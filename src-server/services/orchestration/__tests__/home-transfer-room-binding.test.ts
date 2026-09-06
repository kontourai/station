import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import type { RuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { PeerCredentialStore } from '../../peers/peer-credential-store.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import {
  createHomeTransferRoomBindingService,
  type HomeTransferRoomBindingServiceOptions,
} from '../home-transfer-room-binding.js';

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture(probe?: HomeTransferRoomBindingServiceOptions['probe']) {
  const root = mkdtempSync(join(tmpdir(), 'station-room-binding-'));
  roots.push(root);
  const security = new EnvironmentSecurityService({ homeDir: root });
  const controller = await security.initialize();
  const offer = security.devicePairing.createOffer({
    endpoint: 'https://controller.example.test',
    scope: 'home:transfer',
  });
  const request = security.devicePairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'controller participant',
  });
  security.devicePairing.confirmRequest(request.requestId, {
    kind: 'presented-credential',
  });
  const participant = security.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
  });
  const peers = new PeerCredentialStore(root);
  await peers.upsert({
    environmentId: 'remote-environment',
    apiBase: 'https://remote.example.test',
    scope: 'home:transfer',
    credential: 'remote-room-credential-0123456789abcdef',
    label: 'remote',
  });
  const databasePath = join(root, 'controller.sqlite');
  const open = () => {
    const database = new DatabaseSync(databasePath);
    databases.push(database);
    database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    return database;
  };
  const defaultProbe: HomeTransferRoomBindingServiceOptions['probe'] = async (
    peer,
    input,
  ) => ({
    schemaVersion: 'station.home-transfer-room-identity/v1',
    environmentId: peer.environmentId,
    pairedDeviceId: 'remote-paired-device',
    taskId: input.taskId,
    channelId: input.channelId,
    nonce: input.nonce,
    executionAuthorityTransferred: false,
    executionResumeAvailable: false,
  });
  const options = (database: DatabaseSync) => ({
    database,
    security,
    controllerEnvironmentId: controller.environmentId,
    peers,
    probe: probe ?? defaultProbe,
  });
  const operator: RuntimeAuthenticatedRequestPrincipal = {
    kind: 'credential',
    credential: controller.credential,
    authority: 'operator-credential',
    source: 'bearer',
  };
  const device: RuntimeAuthenticatedRequestPrincipal = {
    kind: 'credential',
    credential: participant.credential,
    authority: 'device-credential',
    deviceId: participant.device.id,
    source: 'bearer',
  };
  const input = {
    channelId: 'channel-one',
    controllerDeviceId: participant.device.id,
    remoteEnvironmentId: 'remote-environment',
    remoteTaskId: 'remote-task',
  };
  return {
    root,
    security,
    peers,
    open,
    options,
    operator,
    device,
    input,
    defaultProbe,
  };
}

describe('home transfer room binding', () => {
  test('enrolls idempotently and resolves after reopening file SQLite', async () => {
    const f = await fixture();
    const firstDatabase = f.open();
    const first = createHomeTransferRoomBindingService(
      f.options(firstDatabase),
    );
    const enrolled = await first.enroll(f.operator, f.input);
    expect(enrolled).toEqual({
      kind: 'bound',
      binding: expect.objectContaining({
        tenantId: `personal-controller:${f.security.devicePairing.environmentId()}`,
        controllerDeviceId: f.input.controllerDeviceId,
        remoteEnvironmentId: f.input.remoteEnvironmentId,
        remotePairedDeviceId: 'remote-paired-device',
      }),
    });
    expect(JSON.stringify(enrolled)).not.toContain('credential');
    const stored = firstDatabase
      .prepare('SELECT record_json FROM home_transfer_room_bindings')
      .get() as { record_json: string };
    expect(Buffer.byteLength(stored.record_json)).toBeLessThanOrEqual(8 * 1024);
    expect(stored.record_json).not.toContain(
      'remote-room-credential-0123456789abcdef',
    );
    expect(stored.record_json).not.toContain('https://remote.example.test');
    expect(await first.enroll(f.operator, f.input)).toEqual(enrolled);
    firstDatabase.close();
    databases.splice(databases.indexOf(firstDatabase), 1);

    const reopened = createHomeTransferRoomBindingService(f.options(f.open()));
    expect(
      await reopened.resolve(f.device, {
        channelId: f.input.channelId,
        controllerDeviceId: f.input.controllerDeviceId,
      }),
    ).toEqual(enrolled);
  });

  test('snapshots caller principal and scalar input before the probe await', async () => {
    let mutateCaller: (() => void) | undefined;
    const f = await fixture(async (peer, input) => {
      mutateCaller?.();
      return f.defaultProbe(peer, input);
    });
    const principal = { ...f.operator };
    const input = { ...f.input };
    mutateCaller = () => {
      Object.assign(principal, {
        credential: 'mutated-operator-credential',
        authority: 'device-credential',
      });
      Object.assign(input, {
        channelId: 'mutated-channel',
        controllerDeviceId: 'mutated-device',
        remoteEnvironmentId: 'mutated-environment',
        remoteTaskId: 'mutated-task',
      });
    };
    const service = createHomeTransferRoomBindingService(f.options(f.open()));
    expect(await service.enroll(principal, input)).toEqual({
      kind: 'bound',
      binding: expect.objectContaining({
        channelId: f.input.channelId,
        controllerDeviceId: f.input.controllerDeviceId,
        remoteEnvironmentId: f.input.remoteEnvironmentId,
        remoteTaskId: f.input.remoteTaskId,
      }),
    });
  });

  test.each([
    ['environmentId', 'wrong-environment'],
    ['taskId', 'wrong-task'],
    ['channelId', 'wrong-channel'],
    ['nonce', 'wrong-nonce'],
  ] as const)('rejects a probe with the wrong %s', async (field, wrong) => {
    const f = await fixture(async (peer, input) => ({
      schemaVersion: 'station.home-transfer-room-identity/v1',
      environmentId: peer.environmentId,
      pairedDeviceId: 'remote-paired-device',
      taskId: input.taskId,
      channelId: input.channelId,
      nonce: input.nonce,
      executionAuthorityTransferred: false,
      executionResumeAvailable: false,
      [field]: wrong,
    }));
    const service = createHomeTransferRoomBindingService(f.options(f.open()));
    expect(await service.enroll(f.operator, f.input)).toEqual({
      kind: 'conflict',
    });
  });

  test('rejects authority flags and an extra observation field', async () => {
    const f = await fixture(async (peer, input) => ({
      schemaVersion: 'station.home-transfer-room-identity/v1',
      environmentId: peer.environmentId,
      pairedDeviceId: 'remote-paired-device',
      taskId: input.taskId,
      channelId: input.channelId,
      nonce: input.nonce,
      executionAuthorityTransferred: true,
      executionResumeAvailable: false,
      credential: peer.credential,
    }));
    const service = createHomeTransferRoomBindingService(f.options(f.open()));
    expect(await service.enroll(f.operator, f.input)).toEqual({
      kind: 'conflict',
    });
  });

  test('prevents environment aliases and controller environment self-binding', async () => {
    const f = await fixture();
    const service = createHomeTransferRoomBindingService(f.options(f.open()));
    expect(await service.enroll(f.operator, f.input)).toMatchObject({
      kind: 'bound',
    });
    const secondOffer = f.security.devicePairing.createOffer({
      endpoint: 'https://controller.example.test',
      scope: 'home:transfer',
    });
    const secondRequest = f.security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: secondOffer.offerId,
      proof: secondOffer.challenge,
      deviceName: 'other participant',
    });
    f.security.devicePairing.confirmRequest(secondRequest.requestId, {
      kind: 'presented-credential',
    });
    const second = f.security.devicePairing.exchange({
      offerId: secondOffer.offerId,
      proof: secondOffer.challenge,
      requestId: secondRequest.requestId,
    });
    expect(
      await service.enroll(f.operator, {
        ...f.input,
        channelId: 'channel-two',
        controllerDeviceId: second.device.id,
      }),
    ).toEqual({ kind: 'conflict' });

    await f.peers.upsert({
      environmentId: f.security.devicePairing.environmentId(),
      apiBase: 'https://controller.example.test',
      scope: 'home:transfer',
      credential: 'controller-self-credential-0123456789abcdef',
    });
    expect(
      await service.enroll(f.operator, {
        ...f.input,
        channelId: 'self-channel',
        remoteEnvironmentId: f.security.devicePairing.environmentId(),
      }),
    ).toEqual({ kind: 'conflict' });
  });

  test('denies revoked participants and a replaced operator identity', async () => {
    const f = await fixture();
    const service = createHomeTransferRoomBindingService(f.options(f.open()));
    expect(await service.enroll(f.operator, f.input)).toMatchObject({
      kind: 'bound',
    });
    f.security.devicePairing.revokeDevice(
      f.input.controllerDeviceId,
      'operator-credential',
    );
    expect(
      await service.resolve(f.device, {
        channelId: f.input.channelId,
        controllerDeviceId: f.input.controllerDeviceId,
      }),
    ).toEqual({ kind: 'denied' });
    expect(
      await service.resolve(f.operator, {
        channelId: f.input.channelId,
        controllerDeviceId: f.input.controllerDeviceId,
      }),
    ).toEqual({ kind: 'denied' });
    await f.security.resetEnvironment();
    expect(
      await service.resolve(f.operator, {
        channelId: f.input.channelId,
        controllerDeviceId: f.input.controllerDeviceId,
      }),
    ).toEqual({ kind: 'denied' });
  });

  test('rejects peer credential changes during a probe and after enrollment', async () => {
    let mutate: (() => Promise<void>) | undefined;
    const f = await fixture(async (peer, input) => {
      await mutate?.();
      return f.defaultProbe(peer, input);
    });
    mutate = async () => {
      mutate = undefined;
      await f.peers.upsert({
        environmentId: f.input.remoteEnvironmentId,
        apiBase: 'https://remote.example.test',
        scope: 'home:transfer',
        credential: 'changed-room-credential-0123456789abcdef',
      });
    };
    const service = createHomeTransferRoomBindingService(f.options(f.open()));
    expect(await service.enroll(f.operator, f.input)).toEqual({
      kind: 'conflict',
    });

    await f.peers.upsert({
      environmentId: f.input.remoteEnvironmentId,
      apiBase: 'https://remote.example.test',
      scope: 'home:transfer',
      credential: 'stable-room-credential-0123456789abcdef',
    });
    expect(await service.enroll(f.operator, f.input)).toMatchObject({
      kind: 'bound',
    });
    await f.peers.upsert({
      environmentId: f.input.remoteEnvironmentId,
      apiBase: 'https://other.example.test',
      scope: 'home:transfer',
      credential: 'stable-room-credential-0123456789abcdef',
    });
    expect(
      await service.resolve(f.operator, {
        channelId: f.input.channelId,
        controllerDeviceId: f.input.controllerDeviceId,
      }),
    ).toEqual({ kind: 'conflict' });
  });

  test('rejects a peer removed while its identity probe is in flight', async () => {
    let remove: (() => Promise<void>) | undefined;
    const f = await fixture(async (peer, input) => {
      await remove?.();
      return f.defaultProbe(peer, input);
    });
    remove = async () => {
      remove = undefined;
      await f.peers.remove(f.input.remoteEnvironmentId);
    };
    const service = createHomeTransferRoomBindingService(f.options(f.open()));
    expect(await service.enroll(f.operator, f.input)).toEqual({
      kind: 'conflict',
    });
  });

  test('fails closed for corrupt and oversized persisted records', async () => {
    const f = await fixture();
    const database = f.open();
    const service = createHomeTransferRoomBindingService(f.options(database));
    expect(await service.enroll(f.operator, f.input)).toMatchObject({
      kind: 'bound',
    });
    database
      .prepare('UPDATE home_transfer_room_bindings SET remote_environment_id=?')
      .run('forged-column-environment');
    expect(
      await service.resolve(f.operator, {
        channelId: f.input.channelId,
        controllerDeviceId: f.input.controllerDeviceId,
      }),
    ).toEqual({ kind: 'unavailable' });
    database
      .prepare('UPDATE home_transfer_room_bindings SET remote_environment_id=?')
      .run(f.input.remoteEnvironmentId);
    database
      .prepare('UPDATE home_transfer_room_bindings SET record_json=?')
      .run(JSON.stringify({ tenantId: 'forged' }));
    expect(
      await service.resolve(f.operator, {
        channelId: f.input.channelId,
        controllerDeviceId: f.input.controllerDeviceId,
      }),
    ).toEqual({ kind: 'unavailable' });
    database
      .prepare('UPDATE home_transfer_room_bindings SET record_json=?')
      .run('x'.repeat(8 * 1024 + 1));
    expect(
      await service.resolve(f.operator, {
        channelId: f.input.channelId,
        controllerDeviceId: f.input.controllerDeviceId,
      }),
    ).toEqual({ kind: 'unavailable' });
  });

  test('allows only the operator or the same participant', async () => {
    const f = await fixture();
    const service = createHomeTransferRoomBindingService(f.options(f.open()));
    expect(await service.enroll(f.device, f.input)).toEqual({ kind: 'denied' });
    expect(await service.enroll(f.operator, f.input)).toMatchObject({
      kind: 'bound',
    });
    expect(
      await service.resolve(
        { ...f.device, deviceId: 'different-device' },
        {
          channelId: f.input.channelId,
          controllerDeviceId: f.input.controllerDeviceId,
        },
      ),
    ).toEqual({ kind: 'denied' });
  });
});
