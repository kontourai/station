import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  PAIRING_SCOPE_HOME_CONTROL,
  PAIRING_SCOPE_HOME_TRANSFER,
} from '@kontourai/station-contracts/environment-security';
import { afterEach, expect, test } from 'vitest';
import type { RuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import {
  createPlannedHomeControlSessionAuthority,
  type PlannedHomeControlResult,
} from '../planned-home-control-session-authority.js';
import {
  MAX_PLANNED_HOME_CONTROL_SESSIONS,
  type PlannedHomeControlSessionRecord,
} from '../planned-home-control-session-schema.js';
import { createSqlitePlannedHomeTransferStore } from '../planned-home-transfer-store.js';

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const REPLAY_SECRET = '9'.repeat(64);

function openInput(openId: string, replaySecret = REPLAY_SECRET) {
  return { openId, replaySecret };
}

afterEach(() => {
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

function stored<T>(result: PlannedHomeControlResult<T>): T {
  expect(result.kind).toBe('stored');
  if (result.kind !== 'stored') throw new Error('Missing stored result');
  return result.value;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-home-control-'));
  roots.push(root);
  const homeDir = join(root, 'controller-home');
  const centralDir = join(root, 'central');
  mkdirSync(centralDir);
  const databasePath = join(centralDir, 'authority.sqlite');
  const security = new EnvironmentSecurityService({ homeDir });
  const controller = await security.initialize();
  const openDatabase = () => {
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    databases.push(database);
    return database;
  };
  const database = openDatabase();
  const createAuthority = (nextDatabase = database, nextSecurity = security) =>
    createPlannedHomeControlSessionAuthority({
      database: nextDatabase,
      security: nextSecurity,
      controllerEnvironmentId: controller.environmentId,
    });
  const pair = (name: string, scope = PAIRING_SCOPE_HOME_TRANSFER) => {
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
  const promoteControl = <T extends ReturnType<typeof pair>>(paired: T): T => {
    security.devicePairing.setDeviceScope(
      paired.device.id,
      [PAIRING_SCOPE_HOME_TRANSFER, PAIRING_SCOPE_HOME_CONTROL],
      { kind: 'presented-credential' },
    );
    return paired;
  };
  const initializeOwner = (deviceId: string) => {
    const store = createSqlitePlannedHomeTransferStore(database);
    expect(
      store.initialize({
        tenantId: `personal-controller:${controller.environmentId}`,
        channelId: 'channel-a',
        homeRef: `paired:${deviceId}`,
        policyRevision: 'policy-1',
        revision: 0,
      }).kind,
    ).toBe('stored');
  };
  return {
    root,
    homeDir,
    databasePath,
    database,
    security,
    controller,
    operator: principal(controller.credential, 'operator-credential'),
    openDatabase,
    createAuthority,
    pair,
    promoteControl,
    initializeOwner,
  };
}

function homeFiles(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...homeFiles(path));
    else files.push(path);
  }
  return files;
}

test('home transfer alone cannot open control; fresh operator promotion can', async () => {
  const f = await fixture();
  const transferOnly = f.pair('Transfer only');
  const authority = f.createAuthority();
  expect(authority.open(transferOnly.principal, openInput('open-a')).kind).toBe(
    'denied',
  );

  f.promoteControl(transferOnly);
  const opened = stored(
    authority.open(transferOnly.principal, openInput('open-a')),
  );
  expect(opened.replayed).toBe(false);
  expect(opened.capability.token).toMatch(/^[a-f0-9]{64}$/);
  const row = f.database
    .prepare(
      'SELECT capability_digest,replay_secret_digest,record_json FROM planned_home_control_sessions',
    )
    .get() as {
    capability_digest: string;
    replay_secret_digest: string;
    record_json: string;
  };
  expect(row.capability_digest).not.toBe(opened.capability.token);
  expect(row.replay_secret_digest).not.toBe(REPLAY_SECRET);
  expect(row.record_json).not.toContain(opened.capability.token);
  expect(row.record_json).not.toContain(REPLAY_SECRET);
  for (const path of homeFiles(f.homeDir)) {
    expect(readFileSync(path).includes(opened.capability.token)).toBe(false);
  }
});

test('a legacy device missing grant provenance cannot authorize control', async () => {
  const f = await fixture();
  const home = f.promoteControl(f.pair('Home'));
  const registryPath = join(f.homeDir, 'security', 'paired-devices.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
    devices: Array<{ homeControlGrantRevision?: number }>;
  };
  delete registry.devices[0]!.homeControlGrantRevision;
  writeFileSync(registryPath, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
  const reloadedSecurity = new EnvironmentSecurityService({
    homeDir: f.homeDir,
  });
  await reloadedSecurity.initialize();
  const authority = f.createAuthority(f.database, reloadedSecurity);
  expect(authority.open(home.principal, openInput('open-a')).kind).toBe(
    'denied',
  );
});

test('identical open replays across instances and restart only with the exact capability', async () => {
  const f = await fixture();
  const home = f.promoteControl(f.pair('Home'));
  const first = f.createAuthority();
  const opened = stored(first.open(home.principal, openInput('open-a')));
  expect(
    first.open(home.principal, { openId: 'open-a' } as Parameters<
      typeof first.open
    >[1]).kind,
  ).toBe('conflict');
  expect(
    first.open(home.principal, openInput('open-a', '8'.repeat(64))).kind,
  ).toBe('conflict');
  const localReplay = stored(first.open(home.principal, openInput('open-a')));
  expect(localReplay).toEqual({ ...opened, replayed: true });

  const secondDatabase = f.openDatabase();
  const second = f.createAuthority(secondDatabase);
  expect(second.open(home.principal, openInput('open-a')).kind).toBe(
    'recovery-required',
  );
  expect(second.open(home.principal, openInput('different')).kind).toBe(
    'conflict',
  );
  expect(
    stored(
      second.open(home.principal, {
        openId: 'open-a',
        existingCapability: opened.capability,
      }),
    ),
  ).toEqual({ ...opened, replayed: true });

  secondDatabase.close();
  const restarted = f.createAuthority(f.openDatabase());
  expect(restarted.open(home.principal, openInput('open-a')).kind).toBe(
    'recovery-required',
  );
  expect(
    stored(
      restarted.open(home.principal, {
        openId: 'open-a',
        existingCapability: opened.capability,
      }),
    ).replayed,
  ).toBe(true);
});

test('open rejects accessor-shaped capability input without evaluating nested getters', async () => {
  const f = await fixture();
  const home = f.promoteControl(f.pair('Home'));
  const authority = f.createAuthority();
  let invoked = false;
  const capability = Object.defineProperty({}, 'token', {
    enumerable: true,
    get() {
      invoked = true;
      return 'a'.repeat(64);
    },
  });
  expect(
    authority.open(home.principal, {
      openId: 'open-a',
      existingCapability: capability,
    } as unknown as Parameters<typeof authority.open>[1]).kind,
  ).toBe('conflict');
  expect(
    authority.open(home.principal, {
      openId: 'open-a',
      existingCapability: undefined,
    } as unknown as Parameters<typeof authority.open>[1]).kind,
  ).toBe('conflict');
  expect(invoked).toBe(false);
});

test('bind fixes owner identity, composes local authority, and separates settled replay', async () => {
  const f = await fixture();
  const home = f.promoteControl(f.pair('Home'));
  f.initializeOwner(home.device.id);
  const authority = f.createAuthority();
  const capability = stored(
    authority.open(home.principal, openInput('open-a')),
  ).capability;
  const port = stored(
    authority.bind(capability, {
      channelId: 'channel-a',
      ownerRevision: 0,
      kind: 'room-write',
      requireSynchronousLocalAuthority: () => true,
    }),
  );
  const input = {
    admissionId: 'write-a',
    intentDigest: 'a'.repeat(64),
  };
  expect(port.begin(input).kind).toBe('begun');
  expect(port.finish({ ...input, receiptDigest: 'b'.repeat(64) }).kind).toBe(
    'stored',
  );
  const replay = port.begin(input);
  expect(replay.kind).toBe('settled');
  if (replay.kind === 'settled')
    expect(replay.value.receiptDigest).toBe('b'.repeat(64));

  const deniedPort = stored(
    authority.bind(capability, {
      channelId: 'channel-a',
      ownerRevision: 0,
      kind: 'room-write',
      requireSynchronousLocalAuthority: () => false,
    }),
  );
  expect(deniedPort.begin({ ...input, admissionId: 'write-denied' }).kind).toBe(
    'denied',
  );
  expect(
    authority.bind(capability, {
      channelId: 'channel-a',
      ownerRevision: 1,
      kind: 'room-write',
      requireSynchronousLocalAuthority: () => true,
    }).kind,
  ).toBe('conflict');
});

test('scope removal and revocation synchronously disable an existing session', async () => {
  const scopeFixture = await fixture();
  const scoped = scopeFixture.promoteControl(scopeFixture.pair('Scoped'));
  scopeFixture.initializeOwner(scoped.device.id);
  const scopeAuthority = scopeFixture.createAuthority();
  const scopeCapability = stored(
    scopeAuthority.open(scoped.principal, openInput('scope-open')),
  ).capability;
  scopeFixture.security.devicePairing.setDeviceScope(
    scoped.device.id,
    [PAIRING_SCOPE_HOME_TRANSFER],
    { kind: 'presented-credential' },
  );
  expect(
    scopeAuthority.bind(scopeCapability, {
      channelId: 'channel-a',
      ownerRevision: 0,
      kind: 'room-write',
      requireSynchronousLocalAuthority: () => true,
    }).kind,
  ).toBe('denied');
  scopeFixture.security.devicePairing.setDeviceScope(
    scoped.device.id,
    [PAIRING_SCOPE_HOME_TRANSFER, PAIRING_SCOPE_HOME_CONTROL],
    { kind: 'presented-credential' },
  );
  expect(
    scopeAuthority.bind(scopeCapability, {
      channelId: 'channel-a',
      ownerRevision: 0,
      kind: 'room-write',
      requireSynchronousLocalAuthority: () => true,
    }).kind,
  ).toBe('denied');
  expect(
    scopeAuthority.retire(scopeFixture.operator, {
      deviceId: scoped.device.id,
      expectedGeneration: scopeCapability.generation,
    }).kind,
  ).toBe('stored');
  expect(
    stored(scopeAuthority.open(scoped.principal, openInput('scope-reopened')))
      .capability.generation,
  ).toBe(scopeCapability.generation + 1);

  const revokeFixture = await fixture();
  const revoked = revokeFixture.promoteControl(revokeFixture.pair('Revoked'));
  revokeFixture.initializeOwner(revoked.device.id);
  const revokeAuthority = revokeFixture.createAuthority();
  const revokeCapability = stored(
    revokeAuthority.open(revoked.principal, openInput('revoke-open')),
  ).capability;
  revokeFixture.security.devicePairing.revokeDevice(
    revoked.device.id,
    'operator-credential',
  );
  expect(
    revokeAuthority.bind(revokeCapability, {
      channelId: 'channel-a',
      ownerRevision: 0,
      kind: 'room-write',
      requireSynchronousLocalAuthority: () => true,
    }).kind,
  ).toBe('denied');
});

test('scope revocation from the final local guard rolls admission persistence back', async () => {
  const f = await fixture();
  const home = f.promoteControl(f.pair('Home'));
  f.initializeOwner(home.device.id);
  const authority = f.createAuthority();
  const capability = stored(
    authority.open(home.principal, openInput('open-a')),
  ).capability;
  let checks = 0;
  const port = stored(
    authority.bind(capability, {
      channelId: 'channel-a',
      ownerRevision: 0,
      kind: 'room-write',
      requireSynchronousLocalAuthority: () => {
        checks += 1;
        if (checks === 3)
          f.security.devicePairing.setDeviceScope(
            home.device.id,
            [PAIRING_SCOPE_HOME_TRANSFER],
            { kind: 'presented-credential' },
          );
        return true;
      },
    }),
  );
  expect(
    port.begin({
      admissionId: 'revoked-before-commit',
      intentDigest: 'a'.repeat(64),
    }).kind,
  ).toBe('denied');
  expect(
    f.database
      .prepare('SELECT 1 FROM planned_home_admissions WHERE admission_id=?')
      .get('revoked-before-commit'),
  ).toBeUndefined();
});

test('retirement and admission serialize without replacing unresolved work', async () => {
  const f = await fixture();
  const home = f.promoteControl(f.pair('Home'));
  f.initializeOwner(home.device.id);
  const authority = f.createAuthority();
  const first = stored(
    authority.open(home.principal, openInput('open-a')),
  ).capability;
  const port = stored(
    authority.bind(first, {
      channelId: 'channel-a',
      ownerRevision: 0,
      kind: 'room-write',
      requireSynchronousLocalAuthority: () => true,
    }),
  );
  const admission = {
    admissionId: 'write-a',
    intentDigest: 'a'.repeat(64),
  };
  expect(port.begin(admission).kind).toBe('begun');
  expect(
    authority.retire(f.operator, {
      deviceId: home.device.id,
      expectedGeneration: first.generation,
    }).kind,
  ).toBe('admission-pending');
  expect(
    port.finish({ ...admission, receiptDigest: 'b'.repeat(64) }).kind,
  ).toBe('stored');
  expect(
    authority.retire(f.operator, {
      deviceId: home.device.id,
      expectedGeneration: first.generation,
    }).kind,
  ).toBe('stored');
  expect(authority.open(home.principal, openInput('open-a')).kind).toBe(
    'conflict',
  );
  expect(
    authority.open(home.principal, {
      openId: 'open-b',
      existingCapability: first,
    }).kind,
  ).toBe('conflict');

  const second = stored(
    authority.open(home.principal, openInput('open-b')),
  ).capability;
  expect(second.generation).toBe(first.generation + 1);
  expect(
    authority.bind(first, {
      channelId: 'channel-a',
      ownerRevision: 0,
      kind: 'room-write',
      requireSynchronousLocalAuthority: () => true,
    }).kind,
  ).toBe('denied');
  expect(
    authority.retire(f.operator, {
      deviceId: home.device.id,
      expectedGeneration: first.generation,
    }).kind,
  ).toBe('conflict');
});

test('a capability for another paired home is never accepted or ignored', async () => {
  const f = await fixture();
  const first = f.promoteControl(f.pair('First'));
  const second = f.promoteControl(f.pair('Second'));
  const authority = f.createAuthority();
  const firstCapability = stored(
    authority.open(first.principal, openInput('first-open')),
  ).capability;
  expect(
    authority.open(second.principal, {
      openId: 'second-open',
      existingCapability: firstCapability,
    }).kind,
  ).toBe('conflict');
  expect(
    stored(authority.open(second.principal, openInput('second-open')))
      .capability.homeRef,
  ).toBe(`paired:${second.device.id}`);
});

test('only the current operator can retire an exact generation', async () => {
  const f = await fixture();
  const home = f.promoteControl(f.pair('Home'));
  const authority = f.createAuthority();
  const capability = stored(
    authority.open(home.principal, openInput('open-a')),
  ).capability;
  expect(
    authority.retire(home.principal, {
      deviceId: home.device.id,
      expectedGeneration: capability.generation,
    }).kind,
  ).toBe('denied');
  expect(
    authority.retire(principal('wrong', 'operator-credential'), {
      deviceId: home.device.id,
      expectedGeneration: capability.generation,
    }).kind,
  ).toBe('denied');
  expect(
    authority.retire(f.operator, {
      deviceId: home.device.id,
      expectedGeneration: capability.generation + 1,
    }).kind,
  ).toBe('conflict');
});

test('operator inspection exposes review metadata without capability material', async () => {
  const f = await fixture();
  const home = f.promoteControl(f.pair('Home'));
  f.initializeOwner(home.device.id);
  const transferOnly = f.pair('Transfer only');
  const authority = f.createAuthority();
  const capability = stored(
    authority.open(home.principal, openInput('open-a')),
  ).capability;
  const port = stored(
    authority.bind(capability, {
      channelId: 'channel-a',
      ownerRevision: 0,
      kind: 'room-write',
      requireSynchronousLocalAuthority: () => true,
    }),
  );
  expect(
    port.begin({
      admissionId: 'write-a',
      intentDigest: 'a'.repeat(64),
    }).kind,
  ).toBe('begun');
  expect(
    authority.inspect(home.principal, { deviceId: home.device.id }).kind,
  ).toBe('denied');
  expect(
    authority.inspect(transferOnly.principal, { deviceId: home.device.id })
      .kind,
  ).toBe('denied');
  const inspection = stored(
    authority.inspect(f.operator, { deviceId: home.device.id }),
  );
  expect(inspection).toEqual({
    homeRef: `paired:${home.device.id}`,
    openId: 'open-a',
    generation: 1,
    state: 'active',
    unresolvedAdmissionCount: 1,
  });
  expect(inspection).not.toHaveProperty('token');
  expect(inspection).not.toHaveProperty('capabilityDigest');

  f.database.exec("UPDATE planned_home_admissions SET home_ref='paired:moved'");
  expect(authority.inspect(f.operator, { deviceId: home.device.id }).kind).toBe(
    'unavailable',
  );
});

test('whole-journal routing corruption fails unrelated sessions closed', async () => {
  const f = await fixture();
  const first = f.promoteControl(f.pair('First'));
  const second = f.promoteControl(f.pair('Second'));
  const authority = f.createAuthority();
  stored(authority.open(first.principal, openInput('first-open')));
  f.database.exec(
    "UPDATE planned_home_control_sessions SET home_ref='paired:moved'",
  );
  expect(authority.open(second.principal, openInput('second-open')).kind).toBe(
    'unavailable',
  );
  expect(
    authority.retire(f.operator, {
      deviceId: first.device.id,
      expectedGeneration: 1,
    }).kind,
  ).toBe('unavailable');
});

test('session journal capacity is bounded without expiry or deletion recovery', async () => {
  const f = await fixture();
  const home = f.promoteControl(f.pair('Home'));
  const authority = f.createAuthority();
  // Initialize the private schema without consuming one durable row.
  const clean = stored(authority.open(home.principal, openInput('clean')));
  expect(
    authority.retire(f.operator, {
      deviceId: home.device.id,
      expectedGeneration: clean.capability.generation,
    }).kind,
  ).toBe('stored');
  f.database.exec('DELETE FROM planned_home_control_sessions');
  const insert = f.database.prepare(
    'INSERT INTO planned_home_control_sessions VALUES(?,?,?,?,?,?,?,?,?,?)',
  );
  f.database.exec('BEGIN IMMEDIATE');
  try {
    for (
      let index = 0;
      index <= MAX_PLANNED_HOME_CONTROL_SESSIONS;
      index += 1
    ) {
      const record: PlannedHomeControlSessionRecord = {
        tenantId: `tenant-${index}`,
        homeRef: `paired:device-${index}`,
        pairedDeviceId: `device-${index}`,
        homeControlGrantRevision: 1,
        openId: `open-${index}`,
        generation: 1,
        state: 'retired',
        capabilityDigest: 'a'.repeat(64),
        replaySecretDigest: 'b'.repeat(64),
      };
      insert.run(
        record.tenantId,
        record.homeRef,
        record.pairedDeviceId,
        record.homeControlGrantRevision,
        record.openId,
        record.generation,
        record.state,
        record.capabilityDigest,
        record.replaySecretDigest,
        JSON.stringify(record),
      );
    }
    f.database.exec('COMMIT');
  } catch (error) {
    f.database.exec('ROLLBACK');
    throw error;
  }
  expect(authority.open(home.principal, openInput('over-cap')).kind).toBe(
    'unavailable',
  );
  const keys = Object.keys(
    JSON.parse(
      (
        f.database
          .prepare(
            'SELECT record_json FROM planned_home_control_sessions LIMIT 1',
          )
          .get() as { record_json: string }
      ).record_json,
    ),
  );
  expect(keys.some((key) => /time|expir|deadline|pid/i.test(key))).toBe(false);
});
