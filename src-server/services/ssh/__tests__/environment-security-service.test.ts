import { createHmac } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const ENVIRONMENT_SECURITY_RECORD_RELATIVE_PATH = 'security/environment.json';

function revisionEvidenceKeyPath(
  homeDir: string,
  environmentId: string,
): string {
  return join(homeDir, 'security', `revision-evidence-${environmentId}.key`);
}

interface EnvironmentSecuritySnapshot {
  schemaVersion: 1;
  environmentId: string;
  credential: string;
}

interface EnvironmentSecurityServiceInstance {
  initialize(): Promise<EnvironmentSecuritySnapshot>;
  rotateCredential(): Promise<EnvironmentSecuritySnapshot>;
  resetEnvironment(): Promise<EnvironmentSecuritySnapshot>;
  verifyCredential(candidate: string): boolean;
  pseudonymizePairingAuditSource(source: string): string;
  signRevisionEvidenceAuthorityBinding(binding: string): string;
  identifyDevice(candidate: string): { id: string; name: string } | null;
  authorizeCredential(
    candidate: string,
    request: {
      method: string;
      path: string;
      activity?: { lastSeenFrom?: 'loopback' | 'lan' | 'tailnet' };
    },
  ): boolean;
  readonly devicePairing: {
    setDeviceApprovalAuthority(
      deviceId: string,
      granted: boolean,
      approval: { kind: string },
    ): { id: string; scope: string };
    createOffer(input: { endpoint: string }): {
      offerId: string;
      challenge: string;
    };
    requestPairing(input: {
      offerId: string;
      proof: string;
      deviceName: string;
    }): { requestId: string };
    confirmRequest(
      requestId: string,
      approval: { kind: 'presented-credential' | 'unauthenticated' },
    ): unknown;
    exchange(input: { offerId: string; proof: string; requestId: string }): {
      device: { id: string };
      credential: string;
    };
    identifyDevice(candidate: string): {
      usageCount: number | null;
      lastSeenFrom: string | null;
    } | null;
    revokeDevice(deviceId: string, actor: 'operator-credential'): unknown;
  };
}

interface EnvironmentSecurityServiceConstructor {
  new (options: {
    homeDir: string;
    hostname?: string;
    port?: number;
    lockRetryMs?: number;
    lockTimeoutMs?: number;
    staleLockAgeMs?: number;
    isProcessAlive?: (pid: number) => boolean;
    hostIdentity?: string;
  }): EnvironmentSecurityServiceInstance;
}

async function loadEnvironmentSecurityService(): Promise<EnvironmentSecurityServiceConstructor> {
  const modulePath = '../environment-security-service.js';
  try {
    const module = (await import(/* @vite-ignore */ modulePath)) as {
      EnvironmentSecurityService?: EnvironmentSecurityServiceConstructor;
    };
    if (module.EnvironmentSecurityService)
      return module.EnvironmentSecurityService;
  } catch {
    // The RED suite deliberately executes before the service exists.
  }
  throw new Error(
    'EnvironmentSecurityService is not implemented; identity persistence behavior is RED',
  );
}

const testHomes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'station-environment-security-'));
  testHomes.push(home);
  return home;
}

function writeLock(
  homeDir: string,
  overrides: Partial<{
    pid: number;
    nonce: string;
    createdAt: number;
    host: string;
  }> = {},
): string {
  const lockPath = join(homeDir, 'security/.environment.lock');
  const old = Date.now() - 10_000;
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 999_999,
      nonce: '661e12df-a948-4adb-9b44-c993d616c5a5',
      createdAt: old,
      host: 'test-host',
      ...overrides,
    }),
  );
  chmodSync(lockPath, 0o600);
  utimesSync(lockPath, old / 1_000, old / 1_000);
  return lockPath;
}

afterEach(() => {
  for (const home of testHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('EnvironmentSecurityService', () => {
  test('atomically creates one high-entropy identity and credential record', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const service = new EnvironmentSecurityService({ homeDir });

    const snapshot = await service.initialize();
    const stored = JSON.parse(
      readFileSync(
        join(homeDir, ENVIRONMENT_SECURITY_RECORD_RELATIVE_PATH),
        'utf8',
      ),
    );

    expect(snapshot.environmentId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(snapshot.credential).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(Buffer.from(snapshot.credential, 'base64url')).toHaveLength(32);
    expect(stored).toEqual(snapshot);
    expect(Object.keys(stored).sort()).toEqual([
      'credential',
      'environmentId',
      'schemaVersion',
    ]);
  });

  test('reload is stable across endpoint and process-lifetime inputs', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const first = await new EnvironmentSecurityService({
      homeDir,
      hostname: '127.0.0.1',
      port: 3000,
    }).initialize();
    const reloaded = await new EnvironmentSecurityService({
      homeDir,
      hostname: 'station.example.test',
      port: 9443,
    }).initialize();

    expect(reloaded).toEqual(first);
  });

  test('derives stable keyed pairing-audit source pseudonyms without persisting a new secret', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const first = new EnvironmentSecurityService({ homeDir });
    await first.initialize();
    const source = '198.51.100.44';
    const firstId = first.pseudonymizePairingAuditSource(source);
    const reloadedId = new EnvironmentSecurityService({
      homeDir,
    }).pseudonymizePairingAuditSource(source);

    expect(firstId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(reloadedId).toBe(firstId);
    expect(firstId).not.toContain(source);
    expect(
      Object.keys(
        JSON.parse(
          readFileSync(
            join(homeDir, ENVIRONMENT_SECURITY_RECORD_RELATIVE_PATH),
            'utf8',
          ),
        ),
      ).sort(),
    ).toEqual(['credential', 'environmentId', 'schemaVersion']);
  });

  test('keeps revision authority signatures stable across credential rotation and restart while separating forged content', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const first = new EnvironmentSecurityService({ homeDir });
    const initial = await first.initialize();
    const binding = '{"revisionId":"revision-1","scope":"task-1"}';
    const signature = first.signRevisionEvidenceAuthorityBinding(binding);
    const credentialForgery = createHmac(
      'sha256',
      Buffer.from(initial.credential, 'base64url'),
    )
      .update('station.revision-evidence.authority.v1\0')
      .update(binding)
      .digest('base64url');
    const keyPath = revisionEvidenceKeyPath(homeDir, initial.environmentId);
    const keyBeforeRotation = readFileSync(keyPath, 'utf8');

    expect(credentialForgery).not.toBe(signature);

    const rotated = await first.rotateCredential();
    expect(rotated.environmentId).toBe(initial.environmentId);
    expect(rotated.credential).not.toBe(initial.credential);
    expect(readFileSync(keyPath, 'utf8')).toBe(keyBeforeRotation);
    expect(first.signRevisionEvidenceAuthorityBinding(binding)).toBe(signature);

    const restarted = new EnvironmentSecurityService({ homeDir });
    await restarted.initialize();
    expect(restarted.signRevisionEvidenceAuthorityBinding(binding)).toBe(
      signature,
    );
    expect(
      restarted.signRevisionEvidenceAuthorityBinding(`${binding} forged`),
    ).not.toBe(signature);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('restricts its owned directory and record to operator-only modes', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const snapshot = await new EnvironmentSecurityService({
      homeDir,
    }).initialize();
    const recordPath = join(homeDir, ENVIRONMENT_SECURITY_RECORD_RELATIVE_PATH);
    const revisionKeyPath = revisionEvidenceKeyPath(
      homeDir,
      snapshot.environmentId,
    );

    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(recordPath, '..')).mode & 0o777).toBe(0o700);
    expect(statSync(revisionKeyPath).mode & 0o777).toBe(0o600);
    const revisionKey = readFileSync(revisionKeyPath, 'utf8');
    expect(revisionKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(revisionKey, 'base64url')).toHaveLength(32);
  });

  test('fails closed without replacing a corrupt or unsafe revision authority key', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const service = new EnvironmentSecurityService({ homeDir });
    const snapshot = await service.initialize();
    const keyPath = revisionEvidenceKeyPath(homeDir, snapshot.environmentId);

    writeFileSync(keyPath, 'corrupt');
    expect(() =>
      service.signRevisionEvidenceAuthorityBinding('binding'),
    ).toThrow(/invalid.*revision.*key/i);
    expect(readFileSync(keyPath, 'utf8')).toBe('corrupt');
    await expect(
      new EnvironmentSecurityService({ homeDir }).initialize(),
    ).rejects.toThrow(/invalid.*revision.*key/i);
    expect(readFileSync(keyPath, 'utf8')).toBe('corrupt');

    writeFileSync(keyPath, Buffer.alloc(32, 7).toString('base64url'));
    chmodSync(keyPath, 0o644);
    expect(() =>
      service.signRevisionEvidenceAuthorityBinding('binding'),
    ).toThrow(/unsafe.*revision.*key/i);
    expect(statSync(keyPath).mode & 0o777).toBe(0o644);
  });

  test('fails closed on a corrupt existing record without replacing it', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    await new EnvironmentSecurityService({ homeDir }).initialize();
    const recordPath = join(homeDir, ENVIRONMENT_SECURITY_RECORD_RELATIVE_PATH);
    writeFileSync(recordPath, '{"schemaVersion":1,"environmentId":"leaked"}');

    await expect(
      new EnvironmentSecurityService({ homeDir }).initialize(),
    ).rejects.toThrow(/invalid|corrupt|credential/i);
    expect(readFileSync(recordPath, 'utf8')).toBe(
      '{"schemaVersion":1,"environmentId":"leaked"}',
    );
  });

  test('credential rotation preserves identity while reset rotates identity and revision authority', async () => {
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const homeDir = makeHome();
    const service = new EnvironmentSecurityService({ homeDir });
    const initial = await service.initialize();
    const binding = '{"revisionId":"revision-1"}';
    const initialSignature =
      service.signRevisionEvidenceAuthorityBinding(binding);
    const initialKeyPath = revisionEvidenceKeyPath(
      homeDir,
      initial.environmentId,
    );
    const initialKey = readFileSync(initialKeyPath, 'utf8');
    const rotated = await service.rotateCredential();

    expect(rotated.environmentId).toBe(initial.environmentId);
    expect(rotated.credential).not.toBe(initial.credential);
    expect(readFileSync(initialKeyPath, 'utf8')).toBe(initialKey);
    expect(service.signRevisionEvidenceAuthorityBinding(binding)).toBe(
      initialSignature,
    );

    const reset = await service.resetEnvironment();
    expect(reset.environmentId).not.toBe(initial.environmentId);
    expect(reset.credential).not.toBe(rotated.credential);
    expect(() => statSync(initialKeyPath)).toThrow();
    const resetKeyPath = revisionEvidenceKeyPath(homeDir, reset.environmentId);
    expect(readFileSync(resetKeyPath, 'utf8')).not.toBe(initialKey);
    const resetSignature =
      service.signRevisionEvidenceAuthorityBinding(binding);
    expect(resetSignature).not.toBe(initialSignature);

    const restarted = new EnvironmentSecurityService({ homeDir });
    await restarted.initialize();
    expect(restarted.signRevisionEvidenceAuthorityBinding(binding)).toBe(
      resetSignature,
    );
  });

  test('verifies the complete credential without ordinary string equality semantics', async () => {
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const service = new EnvironmentSecurityService({ homeDir: makeHome() });
    const snapshot = await service.initialize();

    expect(service.verifyCredential(snapshot.credential)).toBe(true);
    expect(service.verifyCredential(`${snapshot.credential}x`)).toBe(false);
    expect(service.verifyCredential('')).toBe(false);
  });

  test('identifyDevice passes through to the paired-device registry and never resolves the operator credential', async () => {
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const service = new EnvironmentSecurityService({ homeDir: makeHome() });
    const snapshot = await service.initialize();

    // The operator credential verifies (loopback/master auth), but it is
    // never a device — this is exactly the distinction Web Push subscribe
    // routes rely on to reject operator-only callers.
    expect(service.verifyCredential(snapshot.credential)).toBe(true);
    expect(service.identifyDevice(snapshot.credential)).toBeNull();
    expect(service.identifyDevice('unknown-credential')).toBeNull();

    const offer = service.devicePairing.createOffer({
      endpoint: 'https://station.example.test',
    });
    const request = service.devicePairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Brian phone',
    });
    service.devicePairing.confirmRequest(request.requestId, {
      kind: 'presented-credential',
    });
    const exchanged = service.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });

    expect(service.identifyDevice(exchanged.credential)).toMatchObject({
      id: exchanged.device.id,
      name: 'Brian phone',
    });

    // Runtime authentication supplies a coarse server-derived peer class;
    // the service records it only for a paired credential, never for the
    // operator credential that is deliberately not a device record.
    expect(
      service.authorizeCredential(exchanged.credential, {
        method: 'GET',
        path: '/api/projects',
        activity: { lastSeenFrom: 'lan' },
      }),
    ).toBe(true);
    expect(service.identifyDevice(exchanged.credential)).toMatchObject({
      usageCount: 1,
      lastSeenFrom: 'lan',
      lastActiveDay: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(
      service.authorizeCredential(snapshot.credential, {
        method: 'GET',
        path: '/api/projects',
        activity: { lastSeenFrom: 'tailnet' },
      }),
    ).toBe(true);
    expect(service.identifyDevice(snapshot.credential)).toBeNull();

    service.devicePairing.revokeDevice(
      exchanged.device.id,
      'operator-credential',
    );
    expect(service.identifyDevice(exchanged.credential)).toBeNull();
  });

  test('rejects a valid-looking record with unexpected schema keys', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const service = new EnvironmentSecurityService({ homeDir });
    const snapshot = await service.initialize();
    const recordPath = join(homeDir, ENVIRONMENT_SECURITY_RECORD_RELATIVE_PATH);
    writeFileSync(
      recordPath,
      JSON.stringify({ ...snapshot, endpoint: 'https://secret-host.test' }),
    );

    await expect(service.initialize()).rejects.toThrow(/schema|invalid/i);
    expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toHaveProperty(
      'endpoint',
    );
  });

  test('concurrent first use converges on one complete record', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const snapshots = await Promise.all(
      Array.from({ length: 12 }, () =>
        new EnvironmentSecurityService({ homeDir }).initialize(),
      ),
    );

    expect(
      new Set(snapshots.map(({ environmentId }) => environmentId)),
    ).toEqual(new Set([snapshots[0].environmentId]));
    expect(new Set(snapshots.map(({ credential }) => credential))).toEqual(
      new Set([snapshots[0].credential]),
    );
    expect(() =>
      JSON.parse(
        readFileSync(
          join(homeDir, ENVIRONMENT_SECURITY_RECORD_RELATIVE_PATH),
          'utf8',
        ),
      ),
    ).not.toThrow();
  });

  test('recovers an aged crash lock only after proving its owner is dead', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const initial = await new EnvironmentSecurityService({
      homeDir,
    }).initialize();
    writeLock(homeDir);

    const recovered = await new EnvironmentSecurityService({
      homeDir,
      staleLockAgeMs: 1,
      hostIdentity: 'test-host',
      isProcessAlive: () => false,
    }).initialize();

    expect(recovered).toEqual(initial);
    expect(() =>
      statSync(join(homeDir, 'security/.environment.lock')),
    ).toThrow();
  });

  test('normalizes a complete lock whose atomic publication was interrupted', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const initial = await new EnvironmentSecurityService({
      homeDir,
    }).initialize();
    const nonce = '661e12df-a948-4adb-9b44-c993d616c5a5';
    const lockPath = writeLock(homeDir, { nonce });
    linkSync(
      lockPath,
      join(homeDir, `security/.environment.lock.candidate.${nonce}`),
    );

    const recovered = await new EnvironmentSecurityService({
      homeDir,
      staleLockAgeMs: 1,
      hostIdentity: 'test-host',
      isProcessAlive: () => false,
    }).initialize();

    expect(recovered).toEqual(initial);
    expect(() => statSync(lockPath)).toThrow();
  });

  test('never steals an aged lock from a live or PID-reused owner', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const initial = await new EnvironmentSecurityService({
      homeDir,
    }).initialize();
    const lockPath = writeLock(homeDir, { pid: process.pid });
    const originalLock = readFileSync(lockPath, 'utf8');

    await expect(
      new EnvironmentSecurityService({
        homeDir,
        lockRetryMs: 2,
        lockTimeoutMs: 15,
        staleLockAgeMs: 1,
        hostIdentity: 'test-host',
        isProcessAlive: () => true,
      }).initialize(),
    ).rejects.toThrow(/timed out/i);

    expect(readFileSync(lockPath, 'utf8')).toBe(originalLock);
    expect(
      JSON.parse(
        readFileSync(
          join(homeDir, ENVIRONMENT_SECURITY_RECORD_RELATIVE_PATH),
          'utf8',
        ),
      ),
    ).toEqual(initial);
  });

  test('rejects a symlink lock instead of following or stealing it', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    await new EnvironmentSecurityService({ homeDir }).initialize();
    const target = join(homeDir, 'lock-target');
    writeFileSync(target, 'not a lock');
    symlinkSync(target, join(homeDir, 'security/.environment.lock'));

    await expect(
      new EnvironmentSecurityService({
        homeDir,
        lockTimeoutMs: 15,
      }).initialize(),
    ).rejects.toThrow(/unsafe.*lock/i);
  });

  test('rejects a non-regular lock artifact', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    await new EnvironmentSecurityService({ homeDir }).initialize();
    const lockPath = join(homeDir, 'security/.environment.lock');
    mkdirSync(lockPath);

    await expect(
      new EnvironmentSecurityService({ homeDir }).initialize(),
    ).rejects.toThrow(/unsafe.*lock/i);
  });

  test('rejects an aged malformed regular lock without replacing it', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    await new EnvironmentSecurityService({ homeDir }).initialize();
    const lockPath = join(homeDir, 'security/.environment.lock');
    const old = Date.now() - 10_000;
    writeFileSync(lockPath, '{bad-json', { mode: 0o600 });
    utimesSync(lockPath, old / 1_000, old / 1_000);

    await expect(
      new EnvironmentSecurityService({
        homeDir,
        staleLockAgeMs: 1,
      }).initialize(),
    ).rejects.toThrow(/invalid.*lock/i);
    expect(readFileSync(lockPath, 'utf8')).toBe('{bad-json');
  });

  test('fails closed for an aged legacy zero-byte lock', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const initial = await new EnvironmentSecurityService({
      homeDir,
    }).initialize();
    const lockPath = join(homeDir, 'security/.environment.lock');
    const old = Date.now() - 10_000;
    writeFileSync(lockPath, '', { mode: 0o600 });
    utimesSync(lockPath, old / 1_000, old / 1_000);

    await expect(
      new EnvironmentSecurityService({
        homeDir,
        staleLockAgeMs: 1,
      }).initialize(),
    ).rejects.toThrow(/invalid.*lock/i);
    expect(initial.environmentId).toBeTruthy();
    expect(statSync(lockPath).size).toBe(0);
  });

  // station#1887: the /api/pairing family stays operator-only, with exactly
  // one narrow exception. These are the security boundary — the deny cases
  // matter more than the allow case.
  test('a promoted device reaches only the three pending-request leaves, and nothing else under /api/pairing', async () => {
    const homeDir = makeHome();
    const EnvironmentSecurityService = await loadEnvironmentSecurityService();
    const service = new EnvironmentSecurityService({ homeDir });
    await service.initialize();

    const offer = service.devicePairing.createOffer({
      endpoint: 'https://station.example.test',
    });
    const request = service.devicePairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Brian phone',
    });
    service.devicePairing.confirmRequest(request.requestId, {
      kind: 'presented-credential',
    });
    const exchanged = service.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });
    const cred = exchanged.credential;

    // Before promotion the whole family is refused, exactly as before #1887.
    expect(
      service.authorizeCredential(cred, {
        method: 'GET',
        path: '/api/pairing/requests',
      }),
    ).toBe(false);

    service.devicePairing.setDeviceApprovalAuthority(
      exchanged.device.id,
      true,
      { kind: 'presented-credential' },
    );

    // ALLOWED: exactly the three leaves.
    expect(
      service.authorizeCredential(cred, {
        method: 'GET',
        path: '/api/pairing/requests',
        activity: { lastSeenFrom: 'tailnet' },
      }),
    ).toBe(true);
    expect(service.devicePairing.identifyDevice(cred)).toMatchObject({
      usageCount: 1,
      lastSeenFrom: 'tailnet',
    });
    expect(
      service.authorizeCredential(cred, {
        method: 'POST',
        path: `/api/pairing/requests/${request.requestId}/confirm`,
      }),
    ).toBe(true);
    expect(
      service.authorizeCredential(cred, {
        method: 'DELETE',
        path: `/api/pairing/requests/${request.requestId}`,
      }),
    ).toBe(true);

    // REFUSED: everything else in the family. Minting offers and revoking
    // devices are the authority-to-mint-authority routes and must stay
    // operator-only; the device inventory is not readable either.
    for (const denied of [
      { method: 'POST', path: '/api/pairing/offers' },
      { method: 'DELETE', path: '/api/pairing/offers/abc' },
      { method: 'GET', path: '/api/pairing/devices' },
      { method: 'DELETE', path: `/api/pairing/devices/${exchanged.device.id}` },
      // Wrong verb on an allowed path.
      { method: 'DELETE', path: '/api/pairing/requests' },
      {
        method: 'GET',
        path: `/api/pairing/requests/${request.requestId}/confirm`,
      },
      // A future route under the same prefix is denied by default.
      { method: 'POST', path: '/api/pairing/requests/x/escalate' },
      // A query string must never widen the match.
      { method: 'GET', path: '/api/pairing/devices?x=/api/pairing/requests' },
    ]) {
      expect(
        service.authorizeCredential(cred, denied),
        `${denied.method} ${denied.path} must be refused`,
      ).toBe(false);
    }

    // And a NON-promoted device still gets nothing, even on the leaves.
    const second = service.devicePairing.createOffer({
      endpoint: 'https://station.example.test',
    });
    const secondRequest = service.devicePairing.requestPairing({
      offerId: second.offerId,
      proof: second.challenge,
      deviceName: 'Laptop',
    });
    service.devicePairing.confirmRequest(secondRequest.requestId, {
      kind: 'presented-credential',
    });
    const plain = service.devicePairing.exchange({
      offerId: second.offerId,
      proof: second.challenge,
      requestId: secondRequest.requestId,
    });
    expect(
      service.authorizeCredential(plain.credential, {
        method: 'GET',
        path: '/api/pairing/requests',
      }),
    ).toBe(false);

    // Revoking a promoted device drops the authority with it.
    service.devicePairing.revokeDevice(
      exchanged.device.id,
      'operator-credential',
    );
    expect(
      service.authorizeCredential(cred, {
        method: 'GET',
        path: '/api/pairing/requests',
      }),
    ).toBe(false);
  });
});
