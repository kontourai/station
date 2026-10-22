import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type CreateInput,
  type KitRecord,
  KNOWLEDGE_DOCUMENT_BATCH_MAX_BYTES,
  KNOWLEDGE_DOCUMENT_BATCH_MAX_FILES,
  KNOWLEDGE_DOCUMENT_MAX_BYTES,
  type KnowledgeDocumentImportInput,
  type KnowledgeDocumentImportReceipt,
  type KnowledgeStoreAdapter,
  type KnowledgeStoreProvider,
  type KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';
import { parseKnowledgeStoreRoots } from '../../domain/file-storage-schemas.js';
import { withKnowledgeWriteAuthority } from '../../knowledge-store/knowledge-write-authority.js';
import { JsonFileStore } from '../infra/json-store.js';

const maxBase64Length = 4 * Math.ceil(KNOWLEDGE_DOCUMENT_MAX_BYTES / 3);
const documentSchema = z
  .object({
    filename: z.string().min(1).max(240),
    contentBase64: z.string().max(maxBase64Length),
  })
  .strict();
const requestSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedRoot: z.unknown(),
    documents: z
      .array(documentSchema)
      .min(1)
      .max(KNOWLEDGE_DOCUMENT_BATCH_MAX_FILES),
    retryUncertain: z.boolean().optional(),
  })
  .strict();
const fileSchema = documentSchema.extend({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(1).max(KNOWLEDGE_DOCUMENT_MAX_BYTES),
});
const storedSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedRoot: z.unknown(),
    documents: z
      .array(fileSchema)
      .min(1)
      .max(KNOWLEDGE_DOCUMENT_BATCH_MAX_FILES),
    actorId: z.string().min(1).max(500),
    createdAt: z.string().datetime(),
    states: z
      .array(z.enum(['pending', 'creating', 'imported']))
      .min(1)
      .max(KNOWLEDGE_DOCUMENT_BATCH_MAX_FILES),
  })
  .strict();
type ImportedFile = z.infer<typeof fileSchema>;
interface ImportRecord
  extends Omit<z.infer<typeof storedSchema>, 'expectedRoot'> {
  expectedRoot: KnowledgeStoreRoot;
}
export interface KnowledgeImportAuthority {
  actorId: string;
  assertCurrent: () => void;
}
export class KnowledgeDocumentImportError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 503,
  ) {
    super(message);
  }
}

function decodeDocument(input: z.infer<typeof documentSchema>): {
  file: ImportedFile;
  text: string;
  bytes: Buffer;
} {
  if (
    !/\.(md|markdown|txt)$/i.test(input.filename) ||
    /[/\\\r\n\0]/.test(input.filename)
  )
    throw new KnowledgeDocumentImportError(
      'Choose a Markdown or plain-text filename without path separators.',
      400,
    );
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (
    bytes.toString('base64') !== input.contentBase64 ||
    bytes.length === 0 ||
    bytes.length > KNOWLEDGE_DOCUMENT_MAX_BYTES
  )
    throw new KnowledgeDocumentImportError(
      'A document must contain at most 256 KiB of canonical UTF-8 text.',
      400,
    );
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new KnowledgeDocumentImportError(
      'This document is not valid UTF-8 text.',
      400,
    );
  }
  if (!text.trim() || text.includes('\0'))
    throw new KnowledgeDocumentImportError(
      'Empty or binary documents are not supported.',
      400,
    );
  return {
    bytes,
    text,
    file: {
      ...input,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}
function parseRoot(value: unknown): KnowledgeStoreRoot {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 16384)
    throw new KnowledgeDocumentImportError(
      'Source reference exceeds the import limit.',
      400,
    );
  const root = parseKnowledgeStoreRoots([value])[0];
  if (
    root?.scope.kind !== 'project' ||
    !root.projectId ||
    !root.registrationId ||
    root.adapterId !== 'kit-default-store'
  )
    throw new KnowledgeDocumentImportError(
      'Select a current Project registration using the default store format.',
      400,
    );
  return root;
}
function validateBatch(files: ImportedFile[]): void {
  if (
    files.reduce((sum, file) => sum + file.bytes, 0) >
    KNOWLEDGE_DOCUMENT_BATCH_MAX_BYTES
  )
    throw new KnowledgeDocumentImportError(
      'A document selection must not exceed 1 MiB in total.',
      400,
    );
  if (
    new Set(files.map((file) => `${file.filename}\0${file.sha256}`)).size !==
    files.length
  )
    throw new KnowledgeDocumentImportError(
      'Select each identical document only once.',
      400,
    );
}
function recordId(requestId: string, index: number): string {
  return `document-${requestId}-${index}`;
}
function originalRoute(
  rootId: string,
  requestId: string,
  index: number,
): string {
  return `/api/knowledge/roots/${encodeURIComponent(rootId)}/document-imports/${requestId}/originals/${index}`;
}
function recordInput(record: ImportRecord, index: number): CreateInput {
  const file = record.documents[index];
  if (!file)
    throw new KnowledgeDocumentImportError(
      'Import document is unavailable.',
      404,
    );
  const text = decodeDocument(file).text;
  return {
    id: recordId(record.requestId, index),
    type: 'raw',
    title: file.filename,
    category: 'source-document',
    body: `Imported document: ${JSON.stringify(file.filename)}\nOriginal SHA-256: ${file.sha256}\n\n--- BEGIN ORIGINAL TEXT ---\n${text}\n--- END ORIGINAL TEXT ---`,
    provenance: {
      agent: 'station.document-import',
      note: JSON.stringify({
        kind: 'document-import',
        requestId: record.requestId,
        registrationId: record.expectedRoot.registrationId,
        projectId: record.expectedRoot.projectId,
        filename: file.filename,
        bytes: file.bytes,
        sha256: file.sha256,
        requestedBy: record.actorId,
        original: originalRoute(
          record.expectedRoot.id,
          record.requestId,
          index,
        ),
      }),
    },
  };
}
function matches(record: KitRecord, expected: CreateInput): boolean {
  return (
    record.id === expected.id &&
    record.type === expected.type &&
    record.title === expected.title &&
    record.category === expected.category &&
    record.body === expected.body &&
    record.status !== 'retired' &&
    isDeepStrictEqual(record.provenance, expected.provenance)
  );
}

/** Originals and exact intent precede record publication. Unknown effects require explicit retry. */
export class KnowledgeDocumentImportService {
  private readonly directory: string;
  constructor(
    homeDir: string,
    private readonly store: KnowledgeStoreProvider,
  ) {
    this.directory = join(homeDir, 'knowledge-document-imports');
  }
  private receiptFile(id: string) {
    z.string().uuid().parse(id);
    return new JsonFileStore<ImportRecord | null>(
      join(this.directory, id, 'operation.json'),
      null,
      {
        onCorruption: 'throw',
        durableAtomicWrite: true,
        maxReadBytes: 2 * 1024 * 1024,
      },
    );
  }
  private read(id: string): ImportRecord | null {
    z.string().uuid().parse(id);
    try {
      return this.readSaved(id);
    } catch {
      throw new KnowledgeDocumentImportError(
        'Saved import is unreadable. Retained originals need recovery before continuing.',
        503,
      );
    }
  }
  private readSaved(id: string): ImportRecord | null {
    const value = this.receiptFile(id).read();
    if (value === null) return null;
    const parsed = storedSchema.parse(value);
    if (
      parsed.requestId !== id ||
      parsed.documents.length !== parsed.states.length
    )
      throw new KnowledgeDocumentImportError(
        'Import receipt does not match its request.',
        503,
      );
    const expectedRoot = parseRoot(parsed.expectedRoot);
    for (const file of parsed.documents)
      if (!isDeepStrictEqual(file, decodeDocument(file).file))
        throw new KnowledgeDocumentImportError(
          'Retained original bytes do not match their receipt.',
          503,
        );
    validateBatch(parsed.documents);
    return { ...parsed, expectedRoot };
  }
  private async pinned<T>(
    root: KnowledgeStoreRoot,
    operation: (adapter: KnowledgeStoreAdapter) => Promise<T>,
  ): Promise<T> {
    if (!this.store.withRootRevision)
      throw new KnowledgeDocumentImportError(
        'Document import needs registration locking on this Station.',
        503,
      );
    return this.store.withRootRevision(root, operation);
  }
  private async observe(
    record: ImportRecord,
    adapter: KnowledgeStoreAdapter,
  ): Promise<KnowledgeDocumentImportReceipt> {
    const documents: KnowledgeDocumentImportReceipt['documents'] = [];
    for (let index = 0; index < record.documents.length; index += 1) {
      const file = record.documents[index]!;
      const expected = recordInput(record, index);
      const found = await adapter.get(expected.id!);
      const phase = found
        ? matches(found, expected)
          ? 'imported'
          : 'unavailable'
        : record.states[index] === 'imported'
          ? 'unavailable'
          : record.states[index] === 'creating'
            ? 'uncertain'
            : 'pending';
      documents.push({
        filename: file.filename,
        bytes: file.bytes,
        sha256: file.sha256,
        recordId: expected.id!,
        phase,
        originalAvailable: true,
      });
    }
    const phase = documents.every((file) => file.phase === 'imported')
      ? 'imported'
      : documents.some((file) => file.phase === 'unavailable')
        ? 'unavailable'
        : documents.some((file) => file.phase === 'imported')
          ? 'partial'
          : documents.some((file) => file.phase === 'uncertain')
            ? 'uncertain'
            : 'pending';
    return {
      requestId: record.requestId,
      rootId: record.expectedRoot.id,
      registrationId: record.expectedRoot.registrationId!,
      phase,
      documents,
    };
  }
  async get(
    rootId: string,
    requestId: string,
    assertCurrent: () => void = () => {},
  ): Promise<{
    root: KnowledgeStoreRoot;
    receipt: KnowledgeDocumentImportReceipt;
  } | null> {
    assertCurrent();
    if (!this.read(requestId)) return null;
    const release = await acquireFileMutationLockAsync(
      join(this.directory, requestId, 'operation.mutation'),
    );
    try {
      assertCurrent();
      const record = this.read(requestId);
      if (!record || record.expectedRoot.id !== rootId) return null;
      const receipt = await this.pinned(
        record.expectedRoot,
        async (adapter) => {
          const observed = await this.observe(record, adapter);
          let changed = false;
          observed.documents.forEach((file, index) => {
            if (
              file.phase === 'imported' &&
              record.states[index] !== 'imported'
            ) {
              record.states[index] = 'imported';
              changed = true;
            }
          });
          if (changed) {
            assertCurrent();
            this.receiptFile(requestId).write(record);
          }
          return observed;
        },
      );
      return { root: record.expectedRoot, receipt };
    } finally {
      await release();
    }
  }
  async original(
    rootId: string,
    requestId: string,
    index: number,
  ): Promise<{
    root: KnowledgeStoreRoot;
    filename: string;
    bytes: Uint8Array;
  } | null> {
    const record = this.read(requestId);
    const file = record?.documents[index];
    if (
      !record ||
      record.expectedRoot.id !== rootId ||
      !Number.isInteger(index) ||
      !file
    )
      return null;
    return this.pinned(record.expectedRoot, async () => ({
      root: record.expectedRoot,
      filename: file.filename,
      bytes: new Uint8Array(decodeDocument(file).bytes),
    }));
  }
  async resume(
    root: unknown,
    requestId: string,
    retryUncertain: boolean,
    authority: KnowledgeImportAuthority,
  ): Promise<KnowledgeDocumentImportReceipt> {
    const expectedRoot = parseRoot(root);
    const record = this.read(requestId);
    if (!record || record.expectedRoot.id !== expectedRoot.id)
      throw new KnowledgeDocumentImportError(
        'Saved import was not found.',
        404,
      );
    return this.import(
      {
        requestId,
        expectedRoot,
        documents: record.documents.map(({ filename, contentBase64 }) => ({
          filename,
          contentBase64,
        })),
        retryUncertain,
      },
      authority,
    );
  }
  async import(
    raw: KnowledgeDocumentImportInput,
    authority: KnowledgeImportAuthority,
  ): Promise<KnowledgeDocumentImportReceipt> {
    const input = requestSchema.parse(raw);
    const expectedRoot = parseRoot(input.expectedRoot);
    const documents = input.documents.map(
      (document) => decodeDocument(document).file,
    );
    validateBatch(documents);
    const actorId = authority.actorId;
    const check = authority.assertCurrent.bind(authority);
    const deadline = Date.now() + 20000;
    const assertCurrent = () => {
      check();
      if (Date.now() > deadline)
        throw new KnowledgeDocumentImportError(
          'Import paused at its time limit. Check the saved import before continuing.',
          503,
        );
    };
    assertCurrent();
    const directory = join(this.directory, input.requestId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const release = await acquireFileMutationLockAsync(
      join(directory, 'operation.mutation'),
    );
    try {
      assertCurrent();
      const prior = this.read(input.requestId);
      if (
        prior &&
        (!isDeepStrictEqual(prior.expectedRoot, expectedRoot) ||
          !isDeepStrictEqual(prior.documents, documents))
      )
        throw new KnowledgeDocumentImportError(
          'This import request already names different documents or a different registration.',
          409,
        );
      return await withKnowledgeWriteAuthority(
        expectedRoot.storeRoot,
        assertCurrent,
        () =>
          this.pinned(expectedRoot, async (adapter) => {
            assertCurrent();
            const record: ImportRecord = prior ?? {
              requestId: input.requestId,
              expectedRoot,
              documents,
              actorId,
              createdAt: new Date().toISOString(),
              states: documents.map(() => 'pending'),
            };
            const save = () => {
              assertCurrent();
              this.receiptFile(record.requestId).write(record);
            };
            if (!prior) save();
            let snapshot = await this.observe(record, adapter);
            let reconciled = false;
            snapshot.documents.forEach((file, index) => {
              if (
                file.phase === 'imported' &&
                record.states[index] !== 'imported'
              ) {
                record.states[index] = 'imported';
                reconciled = true;
              }
            });
            if (reconciled) save();
            for (let index = 0; index < documents.length; index += 1) {
              const observed = snapshot.documents[index];
              if (
                snapshot.documents.some((file) => file.phase === 'unavailable')
              )
                return snapshot;
              if (observed?.phase === 'uncertain' && !input.retryUncertain)
                return snapshot;
              if (observed?.phase === 'imported') continue;
              record.states[index] = 'creating';
              save();
              await adapter.create(recordInput(record, index));
              record.states[index] = 'imported';
              save();
              snapshot = await this.observe(record, adapter);
            }
            return snapshot;
          }),
      );
    } finally {
      await release();
    }
  }
}
