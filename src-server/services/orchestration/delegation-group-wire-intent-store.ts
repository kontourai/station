import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson } from '@kontourai/relay';
import { publishJsonFileWithOwnedLock } from '@kontourai/station-shared/json-file-storage';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';

export type WireFinalizer = () => undefined;
export class WireIntentRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function assertSynchronous(finalizeCurrent: WireFinalizer): void {
  const result: unknown = finalizeCurrent();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new WireIntentRefusal('wire_finalizer_must_be_synchronous');
  }
}
const id = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}]+$/u);
const integer = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const invocationIdentity = {
  root: z.object({ id, authority_epoch: integer, digest }).strict(),
  envelope: z.object({ id, generation: integer, digest }).strict(),
  executionId: id,
  invocationId: id,
  effect: id,
  allocation: z
    .object({
      inputTokens: integer,
      outputTokens: integer,
      costMicros: integer,
    })
    .strict(),
  executionBindingDigest: digest,
  principalDigest: digest,
  subjectDigest: digest,
  finalWireDigest: digest,
};
const identitySchema = z
  .object({
    groupId: id,
    controller: z.object({ id, generation: integer }).strict(),
    seatId: id,
    ...invocationIdentity,
  })
  .strict();
export type FinalWireIntentIdentity = z.infer<typeof identitySchema>;
const singleIdentitySchema = z
  .object({
    scope: z.literal('single-delegation/v1'),
    ...invocationIdentity,
  })
  .strict();
export type SingleFinalWireIntentIdentity = z.infer<
  typeof singleIdentitySchema
>;
type StoredIdentity = FinalWireIntentIdentity | SingleFinalWireIntentIdentity;
const recordSchema = z
  .object({
    identity: identitySchema,
    state: z.literal('send-intent'),
  })
  .strict();
const legacyLedgerSchema = z
  .object({ version: z.literal(1), records: z.array(recordSchema).max(1024) })
  .strict();
const storedRecordSchema = z
  .object({
    identity: z.union([identitySchema, singleIdentitySchema]),
    state: z.literal('send-intent'),
  })
  .strict();
const ledgerSchema = z.discriminatedUnion('version', [
  legacyLedgerSchema,
  z
    .object({
      version: z.literal(2),
      records: z.array(storedRecordSchema).max(1024),
    })
    .strict(),
]);
type Ledger = {
  version: 1 | 2;
  records: Array<z.infer<typeof storedRecordSchema>>;
};
const MAX_BYTES = 4 * 1024 * 1024;
const key = (
  identity: Pick<FinalWireIntentIdentity, 'root' | 'invocationId'>,
) => canonicalJson([identity.root.id, identity.invocationId]);
export function wireIdentityDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
function checkDirectory(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o700
  )
    throw new WireIntentRefusal('wire_private_directory_required');
}
function flushDirectory(path: string): void {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A durable no-resend fact, not a grant, budget ledger or proof bytes were sent. */
export class FileFinalWireIntentStore {
  readonly root: string;
  readonly #directory: string;
  readonly #file: string;
  constructor(privateRoot: string) {
    const requested = resolve(privateRoot);
    checkDirectory(requested);
    this.root = join(realpathSync(dirname(requested)), basename(requested));
    checkDirectory(this.root);
    this.#directory = join(this.root, 'final-wire-intents');
    this.#file = join(this.#directory, 'intents.json');
  }
  #check(): void {
    checkDirectory(this.root);
    checkDirectory(this.#directory);
  }
  #read(): Ledger {
    let fd: number;
    try {
      fd = openSync(
        this.#file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, records: [] };
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.size > MAX_BYTES
      )
        throw new WireIntentRefusal('wire_unsafe_record');
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= MAX_BYTES) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_BYTES + 1 - total));
        const count = readSync(fd, chunk, 0, chunk.length, null);
        if (!count) break;
        total += count;
        chunks.push(chunk.subarray(0, count));
      }
      if (total > MAX_BYTES)
        throw new WireIntentRefusal('wire_record_too_large');
      const value = ledgerSchema.parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        ),
      );
      if (
        new Set(value.records.map((record) => key(record.identity))).size !==
        value.records.length
      )
        throw new WireIntentRefusal('wire_duplicate_record');
      fsyncSync(fd);
      flushDirectory(this.#directory);
      flushDirectory(this.root);
      return value;
    } finally {
      closeSync(fd);
    }
  }
  async #locked<T>(
    finalizeCurrent: WireFinalizer,
    work: (ledger: Ledger) => Promise<T>,
  ): Promise<T> {
    assertSynchronous(finalizeCurrent);
    checkDirectory(this.root);
    try {
      mkdirSync(this.#directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.#check();
    const release = await acquireFileMutationLockAsync(
      `${this.#file}.mutation`,
    );
    let result: T;
    try {
      this.#check();
      assertSynchronous(finalizeCurrent);
      result = await work(this.#read());
      this.#check();
      flushDirectory(this.#directory);
      flushDirectory(this.root);
      flushDirectory(dirname(this.root));
      assertSynchronous(finalizeCurrent);
    } finally {
      await release();
    }
    assertSynchronous(finalizeCurrent);
    return result;
  }
  async consume(
    identity: FinalWireIntentIdentity,
    finalizeCurrent: WireFinalizer,
  ): Promise<void> {
    return this.#consume(identitySchema.parse(identity), finalizeCurrent);
  }
  async consumeSingle(
    identity: SingleFinalWireIntentIdentity,
    finalizeCurrent: WireFinalizer,
  ): Promise<void> {
    return this.#consume(singleIdentitySchema.parse(identity), finalizeCurrent);
  }
  async #consume(
    snapshot: StoredIdentity,
    finalizeCurrent: WireFinalizer,
  ): Promise<void> {
    return this.#locked(finalizeCurrent, async (ledger) => {
      const existing = ledger.records.find(
        (record) => key(record.identity) === key(snapshot),
      );
      if (existing)
        throw new WireIntentRefusal(
          canonicalJson(existing.identity) === canonicalJson(snapshot)
            ? 'wire_intent_already_consumed'
            : 'wire_intent_conflict',
        );
      if (ledger.records.length >= 1024)
        throw new WireIntentRefusal('wire_intent_capacity');
      if ('scope' in snapshot) ledger.version = 2;
      ledger.records.push({ identity: snapshot, state: 'send-intent' });
      await publishJsonFileWithOwnedLock(this.#file, ledger, {
        indent: null,
        trailingNewline: true,
        maxBytes: MAX_BYTES,
        beforeCommit: () => {
          this.#check();
          assertSynchronous(finalizeCurrent);
        },
        finalizeCommit: () => {
          this.#check();
          assertSynchronous(finalizeCurrent);
          return undefined;
        },
      });
      const retained = this.#read().records.find(
        (record) => key(record.identity) === key(snapshot),
      );
      if (
        !retained ||
        canonicalJson(retained.identity) !== canonicalJson(snapshot)
      )
        throw new WireIntentRefusal('wire_intent_commit_unconfirmed');
    });
  }
  async lookup(
    authorityId: string,
    invocationId: string,
    finalizeCurrent: WireFinalizer,
  ): Promise<FinalWireIntentIdentity | undefined> {
    const identity = await this.#lookup(
      authorityId,
      invocationId,
      finalizeCurrent,
    );
    if (identity && 'scope' in identity)
      throw new WireIntentRefusal('wire_intent_kind_mismatch');
    return identity;
  }
  async lookupSingle(
    authorityId: string,
    invocationId: string,
    finalizeCurrent: WireFinalizer,
  ): Promise<SingleFinalWireIntentIdentity | undefined> {
    const identity = await this.#lookup(
      authorityId,
      invocationId,
      finalizeCurrent,
    );
    if (identity && !('scope' in identity))
      throw new WireIntentRefusal('wire_intent_kind_mismatch');
    return identity;
  }
  async #lookup(
    authorityId: string,
    invocationId: string,
    finalizeCurrent: WireFinalizer,
  ): Promise<StoredIdentity | undefined> {
    id.parse(authorityId);
    id.parse(invocationId);
    return this.#locked(finalizeCurrent, async (ledger) =>
      structuredClone(
        ledger.records.find(
          (record) =>
            record.identity.root.id === authorityId &&
            record.identity.invocationId === invocationId,
        )?.identity,
      ),
    );
  }
}
