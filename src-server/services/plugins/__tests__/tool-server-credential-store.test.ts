import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const acquiredLockPaths = vi.hoisted(() => [] as string[]);

vi.mock(
  '@kontourai/station-shared/lifecycle-events',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/lifecycle-events')
      >();
    return {
      ...actual,
      acquireFileMutationLockAsync: async (path: string) => {
        acquiredLockPaths.push(path);
        return actual.acquireFileMutationLockAsync(path);
      },
    };
  },
);

import {
  ToolServerCredentialStore,
  toolServerCredentialStoreMutationLockPath,
} from '../tool-server-credential-store.js';

const roots: string[] = [];
function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'station-tool-credentials-'));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('ToolServerCredentialStore', () => {
  test('all buckets serialize document mutations through one store lock', async () => {
    const root = home();
    const store = new ToolServerCredentialStore(root);
    acquiredLockPaths.length = 0;
    await store.upsert('server-a', 'TOKEN', 'a');
    await store.upsert('server-b', 'TOKEN', 'b');
    expect(acquiredLockPaths).toEqual([
      toolServerCredentialStoreMutationLockPath(root),
      toolServerCredentialStoreMutationLockPath(root),
    ]);
    expect(store.get('server-a', 'TOKEN')).toBe('a');
    expect(store.get('server-b', 'TOKEN')).toBe('b');
  });

  test('store mutation acquires its document lock inside an integration transaction', async () => {
    const root = home();
    const store = new ToolServerCredentialStore(root);
    acquiredLockPaths.length = 0;
    await store.upsert('server', 'TOKEN', 'value');
    expect(acquiredLockPaths).toEqual([
      toolServerCredentialStoreMutationLockPath(root),
    ]);
  });

  test('keys credentials structurally so ambiguous server ids cannot cross-read', async () => {
    const root = home();
    const store = new ToolServerCredentialStore(root);
    await store.upsert('a:b', 'TOKEN', 'owned-by-a-b');
    await store.upsert('a', 'b:TOKEN', 'owned-by-a');
    expect(store.get('a:b', 'TOKEN')).toBe('owned-by-a-b');
    expect(store.get('a', 'b:TOKEN')).toBe('owned-by-a');
    expect(() => store.get('a', 'TOKEN')).toThrow(
      'Tool-server credential is missing',
    );
  });

  test('rejects dangerous server and env keys with named errors', async () => {
    const store = new ToolServerCredentialStore(home());
    // The error must NAME the offending key (round-5 routed both checks
    // through the shared safe-id/safe-key predicates, which changed the
    // wording; the force asserted here is "rejected, and says which key").
    await expect(store.upsert('__proto__', 'TOKEN', 'value')).rejects.toThrow(
      'Invalid tool-server credential server id: "__proto__"',
    );
    await expect(store.upsert('server', '__proto__', 'value')).rejects.toThrow(
      'Invalid tool-server credential env name: "__proto__"',
    );
  });

  test('hostile parsed documents cannot pollute Object.prototype', () => {
    const root = home();
    new ToolServerCredentialStore(root);
    writeFileSync(
      join(root, 'security', 'tool-server-credentials.json'),
      '{"schemaVersion":2,"credentials":{"server":{"__proto__":"polluted"}}}',
      { mode: 0o600 },
    );
    expect(() => new ToolServerCredentialStore(root)).toThrow(
      'Invalid tool-server credential env name: "__proto__"',
    );
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  });

  test('rejects a symlink store target', () => {
    const root = home();
    mkdirSync(join(root, 'security'), { mode: 0o700 });
    const outside = join(root, 'outside');
    writeFileSync(outside, '{}');
    symlinkSync(
      outside,
      join(root, 'security', 'tool-server-credentials.json'),
    );
    expect(() => new ToolServerCredentialStore(root)).toThrow(
      'Unsafe tool-server credential store',
    );
  });

  test('rejects a hardlinked store', () => {
    const root = home();
    mkdirSync(join(root, 'security'), { mode: 0o700 });
    const outside = join(root, 'outside');
    writeFileSync(outside, '{"schemaVersion":2,"credentials":{}}', {
      mode: 0o600,
    });
    linkSync(outside, join(root, 'security', 'tool-server-credentials.json'));
    expect(() => new ToolServerCredentialStore(root)).toThrow(
      'Unsafe tool-server credential store',
    );
  });

  test.runIf(process.platform !== 'win32')(
    'rejects wrong directory and file modes',
    async () => {
      const directoryRoot = home();
      mkdirSync(join(directoryRoot, 'security'), { mode: 0o755 });
      expect(() => new ToolServerCredentialStore(directoryRoot)).toThrow(
        'Unsafe tool-server credential directory',
      );

      const fileRoot = home();
      const store = new ToolServerCredentialStore(fileRoot);
      await store.upsert('server', 'TOKEN', 'value');
      chmodSync(
        join(fileRoot, 'security', 'tool-server-credentials.json'),
        0o644,
      );
      expect(() => new ToolServerCredentialStore(fileRoot)).toThrow(
        'Unsafe tool-server credential store',
      );
    },
  );

  test('rejects a non-file store target', () => {
    const root = home();
    mkdirSync(join(root, 'security'), { mode: 0o700 });
    mkdirSync(join(root, 'security', 'tool-server-credentials.json'), {
      mode: 0o700,
    });
    expect(() => new ToolServerCredentialStore(root)).toThrow(
      'Unsafe tool-server credential store',
    );
  });

  test('removes a credential record rather than orphaning it', async () => {
    const root = home();
    const store = new ToolServerCredentialStore(root);
    await store.upsert('server', 'TOKEN', 'value');
    await store.remove('server', 'TOKEN');
    expect(() => store.get('server', 'TOKEN')).toThrow(
      'Tool-server credential is missing',
    );
    expect(
      readFileSync(
        join(root, 'security', 'tool-server-credentials.json'),
        'utf8',
      ),
    ).not.toContain('value');
  });

  test('rejects malformed and corrupt store JSON', () => {
    const root = home();
    const store = new ToolServerCredentialStore(root);
    writeFileSync(
      join(root, 'security', 'tool-server-credentials.json'),
      '{nope',
      { mode: 0o600 },
    );
    expect(() => store.get('server', 'TOKEN')).toThrow(SyntaxError);
  });
});
