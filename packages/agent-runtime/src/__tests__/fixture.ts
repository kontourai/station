import { randomUUID } from 'node:crypto';
import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AtomicParticipant } from '@kontourai/monument/testing';
import { requestBytes } from '../ai-sdk.js';
import {
  commandDigest,
  DEFAULT_MODEL_POLICY,
  type ImplementationBinding,
  ModelMemoryVolume,
  type ModelProtocol,
  type ModelStorage,
  openMemoryModelStorage,
  type Refused,
} from '../index.js';
import { openSqliteModelStorage, openSqliteRuntimeBodies } from '../sqlite.js';
import { captureVoltEntry } from '../voltagent.js';

const binding: ImplementationBinding = {
  framework: 'voltagent',
  frameworkVersion: '2.10.0',
  adapterDigest: `sha256:${'a'.repeat(64)}`,
  modelImplementationDigest: `sha256:${'b'.repeat(64)}`,
  connectionId: 'scripted',
  connectionRevision: '1',
  provider: 'scripted',
  modelId: 'text',
  transport: 'ai-sdk-v3-stateless/1',
};
export const key = {
  scopeId: 'scope',
  conversationId: 'conversation',
  invocationId: 'turn',
};
export const owner = {
  id: 'first',
  pid: 123,
  identityKind: 'exact' as const,
  birth: 'original',
};
export const nextOwner = {
  id: 'second',
  pid: 456,
  identityKind: 'exact' as const,
  birth: 'next',
};
export const finish: LanguageModelV3StreamPart = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
};
export const parts: LanguageModelV3StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'a' },
  { type: 'text-delta', id: 'a', delta: 'COMPLETED' },
  { type: 'text-end', id: 'a' },
  finish,
];
export const messages = [
  {
    id: 'user',
    role: 'user' as const,
    parts: [{ type: 'text' as const, text: 'COMPOSED-A' }],
  },
];
export function operation<const T extends object>(fields: T) {
  const command = { ...fields, operationId: randomUUID() };
  return { ...command, digest: commandDigest(command) };
}
export async function fixture(
  kind: 'memory' | 'sqlite' = 'sqlite',
  participants: readonly AtomicParticipant<
    ModelProtocol,
    DatabaseSync,
    Refused
  >[] = [],
) {
  const temporary = mkdtempDisposableSync(join(tmpdir(), 'runtime-journal-'));
  const directory = temporary.path;
  const path = join(directory, 'host.sqlite');
  const database = new DatabaseSync(path);
  database.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;',
  );
  const bodies = openSqliteRuntimeBodies({
    database,
    policy: DEFAULT_MODEL_POLICY,
  });
  const admission = { binding, writerGeneration: 'writer-1' };
  const host = () => admission;
  const volume = new ModelMemoryVolume();
  const open = (
    extra: readonly AtomicParticipant<ModelProtocol, never, Refused>[] = [],
  ): ModelStorage =>
    kind === 'sqlite'
      ? openSqliteModelStorage({
          database,
          host,
          policy: DEFAULT_MODEL_POLICY,
          participants: [...participants, ...extra],
        })
      : openMemoryModelStorage({
          volume,
          bodies,
          host,
          policy: DEFAULT_MODEL_POLICY,
          participants: extra,
        });
  let storage = open();
  const context = { liveness: () => 'live' as const };
  const captured = await captureVoltEntry(bodies, {
    version: 1,
    binding,
    sourceCutoff: 'A',
    authoredDigest: `sha256:${'c'.repeat(64)}`,
    messages,
    generation: {},
    tools: [],
  });
  const opened = await storage.execute(
    operation({
      type: 'open',
      spec: { key, binding, entry: captured.entry },
      owner,
    }),
    context,
  );
  if (opened.kind !== 'opened')
    throw new Error('Fixture could not open real generation');
  const request = await bodies.put(
    'runtime-ai-sdk-v3-request/1',
    requestBytes({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'COMPOSED-A' }] },
      ],
    }),
  );
  const pin = {
    requestId: 'request',
    ordinal: 0,
    entryDigest: captured.entry.body.digest,
    previousResponseDigest: null,
    request,
  };
  return {
    directory,
    path,
    database,
    bodies,
    host,
    admission,
    context,
    captured,
    pin,
    opened,
    open,
    get storage() {
      return storage;
    },
    set storage(value: ModelStorage) {
      storage = value;
    },
    async close() {
      await storage.close();
      await bodies.close();
      database.close();
      temporary.remove();
    },
  };
}
