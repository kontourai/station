import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  PeerCredentialStore,
  type PeerCredentialStoreOptions,
} from '../peer-credential-store.js';

const homes: string[] = [];

function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'station-peer-credentials-'));
  homes.push(value);
  return value;
}

function input(environmentId: string) {
  return {
    environmentId,
    apiBase: `https://${environmentId}.example.test`,
    scope: 'orchestration:read',
    credential: `credential-for-${environmentId}-0123456789abcdef`,
  };
}

function storedPeerFile(root: string): string {
  return join(root, 'security', 'peer-credentials.json');
}

async function corruptStoredPeer(
  root: string,
  mutate: (peer: Record<string, unknown>) => void,
): Promise<string> {
  const store = new PeerCredentialStore(root);
  await store.upsert(input('environment-existing'));
  const file = storedPeerFile(root);
  const document = JSON.parse(readFileSync(file, 'utf8')) as {
    peers: Array<Record<string, unknown>>;
  };
  mutate(document.peers[0]!);
  const bytes = `${JSON.stringify(document)}\n`;
  writeFileSync(file, bytes, 'utf8');
  return bytes;
}

afterEach(() => {
  for (const value of homes.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe('PeerCredentialStore (station#1123 slice 2)', () => {
  test('round-trips a peer credential atomically with private file/directory permissions', async () => {
    const root = home();
    const store = new PeerCredentialStore(root);

    const record = await store.upsert({
      environmentId: 'environment-peer-b',
      apiBase: 'https://box-b.example.test:3141',
      scope: 'orchestration:read orchestration:operate',
      credential: 'peer-bearer-credential-0123456789abcdef',
      label: 'box-b',
    });

    expect(record).toEqual({
      environmentId: 'environment-peer-b',
      apiBase: 'https://box-b.example.test:3141',
      scope: 'orchestration:read orchestration:operate',
      label: 'box-b',
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    // The secret never appears in the returned summary.
    expect(record).not.toHaveProperty('credential');

    const file = join(root, 'security', 'peer-credentials.json');
    if (process.platform !== 'win32') {
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(root, 'security')).mode & 0o777).toBe(0o700);
    }

    // A fresh store instance (simulating a process restart) reads the same
    // record back, list() still redacted, get() still returns the secret.
    const reopened = new PeerCredentialStore(root);
    expect(reopened.list()).toEqual([record]);
    expect(reopened.get('environment-peer-b')).toEqual({
      ...record,
      credential: 'peer-bearer-credential-0123456789abcdef',
    });
    expect(reopened.get('environment-does-not-exist')).toBeNull();
  });

  test('normalizes a padded new label before it is persisted', async () => {
    const root = home();
    const record = await new PeerCredentialStore(root).upsert({
      ...input('environment-peer-b'),
      label: '  peer b  ',
    });

    expect(record.label).toBe('peer b');
    expect(readFileSync(storedPeerFile(root), 'utf8')).toContain(
      '"label":"peer b"',
    );
  });

  test('is not world- or group-readable on disk', async () => {
    const root = home();
    const store = new PeerCredentialStore(root);
    await store.upsert({
      environmentId: 'environment-peer-b',
      apiBase: 'https://box-b.example.test',
      scope: 'orchestration:read',
      credential: 'peer-bearer-credential-0123456789abcdef',
    });
    const file = join(root, 'security', 'peer-credentials.json');
    const raw = readFileSync(file, 'utf8');
    expect(raw).toContain('peer-bearer-credential-0123456789abcdef');
    if (process.platform !== 'win32') {
      const mode = lstatSync(file).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    }
  });

  test('list() never includes the credential even across multiple peers', async () => {
    const root = home();
    const store = new PeerCredentialStore(root);
    await store.upsert({
      environmentId: 'environment-a',
      apiBase: 'https://a.example.test',
      scope: 'orchestration:read',
      credential: 'credential-for-a-0123456789abcdef',
    });
    await store.upsert({
      environmentId: 'environment-b',
      apiBase: 'https://b.example.test',
      scope: 'orchestration:read orchestration:operate',
      credential: 'credential-for-b-0123456789abcdef',
    });

    const listed = store.list();
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toMatch(/credential-for-(a|b)/);
  });

  test('upsert on an existing environmentId replaces the record and preserves createdAt', async () => {
    const root = home();
    const store = new PeerCredentialStore(root);
    const first = await store.upsert({
      environmentId: 'environment-peer-b',
      apiBase: 'https://box-b.example.test',
      scope: 'orchestration:read',
      credential: 'first-credential-0123456789abcdef',
    });
    const second = await store.upsert({
      environmentId: 'environment-peer-b',
      apiBase: 'https://box-b.example.test:4000',
      scope: 'orchestration:read orchestration:operate',
      credential: 'second-credential-0123456789abcdef',
      label: 'box-b (renamed)',
    });

    expect(store.list()).toHaveLength(1);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.apiBase).toBe('https://box-b.example.test:4000');
    expect(second.scope).toBe('orchestration:read orchestration:operate');
    expect(second.label).toBe('box-b (renamed)');
    expect(store.get('environment-peer-b')?.credential).toBe(
      'second-credential-0123456789abcdef',
    );
  });

  test('remove() deletes an existing record and is idempotent-honest about it', async () => {
    const root = home();
    const store = new PeerCredentialStore(root);
    await store.upsert({
      environmentId: 'environment-peer-b',
      apiBase: 'https://box-b.example.test',
      scope: 'orchestration:read',
      credential: 'credential-0123456789abcdef',
    });

    expect(await store.remove('environment-peer-b')).toBe(true);
    expect(store.list()).toEqual([]);
    expect(await store.remove('environment-peer-b')).toBe(false);
  });

  test('re-reads under the mutation lock so a stale upsert cannot restore a removed credential', async () => {
    const root = home();
    const original = new PeerCredentialStore(root);
    await original.upsert(input('environment-removed'));
    const remover = new PeerCredentialStore(root);
    let secondMutationStarted = false;
    const stale = new PeerCredentialStore(root, {
      acquireMutationLock: async () => {
        if (!secondMutationStarted) {
          secondMutationStarted = true;
          expect(await remover.remove('environment-removed')).toBe(true);
        }
        return () => {};
      },
    });

    await stale.upsert(input('environment-new'));

    const reopened = new PeerCredentialStore(root);
    expect(reopened.get('environment-removed')).toBeNull();
    expect(reopened.list().map((record) => record.environmentId)).toEqual([
      'environment-new',
    ]);
  });

  test('retains distinct peer credentials when two mutations begin from the same earlier document', async () => {
    const root = home();
    const second = new PeerCredentialStore(root);
    let secondMutationStarted = false;
    const first = new PeerCredentialStore(root, {
      acquireMutationLock: async () => {
        if (!secondMutationStarted) {
          secondMutationStarted = true;
          await second.upsert(input('environment-second'));
        }
        return () => {};
      },
    });

    await first.upsert(input('environment-first'));

    expect(
      new PeerCredentialStore(root)
        .list()
        .map((record) => record.environmentId)
        .sort(),
    ).toEqual(['environment-first', 'environment-second']);
  });

  test('refuses an unavailable mutation lock without changing an existing credential document', async () => {
    const root = home();
    const store = new PeerCredentialStore(root);
    await store.upsert(input('environment-existing'));
    const file = join(root, 'security', 'peer-credentials.json');
    const before = readFileSync(file, 'utf8');
    const locked = new PeerCredentialStore(root, {
      acquireMutationLock: (() => {
        throw new Error('peer-credential mutation lock is held');
      }) satisfies NonNullable<
        PeerCredentialStoreOptions['acquireMutationLock']
      >,
    });

    await expect(locked.upsert(input('environment-new'))).rejects.toThrow(
      'peer-credential mutation lock is held',
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('fails loudly on corrupt bytes and never replaces them during a mutation', async () => {
    const root = home();
    const store = new PeerCredentialStore(root);
    const file = join(root, 'security', 'peer-credentials.json');
    const corrupt = '{ unreadable';
    writeFileSync(file, corrupt, 'utf8');

    await expect(store.upsert(input('environment-new'))).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe(corrupt);
    expect(existsSync(`${file}.mutation`)).toBe(false);
  });

  test.each([
    [
      'missing createdAt',
      (peer: Record<string, unknown>) => delete peer.createdAt,
    ],
    [
      'string updatedAt',
      (peer: Record<string, unknown>) => {
        peer.updatedAt = 'not-a-number';
      },
    ],
    [
      'null timestamp, the JSON representation of non-finite values',
      (peer: Record<string, unknown>) => {
        peer.createdAt = null;
      },
    ],
    ['missing label', (peer: Record<string, unknown>) => delete peer.label],
    [
      'padded label',
      (peer: Record<string, unknown>) => {
        peer.label = ' peer label ';
      },
    ],
    [
      'padded environmentId',
      (peer: Record<string, unknown>) => {
        peer.environmentId = ' environment-existing ';
      },
    ],
    [
      'noncanonical apiBase',
      (peer: Record<string, unknown>) => {
        peer.apiBase = 'https://environment-existing.example.test/';
      },
    ],
  ])(
    'rejects persisted records with %s without rewriting their bytes',
    async (_label, mutate) => {
      const root = home();
      const bytes = await corruptStoredPeer(root, mutate);
      const file = storedPeerFile(root);

      expect(() => new PeerCredentialStore(root)).toThrow();
      expect(readFileSync(file, 'utf8')).toBe(bytes);
    },
  );

  test.each(['NaN', 'Infinity'])(
    'rejects invalid JSON non-finite timestamp literal %s without mutation',
    async (literal) => {
      const root = home();
      const original = await corruptStoredPeer(root, (peer) => {
        peer.createdAt = 1;
      });
      const bytes = original.replace('"createdAt":1', `"createdAt":${literal}`);
      const file = storedPeerFile(root);
      writeFileSync(file, bytes, 'utf8');

      expect(() => new PeerCredentialStore(root)).toThrow();
      expect(readFileSync(file, 'utf8')).toBe(bytes);
    },
  );

  test('refuses corrupt persisted timestamps on list and mutation without a lock or write-back', async () => {
    const root = home();
    const store = new PeerCredentialStore(root);
    const bytes = await corruptStoredPeer(root, (peer) => {
      delete peer.updatedAt;
    });
    const file = storedPeerFile(root);

    expect(() => store.list()).toThrow('Peer updatedAt is invalid');
    await expect(store.upsert(input('environment-new'))).rejects.toThrow(
      'Peer updatedAt is invalid',
    );
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(existsSync(`${file}.mutation`)).toBe(false);
  });

  test('refuses a padded persisted label on construction, list, and mutation without write-back', async () => {
    const root = home();
    const store = new PeerCredentialStore(root);
    const bytes = await corruptStoredPeer(root, (peer) => {
      peer.label = ' peer label ';
    });
    const file = storedPeerFile(root);

    expect(() => new PeerCredentialStore(root)).toThrow(
      'Peer label is invalid',
    );
    expect(() => store.list()).toThrow('Peer label is invalid');
    await expect(store.upsert(input('environment-new'))).rejects.toThrow(
      'Peer label is invalid',
    );
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(existsSync(`${file}.mutation`)).toBe(false);
  });

  test.each([
    [
      'write',
      {
        writeFileSync: () => {
          throw new Error('injected write failure');
        },
      },
      'injected write failure',
    ],
    [
      'file sync',
      {
        fsyncSync: () => {
          throw new Error('injected file sync failure');
        },
      },
      'injected file sync failure',
    ],
    [
      'close',
      {
        closeSync: (descriptor) => {
          closeSync(descriptor);
          throw new Error('injected close failure');
        },
      },
      'injected close failure',
    ],
    [
      'rename',
      {
        renameSync: () => {
          throw new Error('injected rename failure');
        },
      },
      'injected rename failure',
    ],
  ] satisfies Array<
    [string, NonNullable<PeerCredentialStoreOptions['writeOperations']>, string]
  >)(
    'preserves the primary %s failure and cleans temporary mutation state',
    async (_operation, writeOperations, failure) => {
      const root = home();
      const existing = new PeerCredentialStore(root);
      await existing.upsert(input('environment-existing'));
      const file = join(root, 'security', 'peer-credentials.json');
      const before = readFileSync(file, 'utf8');
      const failing = new PeerCredentialStore(root, { writeOperations });

      await expect(failing.upsert(input('environment-new'))).rejects.toThrow(
        failure,
      );
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(readdirSync(join(root, 'security'))).not.toContain(
        expect.stringMatching(/\.tmp$/),
      );
      expect(existsSync(`${file}.mutation`)).toBe(false);
    },
  );

  test('returns a usable credential after post-rename parent sync failure', async () => {
    const root = home();
    const faulting = new PeerCredentialStore(root, {
      writeOperations: {
        fsyncDirectorySync: () => {
          throw new Error('injected parent sync failure');
        },
      },
    });

    const saved = await faulting.upsert(input('environment-parent-sync'));
    expect(
      new PeerCredentialStore(root).get(saved.environmentId)?.credential,
    ).toBe('credential-for-environment-parent-sync-0123456789abcdef');
  });

  test('returns a successful remove after post-rename cleanup failure', async () => {
    const root = home();
    const original = new PeerCredentialStore(root);
    await original.upsert(input('environment-cleanup'));
    const faulting = new PeerCredentialStore(root, {
      writeOperations: {
        rmSync: () => {
          throw new Error('injected cleanup failure');
        },
      },
    });

    expect(await faulting.remove('environment-cleanup')).toBe(true);
    expect(new PeerCredentialStore(root).get('environment-cleanup')).toBeNull();
    expect(
      existsSync(`${join(root, 'security', 'peer-credentials.json')}.mutation`),
    ).toBe(false);
  });

  test('rejects an invalid apiBase (not a bare http(s) origin)', async () => {
    const root = home();
    const store = new PeerCredentialStore(root);
    for (const apiBase of [
      'not a url',
      'ftp://box-b.example.test',
      'https://box-b.example.test/some/path',
      'https://user:pass@box-b.example.test',
    ]) {
      await expect(
        store.upsert({
          environmentId: 'environment-peer-b',
          apiBase,
          scope: 'orchestration:read',
          credential: 'credential-0123456789abcdef',
        }),
      ).rejects.toThrow();
    }
  });

  test('rejects an unparseable pairing scope string', async () => {
    const root = home();
    const store = new PeerCredentialStore(root);
    await expect(
      store.upsert({
        environmentId: 'environment-peer-b',
        apiBase: 'https://box-b.example.test',
        scope: 'not-a-real-scope',
        credential: 'credential-0123456789abcdef',
      }),
    ).rejects.toThrow();
  });

  test('rejects a too-short or empty credential', async () => {
    const root = home();
    const store = new PeerCredentialStore(root);
    for (const credential of ['', 'short']) {
      await expect(
        store.upsert({
          environmentId: 'environment-peer-b',
          apiBase: 'https://box-b.example.test',
          scope: 'orchestration:read',
          credential,
        }),
      ).rejects.toThrow();
    }
  });
});
