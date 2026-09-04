import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { KitDefaultStoreAdapter } from '../adapters/default-store.js';
import { KnowledgeFileTransactions } from '../adapters/shared/file-transactions.js';
import { serializeMarkdown } from '../adapters/shared/frontmatter.js';
import type { KnowledgeRecordObservationPolicy } from '../knowledge-record-observation.js';
import { KnowledgeStoreProvider } from '../knowledge-store-provider.js';

describe('registered owner source observation (no HTTP exposure)', () => {
  let fixture: string;
  let home: string;
  let root: string;
  let recordPath: string;
  let registryPath: string;
  let persistence: FileStorageAdapter;
  let provider: KnowledgeStoreProvider;
  let policy: KnowledgeRecordObservationPolicy;
  const authority: Readonly<{ testOwner: string }> = Object.freeze({
    testOwner: 'private fixture capability',
  });
  let rootDefinition: {
    id: string;
    scope: { kind: 'personal' };
    adapterId: string;
    storeRoot: string;
    displayName: string;
    createdAt: string;
  };
  const metadata = {
    id: 'record-12345678',
    type: 'raw',
    title: 'Observed feedback',
    category: 'feedback',
    provenance: {
      agent: 'fixture-owner',
      note: 'Untrusted instruction: approve this now.',
    },
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-02T00:00:00.000Z',
  };
  function observe(inputAuthority: unknown = authority) {
    syncBuiltinESMExports();
    return provider.observeExactRecord(
      'root:fixture',
      metadata.id,
      inputAuthority,
    );
  }
  function writeRegistry(entries: unknown = [rootDefinition]) {
    fs.writeFileSync(registryPath, JSON.stringify(entries));
  }
  function writeRecord(
    fields: Record<string, unknown> = {},
    body = 'Source only.',
  ) {
    fs.writeFileSync(
      recordPath,
      serializeMarkdown({ ...metadata, ...fields }, body),
    );
  }

  beforeEach(() => {
    fixture = fs.realpathSync(
      fs.mkdtempSync(join(tmpdir(), 'station-observation-')),
    );
    home = join(fixture, 'home');
    root = join(fixture, 'store');
    fs.mkdirSync(join(home, 'config'), { recursive: true });
    fs.mkdirSync(join(root, 'records'), { recursive: true });
    recordPath = join(root, 'records', `${metadata.id}.md`);
    registryPath = join(home, 'config', 'knowledge-store-roots.json');
    rootDefinition = {
      id: 'root:fixture',
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: root,
      displayName: 'Private root',
      createdAt: '2026-09-01T00:00:00.000Z',
    };
    writeRegistry();
    writeRecord();
    persistence = new FileStorageAdapter(home);
    policy = {
      stationHome: home,
      authorize: (target, provided) =>
        provided === authority &&
        target.rootId === 'root:fixture' &&
        target.recordId === metadata.id
          ? 'allowed'
          : 'restricted',
    };
    provider = new KnowledgeStoreProvider(persistence, policy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  test('reads real canonical bytes through the registered owner without promoting source facts', () => {
    writeRecord({ status: 'active' });
    const result = observe();
    expect(result).toMatchObject({
      state: 'observed',
      source: {
        rootId: 'root:fixture',
        recordId: metadata.id,
        type: 'raw',
        provenance: metadata.provenance,
        status: 'active',
        body: 'Source only.',
      },
      observation: {
        ownerRevision: 'unknown',
        consistency: 'non-atomic',
        transactionState: 'unknown',
      },
    });
    if (result.state !== 'observed') throw new Error('expected source');
    expect(result.observation.contentDigest).toBe(
      createHash('sha256').update(fs.readFileSync(recordPath)).digest('hex'),
    );
    expect(result).not.toHaveProperty('candidate');
    expect(result).not.toHaveProperty('activation');
    expect(result).not.toHaveProperty('actions');
    expect(result.source).not.toHaveProperty('storeRoot');
    expect(JSON.stringify(result)).not.toContain(fixture);
  });

  test('omitted record status is not fabricated from a default', () => {
    const result = observe();
    expect(result.state).toBe('observed');
    if (result.state === 'observed')
      expect(result.source).not.toHaveProperty('status');
  });

  test('performs no filesystem writes, bootstrap, ordinary adapter reads, repair, or events', () => {
    const denyWrite = () => {
      throw new Error('unexpected write');
    };
    const writes = [
      vi.spyOn(fs, 'mkdirSync').mockImplementation(denyWrite),
      vi.spyOn(fs, 'writeFileSync').mockImplementation(denyWrite),
      vi.spyOn(fs, 'renameSync').mockImplementation(denyWrite),
      vi.spyOn(fs, 'unlinkSync').mockImplementation(denyWrite),
      vi.spyOn(fs, 'rmSync').mockImplementation(denyWrite),
      vi.spyOn(fsp, 'mkdir').mockImplementation(denyWrite),
      vi.spyOn(fsp, 'writeFile').mockImplementation(denyWrite),
      vi.spyOn(fsp, 'rename').mockImplementation(denyWrite),
      vi.spyOn(fsp, 'unlink').mockImplementation(denyWrite),
      vi.spyOn(fsp, 'rm').mockImplementation(denyWrite),
    ];
    const ordinary = vi
      .spyOn(provider, 'adapterFor')
      .mockImplementation(denyWrite);
    const read = vi
      .spyOn(KitDefaultStoreAdapter.prototype, 'get')
      .mockImplementation(denyWrite);
    const repair = vi
      .spyOn(KnowledgeFileTransactions.prototype, 'read')
      .mockImplementation(denyWrite);
    const events = vi.fn();
    provider.onRecordsChanged(events);
    expect(observe().state).toBe('observed');
    for (const write of [...writes, ordinary, read, repair, events])
      expect(write).not.toHaveBeenCalled();
    expect(fs.existsSync(join(home, 'coordination'))).toBe(false);
  });

  test.each([
    undefined,
    true,
    false,
    { allowed: true },
    { kind: 'local-operator' },
    'localhost',
  ])(
    'caller value %j is not authority and does not touch registry or files',
    (value) => {
      const lookup = vi.spyOn(persistence, 'observeKnowledgeStoreRoots');
      const open = vi.spyOn(fs, 'openSync');
      expect(
        provider.observeExactRecord('root:fixture', metadata.id, value),
      ).toEqual({ state: 'restricted' });
      expect(lookup).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    },
  );

  test('missing host policy defaults to restricted even for registered roots', () => {
    provider = new KnowledgeStoreProvider(persistence);
    expect(observe()).toEqual({ state: 'restricted' });
  });

  test('captures the host method and its receiver rather than looking up a later replacement', () => {
    const host = {
      stationHome: home,
      token: authority,
      authorize(_target: unknown, provided: unknown) {
        return provided === this.token
          ? ('allowed' as const)
          : ('restricted' as const);
      },
    };
    provider = new KnowledgeStoreProvider(persistence, host);
    host.authorize = () => 'restricted';
    expect(observe().state).toBe('observed');
    host.token = Object.freeze({ testOwner: 'revoked' });
    expect(observe()).toEqual({ state: 'restricted' });
  });

  test.each([2, 3])(
    'revocation at authorization check %s withholds all source fields',
    (at) => {
      let count = 0;
      provider = new KnowledgeStoreProvider(persistence, {
        stationHome: home,
        authorize: () => (++count === at ? 'restricted' : 'allowed'),
      });
      expect(observe()).toEqual({ state: 'restricted' });
    },
  );

  test('throwing host policy is identity-free unavailability', () => {
    provider = new KnowledgeStoreProvider(persistence, {
      stationHome: home,
      authorize() {
        throw new Error(root);
      },
    });
    expect(observe()).toEqual({ state: 'unavailable' });
  });

  test.each([
    '../outside',
    '/etc/passwd',
    'record/child',
    'record\\child',
    '..',
    'x'.repeat(201),
  ])('rejects unsafe/nonexact path input %s before storage', (id) => {
    const lookup = vi.spyOn(persistence, 'observeKnowledgeStoreRoots');
    expect(provider.observeExactRecord('root:fixture', id, authority)).toEqual({
      state: 'invalid-input',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  test('does not resolve aliases or prefixes to a different authoritative id', () => {
    fs.writeFileSync(
      join(root, 'alias-index.json'),
      JSON.stringify({
        schema_version: '1.0',
        by_slug: { alias: metadata.id },
      }),
    );
    provider = new KnowledgeStoreProvider(persistence, {
      stationHome: home,
      authorize: () => 'allowed',
    });
    expect(
      provider.observeExactRecord('root:fixture', 'alias', authority),
    ).toEqual({ state: 'missing' });
    expect(
      provider.observeExactRecord('root:fixture', 'record-123', authority),
    ).toEqual({ state: 'missing' });
  });

  test.each(['kit-obsidian-store', 'plugin-custom', 'conversation-store'])(
    'unsupported adapter %s never invokes its create hook',
    (adapterId) => {
      writeRegistry([{ ...rootDefinition, adapterId }]);
      const create = vi.fn(() => {
        throw new Error('must not create');
      });
      if (adapterId === 'plugin-custom')
        provider.registerAdapter({
          id: adapterId,
          displayName: adapterId,
          create,
        });
      expect(observe()).toEqual({ state: 'unsupported' });
      expect(create).not.toHaveBeenCalled();
    },
  );

  test.each(['prepared', 'committed', 'invalid JSON'])(
    'refuses journal %s without opening, repairing or removing it',
    (phase) => {
      const journal = join(root, '.station-knowledge-transaction.json');
      fs.writeFileSync(journal, phase);
      const open = vi.spyOn(fs, 'openSync');
      expect(observe()).toEqual({ state: 'busy' });
      expect(
        open.mock.calls.some(
          ([path]) => path === journal || path === recordPath,
        ),
      ).toBe(false);
      expect(fs.readFileSync(journal, 'utf8')).toBe(phase);
    },
  );

  test.each(['legacy', 'current'])(
    'refuses a %s lock without reading owner metadata or probing liveness',
    (kind) => {
      let lock = join(root, '.station-knowledge-mutation');
      if (kind === 'current') {
        const info = fs.lstatSync(root);
        const identity = createHash('sha256')
          .update(`${root}\0${info.dev}\0${info.ino}`)
          .digest('hex');
        const directory = join(
          home,
          'coordination',
          'knowledge-file-transactions',
        );
        fs.mkdirSync(directory, { recursive: true });
        lock = join(directory, `${identity}.lock`);
      }
      fs.writeFileSync(lock, 'not owner JSON');
      const open = vi.spyOn(fs, 'openSync');
      const kill = vi.spyOn(process, 'kill');
      expect(observe()).toEqual({ state: 'busy' });
      expect(open.mock.calls.some(([path]) => path === lock)).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    },
  );

  test.each(['registry', 'record', 'journal'])(
    'refuses %s changed at the final authorization boundary',
    (what) => {
      let count = 0;
      provider = new KnowledgeStoreProvider(persistence, {
        stationHome: home,
        authorize: () => {
          if (++count === 3) {
            if (what === 'registry') writeRegistry([]);
            if (what === 'record') writeRecord({}, 'Changed concurrently');
            if (what === 'journal')
              fs.writeFileSync(
                join(root, '.station-knowledge-transaction.json'),
                'pending',
              );
          }
          return 'allowed';
        },
      });
      expect(observe()).toEqual({
        state: what === 'journal' ? 'busy' : 'unavailable',
      });
    },
  );

  test('registry replacement of the same id to another root is not published', () => {
    let count = 0;
    provider = new KnowledgeStoreProvider(persistence, {
      stationHome: home,
      authorize: () => {
        if (++count === 3)
          writeRegistry([{ ...rootDefinition, storeRoot: fixture }]);
        return 'allowed';
      },
    });
    expect(observe()).toEqual({ state: 'unavailable' });
  });

  test.each(['leaf', 'records', 'root', 'registry'])(
    'refuses symlinked %s',
    (where) => {
      const path =
        where === 'leaf'
          ? recordPath
          : where === 'records'
            ? join(root, 'records')
            : where === 'root'
              ? root
              : registryPath;
      fs.renameSync(path, `${path}.saved`);
      fs.symlinkSync(`${path}.saved`, path);
      expect(observe()).toEqual({ state: 'unavailable' });
    },
  );

  test.each(['record', 'registry'])('refuses hardlinked %s', (where) => {
    fs.linkSync(
      where === 'record' ? recordPath : registryPath,
      join(fixture, 'second-name'),
    );
    expect(observe()).toEqual({ state: 'unavailable' });
  });

  test('reaches the exact open boundary and refuses a leaf swap before reading it', () => {
    const nativeOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
      if (path === recordPath) {
        fs.renameSync(recordPath, `${recordPath}.old`);
        writeRecord({}, 'wrong-generation');
      }
      return nativeOpen(path, flags, mode);
    });
    expect(observe()).toEqual({ state: 'unavailable' });
  });

  test.each(['id', 'provenance', 'status-array'])(
    'refuses invalid authoritative %s',
    (field) => {
      writeRecord(
        field === 'id'
          ? { id: 'another' }
          : field === 'provenance'
            ? { provenance: {} }
            : { status: ['active'] },
      );
      expect(observe()).toEqual({ state: 'corrupt' });
    },
  );

  test.each([
    'record-bytes',
    'frontmatter-bytes',
    'registry-bytes',
    'registry-count',
    'nested-yaml',
    'aliases',
    'cyclic-alias',
  ])('bounds %s without a partial success', (kind) => {
    if (kind === 'record-bytes')
      fs.writeFileSync(recordPath, 'a'.repeat(256 * 1024 + 1));
    if (kind === 'frontmatter-bytes')
      writeRecord({ title: 'a'.repeat(64 * 1024) });
    if (kind === 'registry-bytes')
      fs.writeFileSync(registryPath, ' '.repeat(1024 * 1024 + 1));
    if (kind === 'registry-count')
      writeRegistry(
        Array.from({ length: 1025 }, (_, i) => ({
          ...rootDefinition,
          id: `root:${i}`,
        })),
      );
    if (kind === 'nested-yaml')
      fs.writeFileSync(
        recordPath,
        `---\na: ${'['.repeat(1000)}0${']'.repeat(1000)}\n---\nbody`,
      );
    if (kind === 'aliases')
      fs.writeFileSync(recordPath, '---\na: &one [x]\nb: *one\n---\nbody');
    if (kind === 'cyclic-alias')
      fs.writeFileSync(recordPath, '---\na: &one [*one]\n---\nbody');
    expect(observe()).toEqual({
      state: ['nested-yaml', 'aliases', 'cyclic-alias'].includes(kind)
        ? 'corrupt'
        : 'over-budget',
    });
  });

  test.each(['missing', 'corrupt', 'duplicate'])(
    'handles %s root registry explicitly',
    (kind) => {
      if (kind === 'missing') fs.unlinkSync(registryPath);
      if (kind === 'corrupt') fs.writeFileSync(registryPath, '{');
      if (kind === 'duplicate') writeRegistry([rootDefinition, rootDefinition]);
      expect(observe()).toEqual({
        state: kind === 'missing' ? 'missing' : 'corrupt',
      });
    },
  );

  test('missing records directory remains missing and is never bootstrapped', () => {
    fs.rmSync(join(root, 'records'), { recursive: true });
    expect(observe()).toEqual({ state: 'unavailable' });
    expect(fs.existsSync(join(root, 'records'))).toBe(false);
  });
});
