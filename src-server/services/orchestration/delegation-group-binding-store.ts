import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { publishJsonFileWithOwnedLock } from '@kontourai/station-shared/json-file-storage';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';

const id = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}]+$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const generation = z.number().int().nonnegative().safe();
const scopeSchema = z
  .object({ hostId: id, principalId: id, tenantId: id.nullable() })
  .strict();
const bindingSchema = z
  .object({
    scope: scopeSchema,
    groupId: id,
    seatId: id,
    controllerId: id,
    controllerGeneration: generation,
    authorityId: id,
    authorityEpoch: generation,
    authorityDigest: digest,
    envelopeId: id,
    envelopeGeneration: generation,
    envelopeDigest: digest,
    taskId: id,
    conversationId: id,
    sessionId: id,
    clientTurnId: id,
    invocationId: id,
  })
  .strict();
const recordSchema = z
  .object({
    binding: bindingSchema,
    operationId: id,
    intentDigest: digest,
    ownerVerifier: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().positive().safe(),
    state: z.enum([
      'reserved',
      'launch-intent',
      'session-started',
      'turn-accepted',
      'observed',
    ]),
    providerTurnId: id.nullable(),
    observationRef: digest.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    const accepted =
      record.state === 'turn-accepted' || record.state === 'observed';
    if (
      accepted !== (record.providerTurnId !== null) ||
      (record.state === 'observed') !== (record.observationRef !== null)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Group binding evidence does not match its state',
      });
  });
const ledgerSchema = z
  .object({ version: z.literal(1), records: z.array(recordSchema).max(4096) })
  .strict();

export type DelegationGroupBindingScope = z.infer<typeof scopeSchema>;
export type DelegationGroupBinding = z.infer<typeof bindingSchema>;
export type DelegationGroupBindingRecord = Omit<
  z.infer<typeof recordSchema>,
  'ownerVerifier'
>;
export type ReserveDelegationGroupBindingOutcome =
  | {
      kind: 'created';
      record: DelegationGroupBindingRecord;
      ownerToken: string;
    }
  | { kind: 'existing'; record: DelegationGroupBindingRecord };
type StoredRecord = z.infer<typeof recordSchema>;
type Ledger = z.infer<typeof ledgerSchema>;

export class DelegationGroupBindingError extends Error {
  constructor(readonly code: string) {
    super(`Delegation group binding refused: ${code}`);
    this.name = 'DelegationGroupBindingError';
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function delegationGroupBindingKey(
  binding: DelegationGroupBinding,
): string {
  const parsed = bindingSchema.parse(binding);
  return JSON.stringify([
    parsed.scope.hostId,
    parsed.scope.tenantId,
    parsed.scope.principalId,
    parsed.groupId,
    parsed.seatId,
    parsed.sessionId,
    parsed.clientTurnId,
  ]);
}

function project(record: StoredRecord): DelegationGroupBindingRecord {
  const { ownerVerifier: _ownerVerifier, ...result } = record;
  return structuredClone(result);
}

function verifier(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function validateLedger(value: unknown): Ledger {
  const ledger = ledgerSchema.parse(value);
  const keys = new Set<string>();
  const operations = new Set<string>();
  const turns = new Set<string>();
  const invocations = new Set<string>();
  const authorityGroups = new Map<string, string>();
  const seats = new Map<string, string>();
  const sessions = new Map<string, string>();
  for (const record of ledger.records) {
    const b = record.binding;
    const scope = JSON.stringify(b.scope);
    const physicalScope = JSON.stringify([b.scope.hostId, b.scope.tenantId]);
    for (const [set, key] of [
      [keys, delegationGroupBindingKey(b)],
      [operations, JSON.stringify([scope, record.operationId])],
      [turns, JSON.stringify([physicalScope, b.sessionId, b.clientTurnId])],
      [invocations, JSON.stringify([physicalScope, b.invocationId])],
    ] as const) {
      if (set.has(key))
        throw new DelegationGroupBindingError('duplicate_binding');
      set.add(key);
    }
    const authorityKey = JSON.stringify([b.scope.hostId, b.authorityId]);
    const custody = JSON.stringify([scope, b.groupId]);
    if (
      authorityGroups.has(authorityKey) &&
      authorityGroups.get(authorityKey) !== custody
    )
      throw new DelegationGroupBindingError('authority_already_bound');
    authorityGroups.set(authorityKey, custody);
    const seatKey = JSON.stringify([scope, b.groupId, b.seatId]);
    const membership = JSON.stringify([
      b.controllerId,
      b.controllerGeneration,
      b.authorityId,
      b.authorityEpoch,
      b.authorityDigest,
      b.envelopeId,
      b.envelopeGeneration,
      b.envelopeDigest,
      b.taskId,
      b.conversationId,
    ]);
    if (seats.has(seatKey) && seats.get(seatKey) !== membership)
      throw new DelegationGroupBindingError('seat_membership_conflict');
    seats.set(seatKey, membership);
    const sessionKey = JSON.stringify([physicalScope, b.sessionId]);
    const sessionMembership = JSON.stringify([
      scope,
      b.groupId,
      b.seatId,
      membership,
    ]);
    if (
      sessions.has(sessionKey) &&
      sessions.get(sessionKey) !== sessionMembership
    )
      throw new DelegationGroupBindingError('session_membership_conflict');
    sessions.set(sessionKey, sessionMembership);
  }
  return ledger;
}

/**
 * Host-internal identity and launch intent. Scope fields are lookup coordinates,
 * not caller authentication. The service host authenticates access. Cooperative
 * local storage cannot exclude a hostile process running as the same uid.
 */
export class FileDelegationGroupBindingStore {
  readonly #file: string;
  readonly #root: string;
  readonly #capacity: number;
  static readonly maxBytes = 8 * 1024 * 1024;

  constructor(dataDir: string, options: { capacity?: number } = {}) {
    this.#root = join(dataDir, 'delegation-group-bindings');
    this.#file = join(this.#root, 'bindings.json');
    this.#capacity = z
      .number()
      .int()
      .min(1)
      .max(4096)
      .parse(options.capacity ?? 1024);
  }

  #directory(): void {
    mkdirSync(this.#root, { mode: 0o700 });
  }

  #checkDirectory(): void {
    const stat = lstatSync(this.#root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      process.getuid?.() !== stat.uid ||
      (stat.mode & 0o7777) !== 0o700
    )
      throw new DelegationGroupBindingError('private_storage_required');
  }

  #flushDirectory(path: string): void {
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
        process.getuid?.() !== stat.uid ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.size > FileDelegationGroupBindingStore.maxBytes
      )
        throw new DelegationGroupBindingError('unsafe_storage');
      fsyncSync(fd);
      this.#flushDirectory(this.#root);
      this.#flushDirectory(dirname(this.#root));
      return validateLedger(JSON.parse(readFileSync(fd, 'utf8')));
    } finally {
      closeSync(fd);
    }
  }

  async #transact<T>(
    work: (ledger: Ledger) => { result: T; changed?: boolean },
  ): Promise<T> {
    try {
      this.#directory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.#checkDirectory();
    const release = await acquireFileMutationLockAsync(
      `${this.#file}.mutation`,
    );
    try {
      this.#checkDirectory();
      const ledger = this.#read();
      const outcome = work(ledger);
      if (outcome.changed) {
        validateLedger(ledger);
        await publishJsonFileWithOwnedLock(this.#file, ledger, {
          maxBytes: FileDelegationGroupBindingStore.maxBytes,
          beforeCommit: () => this.#checkDirectory(),
        });
      }
      // The shared publisher tolerates directory fsync errors; this owner must not.
      this.#flushDirectory(this.#root);
      this.#flushDirectory(dirname(this.#root));
      return outcome.result;
    } finally {
      await release();
    }
  }

  async reserve(input: {
    binding: DelegationGroupBinding;
    operationId: string;
    intentDigest: string;
  }): Promise<ReserveDelegationGroupBindingOutcome> {
    const parsed = z
      .object({ binding: bindingSchema, operationId: id, intentDigest: digest })
      .strict()
      .parse(input);
    return this.#transact<ReserveDelegationGroupBindingOutcome>((ledger) => {
      const existing = ledger.records.find(
        (r) =>
          same(r.binding.scope, parsed.binding.scope) &&
          r.operationId === parsed.operationId,
      );
      if (existing) {
        if (
          !same(existing.binding, parsed.binding) ||
          existing.intentDigest !== parsed.intentDigest
        )
          throw new DelegationGroupBindingError('operation_intent_conflict');
        return {
          result: { kind: 'existing' as const, record: project(existing) },
        };
      }
      if (ledger.records.length >= this.#capacity)
        throw new DelegationGroupBindingError('capacity');
      const ownerToken = randomBytes(32).toString('hex');
      const record: StoredRecord = {
        ...parsed,
        ownerVerifier: verifier(ownerToken),
        revision: 1,
        state: 'reserved',
        providerTurnId: null,
        observationRef: null,
      };
      ledger.records.push(record);
      return {
        changed: true,
        result: {
          kind: 'created' as const,
          ownerToken,
          record: project(record),
        },
      };
    });
  }

  async read(
    scope: DelegationGroupBindingScope,
    key: string,
  ): Promise<DelegationGroupBindingRecord | undefined> {
    const parsed = scopeSchema.parse(scope);
    return this.#transact((ledger) => {
      const record = ledger.records.find(
        (r) =>
          same(r.binding.scope, parsed) &&
          delegationGroupBindingKey(r.binding) === key,
      );
      return { result: record && project(record) };
    });
  }

  async findTurn(
    scope: DelegationGroupBindingScope,
    sessionId: string,
    clientTurnId: string,
  ): Promise<DelegationGroupBindingRecord | undefined> {
    const parsed = scopeSchema.parse(scope);
    id.parse(sessionId);
    id.parse(clientTurnId);
    return this.#transact((ledger) => {
      const record = ledger.records.find(
        (r) =>
          same(r.binding.scope, parsed) &&
          r.binding.sessionId === sessionId &&
          r.binding.clientTurnId === clientTurnId,
      );
      return { result: record && project(record) };
    });
  }

  async advance(input: {
    binding: DelegationGroupBinding;
    ownerToken: string;
    expectedRevision: number;
    transition:
      | { state: 'launch-intent' | 'session-started' }
      | { state: 'turn-accepted'; providerTurnId: string }
      | { state: 'observed'; providerTurnId: string; observationRef: string };
  }): Promise<DelegationGroupBindingRecord> {
    const binding = bindingSchema.parse(input.binding);
    generation.parse(input.expectedRevision);
    const token = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(input.ownerToken);
    const transition = z
      .discriminatedUnion('state', [
        z.object({ state: z.literal('launch-intent') }).strict(),
        z.object({ state: z.literal('session-started') }).strict(),
        z
          .object({ state: z.literal('turn-accepted'), providerTurnId: id })
          .strict(),
        z
          .object({
            state: z.literal('observed'),
            providerTurnId: id,
            observationRef: digest,
          })
          .strict(),
      ])
      .parse(input.transition);
    return this.#transact((ledger) => {
      const record = ledger.records.find(
        (r) =>
          delegationGroupBindingKey(r.binding) ===
          delegationGroupBindingKey(binding),
      );
      if (!record || !same(record.binding, binding))
        throw new DelegationGroupBindingError('binding_unavailable');
      if (
        !timingSafeEqual(
          Buffer.from(record.ownerVerifier, 'hex'),
          Buffer.from(verifier(token), 'hex'),
        )
      )
        throw new DelegationGroupBindingError('owner_mismatch');
      if (record.revision !== input.expectedRevision)
        throw new DelegationGroupBindingError('revision_conflict');
      const previous = {
        'launch-intent': 'reserved',
        'session-started': 'launch-intent',
        'turn-accepted': 'session-started',
        observed: 'turn-accepted',
      } as const;
      if (record.state !== previous[transition.state])
        throw new DelegationGroupBindingError('transition_conflict');
      if (
        transition.state === 'observed' &&
        record.providerTurnId !== transition.providerTurnId
      )
        throw new DelegationGroupBindingError('provider_turn_conflict');
      Object.assign(record, transition, { revision: record.revision + 1 });
      return { changed: true, result: project(record) };
    });
  }
}
