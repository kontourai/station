import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { delegationIdV2 } from '@kontourai/flow-agents/delegation-authority-contract';
import {
  type DelegationAuthorityLedger,
  type DelegationAuthorityStore,
  validateDelegationAuthorityLedger,
} from '@kontourai/flow-agents/delegation-authority-service';
import {
  type DelegationGroupJournalV2,
  type DelegationGroupStoreV2,
  delegationGroupCapacityV2,
  GROUP_V2_MAX_BYTES,
  GROUP_V2_MAX_EVENTS,
  projectDelegationGroupV2,
} from '@kontourai/flow-agents/delegation-group-v2';
import { canonicalJson } from '@kontourai/relay';
import { publishJsonFileWithOwnedLock } from '@kontourai/station-shared/json-file-storage';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';

import type { ReservedProviderEvidence } from '../../runtime/conversation/reserved-provider-fetch.js';

export type DelegationPersistenceFinalizer = () => undefined;
const AUTHORITY_MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 1024;
const MAX_USAGE_BYTES =
  Buffer.byteLength(
    canonicalJson({
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: Number.MAX_SAFE_INTEGER,
      costMicros: Number.MAX_SAFE_INTEGER,
    }),
  ) - Buffer.byteLength('null');

export class DelegationPersistenceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function requirePersistence(
  condition: unknown,
  code: string,
): asserts condition {
  if (!condition) throw new DelegationPersistenceError(code);
}
function assertCurrent(finalizeCurrent: DelegationPersistenceFinalizer): void {
  const result: unknown = finalizeCurrent();
  if (result !== undefined) void Promise.resolve(result).catch(() => {});
  requirePersistence(
    result === undefined,
    'delegation_finalizer_must_be_synchronous',
  );
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function address(id: string): string {
  delegationIdV2(id);
  return `${createHash('sha256').update(id).digest('hex')}.json`;
}
function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  requirePersistence(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o7777) === 0o700,
    'delegation_private_directory_required',
  );
}
function syncDirectory(path: string): void {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Bounded fd read: a present corrupt/aliased record never becomes an absent ledger. */
function readBytes(path: string, limit: number): string | null {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    requirePersistence(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid?.() &&
        (stat.mode & 0o7777) === 0o600 &&
        stat.size <= limit,
      'delegation_unsafe_record',
    );
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    requirePersistence(total <= limit, 'delegation_record_too_large');
    fsyncSync(fd);
    syncDirectory(dirname(path));
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    closeSync(fd);
  }
}

class PrivateDomain {
  readonly root: string;
  readonly directory: string;
  readonly lock: string;
  constructor(root: string, name: string) {
    this.root = root;
    this.directory = join(root, name);
    this.lock = join(root, `${name}.mutation`);
  }
  check(): void {
    privateDirectory(this.root);
    privateDirectory(this.directory);
  }
  async locked<T>(
    finalizeCurrent: DelegationPersistenceFinalizer,
    body: () => Promise<T>,
  ): Promise<T> {
    assertCurrent(finalizeCurrent);
    privateDirectory(this.root);
    try {
      mkdirSync(this.directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.check();
    const release = await acquireFileMutationLockAsync(this.lock);
    let result: T;
    try {
      assertCurrent(finalizeCurrent);
      this.check();
      result = await body();
      this.check();
      syncDirectory(this.directory);
      syncDirectory(this.root);
      syncDirectory(dirname(this.root));
      assertCurrent(finalizeCurrent);
    } finally {
      await release();
    }
    // Replay/read results are disclosed only to the still-current actual request.
    assertCurrent(finalizeCurrent);
    return result;
  }
  files(): string[] {
    this.check();
    const files = readdirSync(this.directory)
      .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
      .sort();
    requirePersistence(files.length <= MAX_FILES, 'delegation_store_capacity');
    return files;
  }
  async publish(
    file: string,
    value: unknown,
    maxBytes: number,
    finalizeCurrent: DelegationPersistenceFinalizer,
  ): Promise<void> {
    this.check();
    assertCurrent(finalizeCurrent);
    await publishJsonFileWithOwnedLock(join(this.directory, file), value, {
      maxBytes,
      indent: null,
      trailingNewline: true,
      beforeCommit: () => {
        this.check();
        assertCurrent(finalizeCurrent);
      },
      finalizeCommit: () => {
        this.check();
        assertCurrent(finalizeCurrent);
        return undefined;
      },
    });
    this.check();
    assertCurrent(finalizeCurrent);
  }
}

/**
 * Host persistence only; Flow owns issuance, narrowing, budgets and group transitions.
 * One exclusive root per host. Never mix this domain with upstream local-store writers.
 * Lock order is group -> authority; authority callbacks must not re-enter group storage.
 */
export class StationDelegationPersistence {
  readonly #authorities: PrivateDomain;
  readonly #groups: PrivateDomain;
  readonly #providerEvidence: PrivateDomain;
  constructor(privateRoot: string) {
    const requested = resolve(privateRoot);
    privateDirectory(requested);
    const root = join(realpathSync(dirname(requested)), basename(requested));
    privateDirectory(root);
    this.#authorities = new PrivateDomain(
      root,
      'station-delegation-authorities',
    );
    this.#groups = new PrivateDomain(root, 'station-delegation-groups');
    this.#providerEvidence = new PrivateDomain(
      root,
      'station-provider-evidence',
    );
  }

  /** Private raw evidence remains bound to the consumed physical invocation. */
  async retainProviderEvidence(
    evidence: ReservedProviderEvidence,
    finalizeCurrent: DelegationPersistenceFinalizer,
  ) {
    const record = structuredClone({ version: 1, evidence });
    const domain = this.#providerEvidence;
    const file = `${createHash('sha256')
      .update(
        canonicalJson([
          record.evidence.intent.root.id,
          record.evidence.intent.invocationId,
        ]),
      )
      .digest('hex')}.json`;
    const maxBytes = 20 * 1024 * 1024;
    return domain.locked(finalizeCurrent, async () => {
      const path = join(domain.directory, file);
      const previous = readBytes(path, maxBytes);
      if (previous !== null) {
        requirePersistence(
          same(JSON.parse(previous), record),
          'delegation_provider_evidence_conflict',
        );
      } else {
        requirePersistence(
          domain.files().length < MAX_FILES,
          'delegation_store_capacity',
        );
        await domain.publish(file, record, maxBytes, finalizeCurrent);
      }
      const committed = readBytes(path, maxBytes);
      requirePersistence(
        committed !== null && same(JSON.parse(committed), record),
        'delegation_commit_unconfirmed',
      );
      return Object.freeze({
        id: file.slice(0, -5),
        domain: 'station.provider-evidence',
        digest: `sha256:${createHash('sha256').update(canonicalJson(record)).digest('hex')}`,
      });
    });
  }

  async assertProviderEvidenceRetained(
    evidence: ReservedProviderEvidence,
    reference: { id: string; domain: string; digest: string },
    finalizeCurrent: DelegationPersistenceFinalizer,
  ): Promise<void> {
    const record = structuredClone({ version: 1, evidence });
    const id = createHash('sha256')
      .update(
        canonicalJson([evidence.intent.root.id, evidence.intent.invocationId]),
      )
      .digest('hex');
    const digest = `sha256:${createHash('sha256')
      .update(canonicalJson(record))
      .digest('hex')}`;
    requirePersistence(
      reference.id === id &&
        reference.domain === 'station.provider-evidence' &&
        reference.digest === digest,
      'delegation_provider_evidence_mismatch',
    );
    await this.#providerEvidence.locked(finalizeCurrent, async () => {
      const bytes = readBytes(
        join(this.#providerEvidence.directory, `${id}.json`),
        20 * 1024 * 1024,
      );
      requirePersistence(
        bytes !== null && same(JSON.parse(bytes), record),
        'delegation_provider_evidence_unavailable',
      );
    });
  }

  authorityStore(
    finalizeCurrent: DelegationPersistenceFinalizer,
  ): DelegationAuthorityStore {
    const domain = this.#authorities;
    const read = (file: string): DelegationAuthorityLedger | null => {
      const bytes = readBytes(
        join(domain.directory, file),
        AUTHORITY_MAX_BYTES,
      );
      if (bytes === null) return null;
      const ledger = validateDelegationAuthorityLedger(JSON.parse(bytes));
      requirePersistence(
        address(ledger.root.authority_id) === file,
        'delegation_authority_identity_mismatch',
      );
      return ledger;
    };
    return {
      transact: (authorityId, body) =>
        domain.locked(finalizeCurrent, async () => {
          const file = address(authorityId);
          const previous = read(file);
          const next = await body(previous && structuredClone(previous));
          assertCurrent(finalizeCurrent);
          const ledger = validateDelegationAuthorityLedger(next.ledger);
          requirePersistence(
            ledger.root.authority_id === authorityId,
            'delegation_authority_identity_mismatch',
          );
          if (previous) {
            requirePersistence(
              same(previous.root, ledger.root) &&
                (!previous.cancelled || ledger.cancelled),
              'delegation_authority_history_changed',
            );
            requirePersistence(
              ledger.envelopes.length >= previous.envelopes.length &&
                same(
                  ledger.envelopes.slice(0, previous.envelopes.length),
                  previous.envelopes,
                ),
              'delegation_envelope_history_changed',
            );
            for (const before of previous.invocations) {
              const after = ledger.invocations.find(
                (invocation) => invocation.invocationId === before.invocationId,
              );
              requirePersistence(
                after &&
                  after.envelopeId === before.envelopeId &&
                  same(after.allocation, before.allocation) &&
                  (!before.terminal || after.terminal) &&
                  (before.usage === null || same(before.usage, after.usage)),
                'delegation_invocation_history_changed',
              );
            }
          }
          const files = domain.files();
          requirePersistence(
            previous || files.length < MAX_FILES,
            'delegation_store_capacity',
          );
          const identities = new Set(
            ledger.envelopes.map((envelope) => envelope.execution_id),
          );
          for (const otherFile of files) {
            if (otherFile === file) continue;
            const other = read(otherFile);
            requirePersistence(
              other &&
                !other.envelopes.some((envelope) =>
                  identities.has(envelope.execution_id),
                ),
              'delegation_execution_custody_conflict',
            );
          }
          // Serialization headroom only; no token/cost arithmetic is implemented here.
          const headroom =
            ledger.invocations.filter((invocation) => invocation.usage === null)
              .length * MAX_USAGE_BYTES;
          requirePersistence(
            Buffer.byteLength(`${canonicalJson(ledger)}\n`) + headroom <=
              AUTHORITY_MAX_BYTES,
            'delegation_settlement_capacity',
          );
          if (!previous || !same(previous, ledger))
            await domain.publish(
              file,
              ledger,
              AUTHORITY_MAX_BYTES,
              finalizeCurrent,
            );
          const committed = read(file);
          requirePersistence(
            committed && same(committed, ledger),
            'delegation_commit_unconfirmed',
          );
          return next.result;
        }),
    };
  }

  groupStore(
    finalizeCurrent: DelegationPersistenceFinalizer,
  ): DelegationGroupStoreV2 {
    const domain = this.#groups;
    const read = (file: string): DelegationGroupJournalV2 | null => {
      const bytes = readBytes(join(domain.directory, file), GROUP_V2_MAX_BYTES);
      if (bytes === null) return null;
      const journal: DelegationGroupJournalV2 = JSON.parse(bytes);
      projectDelegationGroupV2(journal);
      requirePersistence(
        address(journal.groupId) === file,
        'delegation_group_identity_mismatch',
      );
      return journal;
    };
    const all = (): DelegationGroupJournalV2[] =>
      domain.files().map((file) => {
        const journal = read(file);
        requirePersistence(journal, 'delegation_record_disappeared');
        return journal;
      });
    return {
      transact: (groupId, body) =>
        domain.locked(finalizeCurrent, async () => {
          const file = address(groupId);
          const previous = read(file);
          const next = await body(previous && structuredClone(previous));
          assertCurrent(finalizeCurrent);
          const projection = projectDelegationGroupV2(next.journal);
          requirePersistence(
            next.journal.groupId === groupId,
            'delegation_group_identity_mismatch',
          );
          if (previous)
            requirePersistence(
              next.journal.events.length >= previous.events.length &&
                same(
                  next.journal.events.slice(0, previous.events.length),
                  previous.events,
                ),
              'delegation_journal_history_changed',
            );
          else {
            const journals = all();
            requirePersistence(
              journals.length < MAX_FILES,
              'delegation_store_capacity',
            );
            requirePersistence(
              !journals.some(
                (journal) =>
                  projectDelegationGroupV2(journal).spec.rootAuthorityRef.id ===
                  projection.spec.rootAuthorityRef.id,
              ),
              'delegation_group_authority_custody_conflict',
            );
          }
          const capacity = delegationGroupCapacityV2(next.journal);
          requirePersistence(
            next.journal.events.length + capacity.events <=
              GROUP_V2_MAX_EVENTS &&
              Buffer.byteLength(`${canonicalJson(next.journal)}\n`) +
                capacity.bytes <=
                GROUP_V2_MAX_BYTES,
            'delegation_group_capacity',
          );
          if (!previous || !same(previous, next.journal))
            await domain.publish(
              file,
              next.journal,
              GROUP_V2_MAX_BYTES,
              finalizeCurrent,
            );
          const committed = read(file);
          requirePersistence(
            committed && same(committed, next.journal),
            'delegation_commit_unconfirmed',
          );
          return next.result;
        }),
      scan: (body) =>
        domain.locked(finalizeCurrent, async () => {
          const result = await body(all());
          assertCurrent(finalizeCurrent);
          return result;
        }),
    };
  }
}
