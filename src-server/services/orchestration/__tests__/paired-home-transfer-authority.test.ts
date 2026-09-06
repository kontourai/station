import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import type { RuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import {
  createPairedHomeTransferAuthority,
  type PairedHomeTransferAuthority,
} from '../paired-home-transfer-authority.js';

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function principal(
  credential: string,
  authority: 'operator-credential' | 'device-credential',
  deviceId?: string,
): RuntimeAuthenticatedRequestPrincipal {
  return {
    kind: 'credential',
    credential,
    authority,
    ...(deviceId ? { deviceId } : {}),
    source: 'bearer',
  };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-paired-home-authority-'));
  roots.push(root);
  const homeDir = join(root, 'controller-home');
  const databasePath = join(root, 'central', 'authority.sqlite');
  const security = new EnvironmentSecurityService({ homeDir });
  const controller = await security.initialize();
  const openDatabase = () => {
    const database = new DatabaseSync(databasePath);
    databases.push(database);
    return database;
  };
  const centralDir = join(root, 'central');
  mkdirSync(centralDir, { recursive: true });
  const database = openDatabase();
  const createAuthority = (
    nextSecurity = security,
    nextDatabase = database,
    controllerEnvironmentId = controller.environmentId,
  ) =>
    createPairedHomeTransferAuthority({
      database: nextDatabase,
      security: nextSecurity,
      controllerEnvironmentId,
    });
  const pair = (name: string, scope = 'home:transfer') => {
    const offer = security.devicePairing.createOffer({
      endpoint: 'https://controller.example.test',
      scope,
    });
    const request = security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
    });
    security.devicePairing.confirmRequest(request.requestId, {
      kind: 'presented-credential',
    });
    const exchanged = security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });
    return {
      ...exchanged,
      principal: principal(
        exchanged.credential,
        'device-credential',
        exchanged.device.id,
      ),
    };
  };
  return {
    root,
    homeDir,
    databasePath,
    security,
    controller,
    database,
    openDatabase,
    createAuthority,
    authority: createAuthority(),
    operator: principal(controller.credential, 'operator-credential'),
    pair,
  };
}

function initialize(
  authority: PairedHomeTransferAuthority,
  operator: RuntimeAuthenticatedRequestPrincipal,
  sourceDeviceId: string,
) {
  return authority.initializeOwner(operator, {
    channelId: 'channel-a',
    sourceDeviceId,
    policyRevision: 'policy-1',
  });
}

test('only the fresh operator enrolls an active transfer-scoped source and cannot replace it', async () => {
  const f = await fixture();
  const source = f.pair('Source');
  const replacement = f.pair('Replacement');
  expect(initialize(f.authority, source.principal, source.device.id).kind).toBe(
    'denied',
  );
  expect(
    initialize(
      f.authority,
      principal('wrong', 'operator-credential'),
      source.device.id,
    ).kind,
  ).toBe('denied');
  expect(initialize(f.authority, f.operator, source.device.id)).toMatchObject({
    kind: 'stored',
    value: {
      channelId: 'channel-a',
      homeRef: `paired:${source.device.id}`,
      policyRevision: 'policy-1',
      revision: 0,
    },
  });
  expect(initialize(f.authority, f.operator, source.device.id).kind).toBe(
    'stored',
  );
  expect(initialize(f.authority, f.operator, replacement.device.id).kind).toBe(
    'conflict',
  );
});

test('owner inspection and preparation are restricted to exact scoped paired participants', async () => {
  const f = await fixture();
  const source = f.pair('Source');
  const target = f.pair('Target');
  const stranger = f.pair('Stranger');
  const ordinary = f.pair('Ordinary', 'orchestration:read');
  initialize(f.authority, f.operator, source.device.id);

  expect(f.authority.inspect(source.principal, 'channel-a').kind).toBe(
    'stored',
  );
  expect(f.authority.inspect(target.principal, 'channel-a').kind).toBe(
    'denied',
  );
  expect(f.authority.inspect(ordinary.principal, 'channel-a').kind).toBe(
    'denied',
  );
  expect(
    f.authority.prepare(stranger.principal, {
      channelId: 'channel-a',
      operationId: 'foreign-source',
      targetDeviceId: target.device.id,
      policyRevision: 'policy-1',
      expectedRevision: 0,
    }).kind,
  ).toBe('denied');
  expect(
    f.authority.prepare(source.principal, {
      channelId: 'channel-a',
      operationId: 'unscoped-target',
      targetDeviceId: ordinary.device.id,
      policyRevision: 'policy-1',
      expectedRevision: 0,
    }).kind,
  ).toBe('denied');
  expect(
    f.authority.prepare(source.principal, {
      channelId: 'channel-a',
      operationId: 'same-device',
      targetDeviceId: source.device.id,
      policyRevision: 'policy-1',
      expectedRevision: 0,
    }).kind,
  ).toBe('denied');

  const prepared = f.authority.prepare(source.principal, {
    channelId: 'channel-a',
    operationId: 'move-a',
    targetDeviceId: target.device.id,
    policyRevision: 'policy-1',
    expectedRevision: 0,
  });
  expect(prepared).toMatchObject({
    kind: 'stored',
    value: {
      phase: 'prepared',
      intent: {
        channelId: 'channel-a',
        operationId: 'move-a',
        sourceHomeRef: `paired:${source.device.id}`,
        targetHomeRef: `paired:${target.device.id}`,
      },
    },
  });
  expect(f.authority.resolve(source.principal, 'move-a')).toEqual(prepared);
  expect(f.authority.resolve(target.principal, 'move-a')).toEqual(prepared);
  expect(f.authority.resolve(stranger.principal, 'move-a').kind).toBe('denied');
});

test('the request principal is copied before guarded work begins', async () => {
  const f = await fixture();
  const source = f.pair('Source');
  const target = f.pair('Target');
  initialize(f.authority, f.operator, source.device.id);
  const mutable = { ...source.principal };
  const originalList = f.security.devicePairing.listDevices.bind(
    f.security.devicePairing,
  );
  vi.spyOn(f.security.devicePairing, 'listDevices').mockImplementation(() => {
    mutable.credential = target.credential;
    mutable.deviceId = target.device.id;
    return originalList();
  });
  expect(
    f.authority.prepare(mutable, {
      channelId: 'channel-a',
      operationId: 'captured-principal',
      targetDeviceId: target.device.id,
      policyRevision: 'policy-1',
      expectedRevision: 0,
    }).kind,
  ).toBe('stored');
});

test('participant revocation during a guarded transaction rolls preparation back', async () => {
  const f = await fixture();
  const source = f.pair('Source');
  const target = f.pair('Target');
  initialize(f.authority, f.operator, source.device.id);
  const originalList = f.security.devicePairing.listDevices.bind(
    f.security.devicePairing,
  );
  let reads = 0;
  vi.spyOn(f.security.devicePairing, 'listDevices').mockImplementation(() => {
    reads += 1;
    const devices = originalList();
    if (reads === 5)
      f.security.devicePairing.revokeDevice(
        target.device.id,
        'operator-credential',
      );
    return devices;
  });
  const result = f.authority.prepare(source.principal, {
    channelId: 'channel-a',
    operationId: 'revoked-mid-transaction',
    targetDeviceId: target.device.id,
    policyRevision: 'policy-1',
    expectedRevision: 0,
  });
  expect(result.kind).toBe('denied');
  expect(
    f.authority.resolve(source.principal, 'revoked-mid-transaction').kind,
  ).toBe('not-found');
});

test('file-backed owner and prepared intent survive controller and database reopen', async () => {
  const f = await fixture();
  const source = f.pair('Source');
  const target = f.pair('Target');
  initialize(f.authority, f.operator, source.device.id);
  const prepared = f.authority.prepare(source.principal, {
    channelId: 'channel-a',
    operationId: 'move-a',
    targetDeviceId: target.device.id,
    policyRevision: 'policy-1',
    expectedRevision: 0,
  });
  f.database.close();
  const reopenedSecurity = new EnvironmentSecurityService({
    homeDir: f.homeDir,
  });
  await reopenedSecurity.initialize();
  const reopenedDatabase = f.openDatabase();
  const reopened = f.createAuthority(reopenedSecurity, reopenedDatabase);
  expect(reopened.inspect(source.principal, 'channel-a')).toMatchObject({
    kind: 'stored',
    value: { homeRef: `paired:${source.device.id}`, revision: 0 },
  });
  expect(reopened.resolve(target.principal, 'move-a')).toEqual(prepared);
});

test('a wrapper cannot be reused for another controller identity', async () => {
  const f = await fixture();
  const source = f.pair('Source');
  const otherRoot = mkdtempSync(join(tmpdir(), 'station-other-controller-'));
  roots.push(otherRoot);
  const otherSecurity = new EnvironmentSecurityService({ homeDir: otherRoot });
  await otherSecurity.initialize();
  const mismatched = f.createAuthority(otherSecurity);
  expect(initialize(mismatched, f.operator, source.device.id).kind).toBe(
    'denied',
  );
});
