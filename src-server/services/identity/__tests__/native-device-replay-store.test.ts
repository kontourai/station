import type { webcrypto as nodeWebcrypto } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  NATIVE_DEVICE_PROOF_LIFETIME_SECONDS,
  type NativeDeviceBindingSnapshot,
} from '@kontourai/station-contracts/native-device-proof';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';
import { createNativeDeviceRequestProof } from '@kontourai/station-sdk/native-device-proof';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type NativeDeviceProofBindingView,
  type NativeDeviceProofPeerView,
  type NativeDeviceProofPublicKeyJwk,
  NativeDeviceProofReplayedError,
  verifyNativeDeviceRequestProof,
} from '../native-device-proof-verifier.js';
import {
  NativeDeviceProofReplayStoreSqlite,
  NativeDeviceProofReplayStoreUnavailableError,
} from '../native-device-replay-store.js';

const opaque = (label: string) => label.padEnd(43, 'a');
const STATION_ID = '7e5a8c1e-1f2b-4c3d-9a4e-5f6a7b8c9d0e';
const OTHER_STATION_ID = '1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d';
const DEVICE_ID = '2b9d4f6a-8c1e-4b3f-a5d7-6e8f9a0b1c2d';
const BINDING_ID = '9c3e5f7a-1b2d-4e6f-8a9b-0c1d2e3f4a5b';
const ROUTE_KEY_THUMBPRINT = opaque('routekey');
const PEER_NONCE = opaque('peernonce');
const AUDIENCE = 'https://station.example.test';
const PATH = '/v1/things?limit=2';

const surface = (): SelfHostedBrokerNativeClientSurfaceV2 => ({
  kind: 'station-native',
  appIdentifier: 'dev.kontourai.station',
  channel: 'stable',
  clientInstanceId: '3f2c9b1e-5a44-4c1d-9a7b-2b6e8f0a1c2d',
  keyThumbprint: ROUTE_KEY_THUMBPRINT,
});

const bindingSnapshot = (
  overrides: Partial<NativeDeviceBindingSnapshot> = {},
): NativeDeviceBindingSnapshot => ({
  stationId: STATION_ID,
  stationAudience: AUDIENCE,
  deviceId: DEVICE_ID,
  bindingId: BINDING_ID,
  deviceProofKeyThumbprint: opaque('proofkey'),
  surface: surface(),
  peerNonce: PEER_NONCE,
  ...overrides,
});

const peerSnapshot = () => ({
  stationId: STATION_ID,
  stationAudience: AUDIENCE,
  surface: surface(),
  peerNonce: PEER_NONCE,
});

interface KeyPair {
  readonly publicKey: NativeDeviceProofPublicKeyJwk;
  sign(input: Uint8Array): Promise<Uint8Array>;
}

async function generateKeyPair(): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = (await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )) as nodeWebcrypto.JsonWebKey;
  return {
    publicKey: {
      kty: 'EC',
      crv: 'P-256',
      x: publicJwk.x as string,
      y: publicJwk.y as string,
    },
    sign: async (input) => {
      const copy = new Uint8Array(input.byteLength);
      copy.set(input);
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          copy,
        ),
      );
      expect(signature.byteLength).toBe(64);
      return signature;
    },
  };
}

const jwkThumbprint = async (jwk: NativeDeviceProofPublicKeyJwk) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }),
    ),
  );
  return Buffer.from(new Uint8Array(digest))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

const makeTempDir = trackTempDirs();

const tempDbPath = () => {
  const dir = makeTempDir('native-device-replay-');
  return join(dir, 'replay.sqlite');
};

describe('NativeDeviceProofReplayStoreSqlite.consume', () => {
  test('a clock rollback cannot replay a JTI pruned after its expiry', async () => {
    let now = 1000;
    const store = new NativeDeviceProofReplayStoreSqlite(
      tempDbPath(),
      STATION_ID,
      { nowSeconds: () => now },
    );
    try {
      await store.consume(opaque('original'), 1030);
      now = 1040;
      await store.consume(opaque('later'), 1070);
      now = 1001;
      await expect(
        store.consume(opaque('original'), 1030),
      ).rejects.toBeInstanceOf(NativeDeviceProofReplayStoreUnavailableError);
    } finally {
      store.close();
    }
  });
  test('consumes a JTI exactly once and rejects the duplicate as replayed', async () => {
    const store = new NativeDeviceProofReplayStoreSqlite(
      tempDbPath(),
      STATION_ID,
      { nowSeconds: () => 1000 },
    );
    try {
      await store.consume(opaque('jtione'), 1300);
      await expect(
        store.consume(opaque('jtione'), 1300),
      ).rejects.toBeInstanceOf(NativeDeviceProofReplayedError);
      await store.consume(opaque('jtitwo'), 1300);
      expect(store.size()).toBe(2);
    } finally {
      store.close();
    }
  });

  test('survives restart: a consumed JTI stays consumed after close and reopen', async () => {
    const dbPath = tempDbPath();
    const first = new NativeDeviceProofReplayStoreSqlite(dbPath, STATION_ID, {
      nowSeconds: () => 1000,
    });
    await first.consume(opaque('durab'), 1300);
    first.close();
    const second = new NativeDeviceProofReplayStoreSqlite(dbPath, STATION_ID, {
      nowSeconds: () => 1000,
    });
    try {
      await expect(
        second.consume(opaque('durab'), 1300),
      ).rejects.toBeInstanceOf(NativeDeviceProofReplayedError);
      await second.consume(opaque('fresh'), 1300);
      expect(second.size()).toBe(2);
    } finally {
      second.close();
    }
  });

  test('fails closed when the database belongs to a different Station ID', async () => {
    const dbPath = tempDbPath();
    const first = new NativeDeviceProofReplayStoreSqlite(dbPath, STATION_ID, {
      nowSeconds: () => 1000,
    });
    await first.consume(opaque('mine'), 1300);
    first.close();
    expect(
      () =>
        new NativeDeviceProofReplayStoreSqlite(dbPath, OTHER_STATION_ID, {
          nowSeconds: () => 1000,
        }),
    ).toThrow(NativeDeviceProofReplayStoreUnavailableError);
    const reopened = new NativeDeviceProofReplayStoreSqlite(
      dbPath,
      STATION_ID,
      {
        nowSeconds: () => 1000,
      },
    );
    try {
      await reopened.consume(opaque('again'), 1300);
      expect(reopened.has(opaque('mine'))).toBe(true);
    } finally {
      reopened.close();
    }
  });

  test('refuses a preexisting replay table with missing or partial Station metadata', () => {
    const dbPath = tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE native_device_proof_replay (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)',
    );
    db.prepare('INSERT INTO native_device_proof_replay VALUES (?,?)').run(
      opaque('prior'),
      1300,
    );
    db.close();
    expect(
      () =>
        new NativeDeviceProofReplayStoreSqlite(dbPath, STATION_ID, {
          nowSeconds: () => 1000,
        }),
    ).toThrow(NativeDeviceProofReplayStoreUnavailableError);

    const partial = new DatabaseSync(dbPath);
    partial.exec(
      'CREATE TABLE native_device_proof_replay_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    partial
      .prepare('INSERT INTO native_device_proof_replay_meta VALUES (?,?)')
      .run('schema_version', '1');
    partial.close();
    expect(
      () =>
        new NativeDeviceProofReplayStoreSqlite(dbPath, STATION_ID, {
          nowSeconds: () => 1000,
        }),
    ).toThrow(NativeDeviceProofReplayStoreUnavailableError);
  });

  test('refuses an invalid verification clock before consuming a JTI', async () => {
    let now = Number.NaN;
    const store = new NativeDeviceProofReplayStoreSqlite(
      tempDbPath(),
      STATION_ID,
      {
        nowSeconds: () => now,
      },
    );
    try {
      await expect(
        store.consume(opaque('invalidclock'), 1300),
      ).rejects.toBeInstanceOf(NativeDeviceProofReplayStoreUnavailableError);
      expect(store.size()).toBe(0);
      now = -1;
      await expect(
        store.consume(opaque('negativeclock'), 1300),
      ).rejects.toBeInstanceOf(NativeDeviceProofReplayStoreUnavailableError);
      expect(store.size()).toBe(0);
    } finally {
      store.close();
    }
  });

  test.skipIf(process.platform === 'win32')(
    'keeps the database private and refuses public or symlinked custody',
    async () => {
      const dbPath = tempDbPath();
      const store = new NativeDeviceProofReplayStoreSqlite(dbPath, STATION_ID, {
        nowSeconds: () => 1000,
      });
      await store.consume(opaque('custody'), 1300);
      store.close();
      expect(lstatSync(dbPath).mode & 0o777).toBe(0o600);
      chmodSync(dbPath, 0o644);
      expect(
        () => new NativeDeviceProofReplayStoreSqlite(dbPath, STATION_ID),
      ).toThrow(NativeDeviceProofReplayStoreUnavailableError);
      chmodSync(dbPath, 0o600);
      const target = `${dbPath}.target`;
      renameSync(dbPath, target);
      symlinkSync(target, dbPath);
      expect(
        () => new NativeDeviceProofReplayStoreSqlite(dbPath, STATION_ID),
      ).toThrow(NativeDeviceProofReplayStoreUnavailableError);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'refuses a database under a nonprivate parent',
    () => {
      const dbPath = tempDbPath();
      chmodSync(dirname(dbPath), 0o755);
      expect(
        () => new NativeDeviceProofReplayStoreSqlite(dbPath, STATION_ID),
      ).toThrow(NativeDeviceProofReplayStoreUnavailableError);
    },
  );

  test('fails closed on malformed JTI, malformed expiry, and expired proofs without consuming', async () => {
    const store = new NativeDeviceProofReplayStoreSqlite(
      tempDbPath(),
      STATION_ID,
      { nowSeconds: () => 1000 },
    );
    try {
      await expect(store.consume('short', 1300)).rejects.toBeInstanceOf(
        NativeDeviceProofReplayStoreUnavailableError,
      );
      await expect(
        store.consume(`${opaque('bad!')}!`, 1300),
      ).rejects.toBeInstanceOf(NativeDeviceProofReplayStoreUnavailableError);
      await expect(
        store.consume(opaque('okjti'), Number.NaN),
      ).rejects.toBeInstanceOf(NativeDeviceProofReplayStoreUnavailableError);
      await expect(store.consume(opaque('okjti'), 900)).rejects.toBeInstanceOf(
        NativeDeviceProofReplayStoreUnavailableError,
      );
      await expect(store.consume(opaque('okjti'), 1000)).rejects.toBeInstanceOf(
        NativeDeviceProofReplayStoreUnavailableError,
      );
      expect(store.size()).toBe(0);
    } finally {
      store.close();
    }
  });

  test('prunes expired entries inside the consume transaction', async () => {
    let now = 1000;
    const store = new NativeDeviceProofReplayStoreSqlite(
      tempDbPath(),
      STATION_ID,
      { nowSeconds: () => now },
    );
    try {
      await store.consume(opaque('dying'), 1500);
      await store.consume(opaque('living'), 3000);
      expect(store.size()).toBe(2);
      now = 2000;
      await store.consume(opaque('newest'), 3000);
      expect(store.size()).toBe(2);
      expect(store.has(opaque('dying'))).toBe(false);
      expect(store.has(opaque('living'))).toBe(true);
      expect(store.has(opaque('newest'))).toBe(true);
    } finally {
      store.close();
    }
  });

  test('fails closed at capacity and a rejected write consumes nothing', async () => {
    const store = new NativeDeviceProofReplayStoreSqlite(
      tempDbPath(),
      STATION_ID,
      { maxEntries: 2, nowSeconds: () => 1000 },
    );
    try {
      await store.consume(opaque('first'), 1300);
      await store.consume(opaque('second'), 1300);
      await expect(store.consume(opaque('third'), 1300)).rejects.toBeInstanceOf(
        NativeDeviceProofReplayStoreUnavailableError,
      );
      expect(store.size()).toBe(2);
      expect(store.has(opaque('third'))).toBe(false);
      await expect(store.consume(opaque('first'), 1300)).rejects.toBeInstanceOf(
        NativeDeviceProofReplayedError,
      );
      await expect(store.consume(opaque('third'), 1300)).rejects.toBeInstanceOf(
        NativeDeviceProofReplayStoreUnavailableError,
      );
    } finally {
      store.close();
    }
  });

  test('fails closed on a corrupt database file without signaling replay', async () => {
    const dbPath = tempDbPath();
    writeFileSync(dbPath, Buffer.from('this is not a sqlite database at all'));
    expect(
      () =>
        new NativeDeviceProofReplayStoreSqlite(dbPath, STATION_ID, {
          nowSeconds: () => 1000,
        }),
    ).toThrow(NativeDeviceProofReplayStoreUnavailableError);
  });

  test('fails closed on a truncated-then-tampered schema instead of authorizing', async () => {
    const dbPath = tempDbPath();
    const first = new NativeDeviceProofReplayStoreSqlite(dbPath, STATION_ID, {
      nowSeconds: () => 1000,
    });
    await first.consume(opaque('seed'), 1300);
    first.close();
    const bytes = [...readFileSync(dbPath)];
    bytes.splice(40, 8, ...Buffer.from('XXXXXXXX'));
    writeFileSync(dbPath, Buffer.from(bytes));
    expect(
      () =>
        new NativeDeviceProofReplayStoreSqlite(dbPath, STATION_ID, {
          nowSeconds: () => 1000,
        }),
    ).toThrow();
  });
});

describe('verifier integration with the SQLite replay store', () => {
  test('the real verifier consumes a real SDK-signed proof once; the replayed proof is rejected as replayed', async () => {
    const key = await generateKeyPair();
    let now = Math.floor(Date.now() / 1000);
    const snapshot = bindingSnapshot({
      deviceProofKeyThumbprint: await jwkThumbprint(key.publicKey),
    });
    const binding: NativeDeviceProofBindingView = {
      status: 'approved',
      snapshot,
      deviceProofKey: key.publicKey,
    };
    const peer: NativeDeviceProofPeerView = {
      status: 'current',
      snapshot: peerSnapshot(),
    };
    const body = new TextEncoder().encode('{"n":1}');
    const proof = await createNativeDeviceRequestProof(key, snapshot, {
      method: 'POST',
      path: PATH,
      body,
    });
    const store = new NativeDeviceProofReplayStoreSqlite(
      tempDbPath(),
      STATION_ID,
      { nowSeconds: () => now },
    );
    try {
      const authority = {
        binding: async () => binding,
        peer: async () => peer,
      };
      const first = await verifyNativeDeviceRequestProof(
        proof,
        { method: 'POST', path: PATH, body },
        authority,
        { replayStore: store, nowSeconds: () => now },
      );
      expect(first.deviceId).toBe(DEVICE_ID);
      expect(first.bindingId).toBe(BINDING_ID);
      await expect(
        verifyNativeDeviceRequestProof(
          proof,
          { method: 'POST', path: PATH, body },
          authority,
          { replayStore: store, nowSeconds: () => now },
        ),
      ).rejects.toBeInstanceOf(NativeDeviceProofReplayedError);
      const laterProof = await createNativeDeviceRequestProof(key, snapshot, {
        method: 'POST',
        path: PATH,
        body,
      });
      now += NATIVE_DEVICE_PROOF_LIFETIME_SECONDS + 10;
      await expect(
        verifyNativeDeviceRequestProof(
          laterProof,
          { method: 'POST', path: PATH, body },
          authority,
          { replayStore: store, nowSeconds: () => now },
        ),
      ).rejects.toMatchObject({ reason: 'expired' });
    } finally {
      store.close();
    }
  });
});
