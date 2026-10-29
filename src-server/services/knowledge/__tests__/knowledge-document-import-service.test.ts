import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  KnowledgeDocumentImportInput,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { KnowledgeFileTransactions } from '../../../knowledge-store/adapters/shared/file-transactions.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { KnowledgeDocumentImportService } from '../knowledge-document-import-service.js';

const makeTempDir = trackTempDirs();
let home: string;
let provider: KnowledgeStoreProvider;
let root: KnowledgeStoreRoot;
let service: KnowledgeDocumentImportService;
let allowed: boolean;
const authority = {
  actorId: 'human:local:operator',
  assertCurrent: () => {
    if (!allowed) throw new Error('Import authority ended');
  },
};
function request(
  text = '\ufeff\n\nOriginal content\r\n',
  filename = 'research.md',
): KnowledgeDocumentImportInput {
  return {
    requestId: randomUUID(),
    expectedRoot: root,
    documents: [
      { filename, contentBase64: Buffer.from(text).toString('base64') },
    ],
  };
}
beforeEach(async () => {
  home = makeTempDir('station-document-import-');
  vi.stubEnv('STATION_HOME', home);
  mkdirSync(join(home, 'config'), { recursive: true });
  provider = new KnowledgeStoreProvider(new FileStorageAdapter(home));
  root = await provider.createRoot({
    scope: { kind: 'project', projectSlug: 'research' },
    projectId: '11111111-1111-4111-8111-111111111111',
    adapterId: 'kit-default-store',
    storeRoot: join(home, 'store'),
    displayName: 'Research documents',
  });
  service = new KnowledgeDocumentImportService(home, provider);
  allowed = true;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('a real import retains exact original bytes and provenance and resumes the same records after restart', async () => {
  const input = request();
  const result = await service.import(input, authority);
  expect(result.phase).toBe('imported');
  const original = Buffer.from(input.documents[0]!.contentBase64, 'base64');
  expect(result.documents[0]?.sha256).toBe(
    createHash('sha256').update(original).digest('hex'),
  );
  const record = await (await provider.adapterFor(root.id)).get(
    result.documents[0]!.recordId,
  );
  expect(record?.body).toContain('\ufeff\n\nOriginal content\r\n');
  expect(JSON.parse(record!.provenance.note!)).toMatchObject({
    filename: 'research.md',
    registrationId: root.registrationId,
    projectId: root.projectId,
    requestedBy: 'human:local:operator',
    sha256: result.documents[0]?.sha256,
  });
  const restarted = new KnowledgeDocumentImportService(
    home,
    new KnowledgeStoreProvider(new FileStorageAdapter(home)),
  );
  expect(await restarted.import(input, authority)).toEqual(result);
  expect(
    (await (await provider.adapterFor(root.id)).listByType('raw')).map(
      (record) => record.id,
    ),
  ).toEqual([result.documents[0]!.recordId]);
  const download = await restarted.original(root.id, input.requestId, 0);
  expect(Buffer.from(download!.bytes)).toEqual(original);
  expect((await restarted.get(root.id, input.requestId))?.receipt).toEqual(
    result,
  );
});

test('an unknown non-publication is held until explicit retry rather than replayed on reload', async () => {
  const input = request();
  const adapter = await provider.adapterFor(root.id);
  const create = vi
    .spyOn(adapter, 'create')
    .mockRejectedValueOnce(new Error('Lost before record publication'));
  await expect(service.import(input, authority)).rejects.toThrow(
    'Lost before record publication',
  );
  const held = await new KnowledgeDocumentImportService(home, provider).import(
    input,
    authority,
  );
  expect(held.phase).toBe('uncertain');
  expect(create).toHaveBeenCalledTimes(1);
  const retried = await service.resume(root, input.requestId, true, authority);
  expect(retried.phase).toBe('imported');
  expect(retried.documents[0]?.recordId).toBe(held.documents[0]?.recordId);
  expect(create).toHaveBeenCalledTimes(2);
});

test('a lost publication acknowledgement is reconciled durably and a later deleted record is never resurrected', async () => {
  const input = request();
  const adapter = await provider.adapterFor(root.id);
  const create = adapter.create.bind(adapter);
  vi.spyOn(adapter, 'create').mockImplementationOnce(async (record) => {
    await create(record);
    throw new Error('Lost after publication');
  });
  await expect(service.import(input, authority)).rejects.toThrow(
    'Lost after publication',
  );
  const checked = await service.get(root.id, input.requestId);
  expect(checked?.receipt.phase).toBe('imported');
  const id = checked!.receipt.documents[0]!.recordId;
  unlinkSync(join(root.storeRoot, 'records', `${id}.md`));
  const result = await service.resume(root, input.requestId, true, authority);
  expect(result.phase).toBe('unavailable');
  expect(existsSync(join(root.storeRoot, 'records', `${id}.md`))).toBe(false);
  expect(
    Buffer.from((await service.original(root.id, input.requestId, 0))!.bytes),
  ).toEqual(Buffer.from(input.documents[0]!.contentBase64, 'base64'));
});

test('changed selection or registration cannot reuse an import identity', async () => {
  const input = request();
  await service.import(input, authority);
  await expect(
    service.import(
      { ...input, documents: request('Different bytes').documents },
      authority,
    ),
  ).rejects.toThrow('different documents');
  await provider.removeRoot(root.id, root);
  const replacement = await provider.createRoot({
    scope: root.scope,
    projectId: root.projectId,
    adapterId: root.adapterId,
    storeRoot: root.storeRoot,
    displayName: root.displayName,
  });
  expect(replacement.id).toBe(root.id);
  await expect(service.import(input, authority)).rejects.toThrow(
    'registration changed',
  );
  await expect(service.get(root.id, input.requestId)).rejects.toThrow(
    'registration changed',
  );
});

test.each([
  { filename: 'binary.png', bytes: Buffer.from('image') },
  { filename: 'invalid.txt', bytes: Buffer.from([255]) },
  { filename: 'large.txt', bytes: Buffer.alloc(262145, 65) },
])(
  'unsupported or oversized $filename is refused before a durable import is created',
  async ({ filename, bytes }) => {
    const input = request();
    input.documents = [{ filename, contentBase64: bytes.toString('base64') }];
    await expect(service.import(input, authority)).rejects.toThrow();
    expect(
      existsSync(
        join(
          home,
          'knowledge-document-imports',
          input.requestId,
          'operation.json',
        ),
      ),
    ).toBe(false);
  },
);

test('aggregate bytes and file count are bounded before effect', async () => {
  const input = request();
  const encoded = Buffer.alloc(262144, 65).toString('base64');
  input.documents = Array.from({ length: 5 }, (_, index) => ({
    filename: `${index}.txt`,
    contentBase64: encoded,
  }));
  await expect(service.import(input, authority)).rejects.toThrow('1 MiB');
  input.documents = Array.from({ length: 9 }, (_, index) => ({
    filename: `${index}.txt`,
    contentBase64: Buffer.from('text').toString('base64'),
  }));
  await expect(service.import(input, authority)).rejects.toThrow();
  expect(
    existsSync(
      join(
        home,
        'knowledge-document-imports',
        input.requestId,
        'operation.json',
      ),
    ),
  ).toBe(false);
});

test('revocation while waiting for the registry lock cannot create a receipt or record', async () => {
  const input = request();
  const release = await acquireFileMutationLockAsync(
    join(home, 'config', 'knowledge-store-roots.json.mutation'),
  );
  const check = vi.fn(authority.assertCurrent);
  const running = service.import(input, { ...authority, assertCurrent: check });
  const outcome = expect(running).rejects.toThrow('Import authority ended');
  try {
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    allowed = false;
  } finally {
    await release();
  }
  await outcome;
  expect(
    existsSync(
      join(
        home,
        'knowledge-document-imports',
        input.requestId,
        'operation.json',
      ),
    ),
  ).toBe(false);
  expect(existsSync(join(root.storeRoot, 'records'))).toBe(false);
});

test('revocation while waiting for the actual record lock prevents publication after a durable intent', async () => {
  const input = request();
  const adapter = await provider.adapterFor(root.id);
  const transactions = new KnowledgeFileTransactions(root.storeRoot);
  const create = adapter.create.bind(adapter);
  let beginHold!: () => void;
  let locked!: () => void;
  let release!: () => void;
  const createEntered = new Promise<void>((resolve) => {
    beginHold = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // This independent writer is registered outside the import's authority context.
  const holding = createEntered.then(() =>
    transactions.mutate('held external writer', async () => {
      locked();
      await held;
    }),
  );
  vi.spyOn(adapter, 'create').mockImplementationOnce(async (record) => {
    beginHold();
    await ready;
    return create(record);
  });
  const outcome = service.import(input, authority).catch((error) => error);
  try {
    await ready;
    const operation = JSON.parse(
      readFileSync(
        join(
          home,
          'knowledge-document-imports',
          input.requestId,
          'operation.json',
        ),
        'utf8',
      ),
    );
    expect(operation.states).toEqual(['creating']);
    allowed = false;
  } finally {
    release();
    await holding;
  }
  expect(await outcome).toMatchObject({
    name: 'Error',
    message: 'Import authority ended',
  });
  expect(await adapter.listByType('raw')).toEqual([]);
  expect((await service.get(root.id, input.requestId))?.receipt.phase).toBe(
    'uncertain',
  );
});

test('receipt observation cannot repair store files after authority ends while waiting for the record lock', async () => {
  const input = request();
  await service.import(input, authority);
  const adapter = await provider.adapterFor(root.id);
  const aliasPath = join(root.storeRoot, 'alias-index.json');
  unlinkSync(aliasPath);
  let locked!: () => void;
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const holding = new KnowledgeFileTransactions(root.storeRoot).mutate(
    'external writer',
    async () => {
      locked();
      await held;
    },
  );
  await ready;
  const get = adapter.get.bind(adapter);
  vi.spyOn(adapter, 'get').mockImplementationOnce((id) => {
    entered();
    return get(id);
  });
  const outcome = service
    .get(root.id, input.requestId, authority.assertCurrent)
    .catch((error) => error);
  try {
    await reading;
    allowed = false;
  } finally {
    release();
    await holding;
  }
  expect(await outcome).toMatchObject({ message: 'Import authority ended' });
  expect(existsSync(aliasPath)).toBe(false);
  allowed = true;
  expect(
    (await service.get(root.id, input.requestId, authority.assertCurrent))
      ?.receipt.phase,
  ).toBe('imported');
  expect(existsSync(aliasPath)).toBe(true);
});
