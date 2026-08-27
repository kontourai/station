/**
 * Explicit, operator initiated import of Codex's immediate `prompts/*.md`
 * files into Station Skills.  This is deliberately not a general file import:
 * the source root is resolved by the server, source bodies never leave this
 * module, and SkillService remains the only writer for Skill packages.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import {
  SETUP_IMPORT_MAX_ITEMS,
  SETUP_IMPORT_MAX_SOURCE_ID_LENGTH,
  SETUP_IMPORT_MAX_TARGET_NAME_LENGTH,
} from '@kontourai/station-shared/setup-import-bounds';
import { resolveHomeDir } from '../../utils/paths.js';
import {
  type BoundDirectoryIdentity,
  boundDirectoryIdentity,
  enumerateBoundDirectory,
} from '../agents/bound-directory-enumeration.js';
import {
  isSafeSkillName,
  parseImportedSkillMarkdown,
} from '../agents/skill-metadata.js';
import {
  SkillPublicationIndeterminateError,
  type SkillService,
} from '../agents/skill-service.js';
import {
  bindGuardedDirectories,
  readGuardedUtf8,
  revalidateGuardedDirectories,
} from './guarded-setup-import-filesystem.js';
import { SetupImportReceiptStore } from './setup-import-receipt-store.js';

const MAX_FILES = SETUP_IMPORT_MAX_ITEMS;
const MAX_ENUMERATION_ENTRIES = 128;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECEIPTS = 64;
const SOURCE_ID = 'codex-prompts';
const STORE_SCHEMA_VERSION = 1;
const SOURCE_ADAPTER_VERSION = 2;

export type SetupImportErrorCode =
  | 'INVALID_SOURCE'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_CHANGED'
  | 'PREVIEW_EXPIRED'
  | 'INVALID_APPLY'
  | 'STORE_UNAVAILABLE'
  | 'RECEIPT_NOT_FOUND'
  | 'RECEIPT_CONFLICT';

export class SetupImportError extends Error {
  constructor(readonly code: SetupImportErrorCode) {
    super(code);
    this.name = 'SetupImportError';
  }
}

type SourceBinding = {
  id: string;
  name: string;
  size: number;
  digest: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  skillName: string;
  collision: boolean;
};

type PreviewRecord = {
  id: string;
  createdAt: string;
  expiresAt: string;
  adapterVersion: number;
  entries: SourceBinding[];
  excluded: Record<string, number>;
  directories: { root: DirectoryBinding; prompts: DirectoryBinding };
  witnesses?: TargetWitness[];
};
type DirectoryBinding = BoundDirectoryIdentity;
type TargetWitnessItem = {
  id: string;
  action: 'import' | 'skip';
  targetName?: string;
  /** Exact target absence or installed revision at review time. */
  targetRevision?: string | null;
};
type TargetWitness = {
  id: string;
  createdAt: string;
  expiresAt: string;
  adapterVersion: number;
  items: TargetWitnessItem[];
};

type ReceiptTarget = { name: string; digest: string };
type EffectState =
  | 'pending'
  | 'applying'
  | 'applied'
  | 'skipped'
  | 'failed'
  | 'compensating'
  | 'compensated'
  | 'indeterminate';
type RollbackState =
  | 'available'
  | 'applied'
  | 'conflict'
  | 'failed'
  | 'indeterminate';
type EffectRecord = {
  id: string;
  action: 'import' | 'skip';
  targetName?: string;
  sourceDigest: string;
  adapterVersion: 1;
  /** `null` is an exact reviewed absence; a string is the exact revision. */
  targetRevision?: string | null;
  expectedRevision?: string;
  state: EffectState;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  revision?: string;
  rollbackState?: RollbackState;
  retryable?: boolean;
};
type ReceiptRecord = {
  id: string;
  createdAt: string;
  previewId: string;
  imported: ReceiptTarget[];
  skipped: number;
  failed: number;
  rolledBack: ReceiptTarget[];
  rolledBackAt?: string;
  /** Durable per-item intent/effect journal. Never aggregate ambiguity away. */
  effects?: EffectRecord[];
};

type Persisted = {
  schemaVersion: 1;
  previews: PreviewRecord[];
  receipts: ReceiptRecord[];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort();
  const accepted = [...keys, ...optional].sort();
  return (
    actual.every((key) => accepted.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
  );
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function integer(value: unknown, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
  );
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function directoryBinding(value: unknown): value is DirectoryBinding {
  return (
    exactRecord(value, ['dev', 'ino', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) &&
    integer(value.dev, Number.MAX_SAFE_INTEGER) &&
    integer(value.ino, Number.MAX_SAFE_INTEGER) &&
    integer(value.nlink, Number.MAX_SAFE_INTEGER) &&
    integer(value.size, Number.MAX_SAFE_INTEGER) &&
    typeof value.mtimeMs === 'number' &&
    Number.isFinite(value.mtimeMs) &&
    value.mtimeMs >= 0 &&
    typeof value.ctimeMs === 'number' &&
    Number.isFinite(value.ctimeMs) &&
    value.ctimeMs >= 0
  );
}

function sourceBinding(value: unknown): value is SourceBinding {
  return (
    exactRecord(value, [
      'id',
      'name',
      'size',
      'digest',
      'dev',
      'ino',
      'mtimeMs',
      'skillName',
      'collision',
    ]) &&
    boundedString(value.id, SETUP_IMPORT_MAX_SOURCE_ID_LENGTH) &&
    boundedString(value.name, 256) &&
    integer(value.size, MAX_FILE_BYTES) &&
    digest(value.digest) &&
    integer(value.dev, Number.MAX_SAFE_INTEGER) &&
    integer(value.ino, Number.MAX_SAFE_INTEGER) &&
    typeof value.mtimeMs === 'number' &&
    Number.isFinite(value.mtimeMs) &&
    boundedString(value.skillName, SETUP_IMPORT_MAX_TARGET_NAME_LENGTH) &&
    typeof value.collision === 'boolean'
  );
}

function receiptTarget(value: unknown): value is ReceiptTarget {
  return (
    exactRecord(value, ['name', 'digest']) &&
    boundedString(value.name, SETUP_IMPORT_MAX_TARGET_NAME_LENGTH) &&
    digest(value.digest)
  );
}

function effectRecord(value: unknown): value is EffectRecord {
  return (
    exactRecord(
      value,
      [
        'id',
        'action',
        'sourceDigest',
        'adapterVersion',
        'state',
        'createdAt',
        'updatedAt',
      ],
      [
        'targetName',
        'targetRevision',
        'expectedRevision',
        'reason',
        'revision',
        'rollbackState',
        'retryable',
      ],
    ) &&
    boundedString(value.id, SETUP_IMPORT_MAX_SOURCE_ID_LENGTH) &&
    (value.action === 'import' || value.action === 'skip') &&
    digest(value.sourceDigest) &&
    value.adapterVersion === 1 &&
    (value.targetName === undefined ||
      boundedString(value.targetName, SETUP_IMPORT_MAX_TARGET_NAME_LENGTH)) &&
    (value.targetRevision === undefined ||
      value.targetRevision === null ||
      digest(value.targetRevision)) &&
    (value.expectedRevision === undefined || digest(value.expectedRevision)) &&
    (value.state === 'pending' ||
      value.state === 'applying' ||
      value.state === 'applied' ||
      value.state === 'skipped' ||
      value.state === 'failed' ||
      value.state === 'compensating' ||
      value.state === 'compensated' ||
      value.state === 'indeterminate') &&
    timestamp(value.createdAt) &&
    timestamp(value.updatedAt) &&
    (value.reason === undefined || boundedString(value.reason, 256)) &&
    (value.revision === undefined || digest(value.revision)) &&
    (value.rollbackState === undefined ||
      value.rollbackState === 'available' ||
      value.rollbackState === 'applied' ||
      value.rollbackState === 'conflict' ||
      value.rollbackState === 'failed' ||
      value.rollbackState === 'indeterminate') &&
    (value.retryable === undefined || typeof value.retryable === 'boolean')
  );
}

function targetWitness(value: unknown): value is TargetWitness {
  return (
    exactRecord(value, [
      'id',
      'createdAt',
      'expiresAt',
      'adapterVersion',
      'items',
    ]) &&
    boundedString(value.id, 64) &&
    timestamp(value.createdAt) &&
    timestamp(value.expiresAt) &&
    value.adapterVersion === SOURCE_ADAPTER_VERSION &&
    Array.isArray(value.items) &&
    value.items.length <= MAX_FILES &&
    value.items.every(
      (item) =>
        exactRecord(item, ['id', 'action'], ['targetName', 'targetRevision']) &&
        boundedString(item.id, SETUP_IMPORT_MAX_SOURCE_ID_LENGTH) &&
        (item.action === 'import' || item.action === 'skip') &&
        (item.targetName === undefined ||
          boundedString(
            item.targetName,
            SETUP_IMPORT_MAX_TARGET_NAME_LENGTH,
          )) &&
        (item.targetRevision === undefined ||
          item.targetRevision === null ||
          digest(item.targetRevision)),
    )
  );
}

function previewRecord(value: unknown): value is PreviewRecord {
  return (
    exactRecord(
      value,
      [
        'id',
        'createdAt',
        'expiresAt',
        'adapterVersion',
        'entries',
        'excluded',
        'directories',
      ],
      ['witnesses'],
    ) &&
    boundedString(value.id, 64) &&
    timestamp(value.createdAt) &&
    timestamp(value.expiresAt) &&
    value.adapterVersion === SOURCE_ADAPTER_VERSION &&
    Array.isArray(value.entries) &&
    value.entries.length <= MAX_FILES &&
    value.entries.every(sourceBinding) &&
    record(value.excluded) &&
    Object.keys(value.excluded).length <= MAX_ENUMERATION_ENTRIES &&
    Object.values(value.excluded).every((count) =>
      integer(count, MAX_ENUMERATION_ENTRIES),
    ) &&
    exactRecord(value.directories, ['root', 'prompts']) &&
    directoryBinding(value.directories.root) &&
    directoryBinding(value.directories.prompts) &&
    (value.witnesses === undefined ||
      (Array.isArray(value.witnesses) &&
        value.witnesses.length <= MAX_FILES &&
        value.witnesses.every(targetWitness)))
  );
}

function receiptRecord(value: unknown): value is ReceiptRecord {
  return (
    exactRecord(
      value,
      [
        'id',
        'createdAt',
        'previewId',
        'imported',
        'skipped',
        'failed',
        'rolledBack',
      ],
      ['rolledBackAt', 'effects'],
    ) &&
    boundedString(value.id, 64) &&
    timestamp(value.createdAt) &&
    boundedString(value.previewId, 64) &&
    Array.isArray(value.imported) &&
    value.imported.length <= MAX_FILES &&
    value.imported.every(receiptTarget) &&
    integer(value.skipped, MAX_FILES) &&
    integer(value.failed, MAX_FILES * 2) &&
    Array.isArray(value.rolledBack) &&
    value.rolledBack.length <= value.imported.length &&
    value.rolledBack.every(receiptTarget) &&
    (value.rolledBackAt === undefined || timestamp(value.rolledBackAt)) &&
    (value.effects === undefined ||
      (Array.isArray(value.effects) &&
        value.effects.length <= MAX_FILES &&
        value.effects.every(effectRecord)))
  );
}

export type SetupImportPreview = Omit<
  PreviewRecord,
  'entries' | 'directories' | 'adapterVersion'
> & {
  entries: Array<
    Pick<
      SourceBinding,
      'id' | 'name' | 'size' | 'digest' | 'skillName' | 'collision'
    >
  >;
  /** Stable, content-free warning codes derived from the reviewed source. */
  warnings: string[];
};

export type SetupImportPublicItem = {
  /** Source-relative reviewed identity; never a filesystem path. */
  sourceId: string;
  reviewedTarget?: string;
  state: EffectState;
  outcome: 'imported' | 'skipped' | 'failed' | 'rolled-back' | 'indeterminate';
  reasonCode?: string;
  repairCode?: string;
  /** Exact canonical Skill revision, only after publication is known. */
  targetRevision?: string;
  rollback: { state: RollbackState; retryable: boolean };
};

export type SetupImportPublicReceipt = {
  id: string;
  createdAt: string;
  previewId: string;
  items: SetupImportPublicItem[];
  retryable: boolean;
  rolledBackAt?: string;
};

export interface SetupImportApplyInput {
  previewId: string;
  witnessId: string;
}
export interface SetupImportTargetReviewInput {
  previewId: string;
  items: Array<{ id: string; action: 'import' | 'skip'; targetName?: string }>;
}

export class ExistingAgentSetupImportModule {
  constructor(
    private readonly skillService: SkillService,
    private readonly projectHomeDir: () => string,
    private readonly now: () => Date = () => new Date(),
    private readonly testHooks: {
      /** Deterministic fault instrumentation; production supplies no hooks. */
      afterSkillPublished?: (target: {
        name: string;
        revision: string;
      }) => void | Promise<void>;
      receiptStore?: (
        path: string,
        empty: () => Persisted,
      ) => SetupImportReceiptStore;
      /** Deterministic pre-enumeration substitution proof. */
      beforePromptEnumerationForTest?: () => void | Promise<void>;
      /** Deterministic proof that binding is never refreshed from a pathname. */
      beforePromptExpectedIdentityForTest?: () => void | Promise<void>;
      /** Deterministic proof that a late restoration cannot launder a swap. */
      afterPromptEnumerationForTest?: () => void | Promise<void>;
    } = {},
  ) {}

  /** A deliberately content-free capability projection. */
  async sources() {
    const prompts = this.promptsDir();
    try {
      const stat = await lstat(prompts);
      return [
        {
          id: SOURCE_ID,
          available: stat.isDirectory() && !stat.isSymbolicLink(),
        },
      ];
    } catch {
      return [{ id: SOURCE_ID, available: false }];
    }
  }

  async preview(sourceId: string): Promise<SetupImportPreview> {
    if (sourceId !== SOURCE_ID) throw new SetupImportError('INVALID_SOURCE');
    const excluded: Record<string, number> = {};
    const entries: SourceBinding[] = [];
    let total = 0;
    const prompts = this.promptsDir();
    const root = this.codexHome();
    const rootBinding = await this.assertSafeDirectory(root, false);
    const promptsBinding = await this.assertSafeDirectory(prompts, true);
    const rootChain = await bindGuardedDirectories(root);
    const promptsChain = await bindGuardedDirectories(prompts);
    // The adapter's child has `prompts` as its OS cwd, checks `.` against this
    // exact descriptor-derived identity, then enumerates and opens relative
    // children. A rename between these checks and spawn binds the wrong cwd
    // and fails instead of enumerating a replacement pathname.
    await revalidateGuardedDirectories(root, rootChain);
    await revalidateGuardedDirectories(prompts, promptsChain);
    await this.testHooks.beforePromptExpectedIdentityForTest?.();
    let listed: Awaited<ReturnType<typeof enumerateBoundDirectory>>;
    try {
      listed = await enumerateBoundDirectory({
        directory: prompts,
        // Bind the helper to the original prompt directory, not to whichever
        // object the pathname happens to resolve to immediately before spawn.
        expected: promptsBinding,
        limits: {
          entries: MAX_ENUMERATION_ENTRIES,
          fileBytes: MAX_FILE_BYTES,
          totalBytes: MAX_TOTAL_BYTES,
        },
        beforeEnumerationForTest: this.testHooks.beforePromptEnumerationForTest,
        afterEnumerationForTest: this.testHooks.afterPromptEnumerationForTest,
      });
    } catch {
      throw new SetupImportError('SOURCE_UNAVAILABLE');
    }
    for (const entry of listed) {
      if (extname(entry.name).toLowerCase() !== '.md') {
        this.exclude(excluded, 'not-markdown');
        continue;
      }
      if (entries.length >= MAX_FILES) {
        this.exclude(excluded, 'count-limit');
        continue;
      }
      // Bind each descriptor-derived read to the original full source chain,
      // not merely the final directory check before publishing a preview.
      await revalidateGuardedDirectories(root, rootChain);
      await revalidateGuardedDirectories(prompts, promptsChain);
      if (entry.kind !== 'file') {
        this.exclude(
          excluded,
          entry.kind === 'hard-link'
            ? 'hard-link'
            : entry.kind === 'symlink'
              ? 'symlink'
              : entry.kind === 'file-size-limit'
                ? 'file-size-limit'
                : entry.kind === 'total-size-limit'
                  ? 'total-size-limit'
                  : entry.kind === 'special-file'
                    ? 'special-file'
                    : 'unreadable',
        );
        continue;
      }
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes);
      } catch {
        this.exclude(excluded, 'invalid-utf8');
        continue;
      }
      if (total + entry.bytes.byteLength > MAX_TOTAL_BYTES) {
        this.exclude(excluded, 'total-size-limit');
        continue;
      }
      total += entry.bytes.byteLength;
      const digest = createHash('sha256').update(entry.bytes).digest('hex');
      const parsed = parseImportedSkillMarkdown(entry.name, content);
      const skillName = parsed.name;
      if (!isSafeSkillName(skillName) || !parsed.body.trim()) {
        this.exclude(excluded, 'invalid-skill');
        continue;
      }
      entries.push({
        id: this.sourceId(entry.name, digest),
        name: entry.name,
        size: entry.bytes.byteLength,
        digest,
        dev: entry.identity.dev,
        ino: entry.identity.ino,
        mtimeMs: entry.identity.mtimeMs,
        skillName,
        collision: this.skillService.hasSkill(skillName),
      });
    }
    await revalidateGuardedDirectories(root, rootChain);
    await revalidateGuardedDirectories(prompts, promptsChain);
    const created = this.now();
    const record: PreviewRecord = {
      id: randomUUID(),
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + PREVIEW_TTL_MS).toISOString(),
      adapterVersion: SOURCE_ADAPTER_VERSION,
      entries,
      excluded,
      directories: { root: rootBinding, prompts: promptsBinding },
    };
    await this.mutateStore((store) => {
      store.previews = [
        ...store.previews.filter(
          (preview) => Date.parse(preview.expiresAt) > created.getTime(),
        ),
        record,
      ].slice(-MAX_RECEIPTS);
      return record;
    });
    return this.publicPreview(record);
  }

  async apply(input: SetupImportApplyInput) {
    // Check the source outside the receipt-store lock.  The transactional
    // claim below re-reads the preview and rejects a concurrent consumer.
    const preview = (await this.readStore()).previews.find(
      (candidate) => candidate.id === input.previewId,
    );
    if (!preview || Date.parse(preview.expiresAt) <= this.now().getTime())
      throw new SetupImportError('PREVIEW_EXPIRED');
    if (preview.adapterVersion !== SOURCE_ADAPTER_VERSION)
      throw new SetupImportError('SOURCE_CHANGED');
    const witness = preview.witnesses?.find(
      (candidate) => candidate.id === input.witnessId,
    );
    if (!witness || Date.parse(witness.expiresAt) <= this.now().getTime())
      throw new SetupImportError('INVALID_APPLY');
    this.assertWitness(preview, witness);
    await this.assertDirectoryBinding(
      this.codexHome(),
      preview.directories.root,
    );
    await this.assertDirectoryBinding(
      this.promptsDir(),
      preview.directories.prompts,
    );
    const intents = new Map(witness.items.map((item) => [item.id, item]));
    const receipt: ReceiptRecord = {
      id: randomUUID(),
      createdAt: this.now().toISOString(),
      previewId: preview.id,
      imported: [],
      skipped: 0,
      failed: 0,
      rolledBack: [],
      effects: preview.entries.map((binding) => {
        const intent = intents.get(binding.id)!;
        const now = this.now().toISOString();
        return {
          id: binding.id,
          action: intent.action,
          // The reviewed target stays with the effect even when the operator
          // skips it, so every public item is self-describing after restart.
          targetName: intent.targetName ?? binding.skillName,
          sourceDigest: binding.digest,
          adapterVersion: 1,
          targetRevision: null,
          state: 'pending',
          createdAt: now,
          updatedAt: now,
        };
      }),
    };
    // Claim the preview and publish the receipt before a Skill can be
    // created.  A competing apply must not reuse this review decision.
    const claimedPreview = await this.mutateStore((store) => {
      const current = store.previews.find(
        (candidate) => candidate.id === input.previewId,
      );
      if (!current || Date.parse(current.expiresAt) <= this.now().getTime()) {
        throw new SetupImportError('PREVIEW_EXPIRED');
      }
      if (current.adapterVersion !== SOURCE_ADAPTER_VERSION)
        throw new SetupImportError('SOURCE_CHANGED');
      const currentWitness = current.witnesses?.find(
        (candidate) => candidate.id === input.witnessId,
      );
      if (
        !currentWitness ||
        Date.parse(currentWitness.expiresAt) <= this.now().getTime()
      )
        throw new SetupImportError('INVALID_APPLY');
      this.assertWitness(current, currentWitness);
      store.previews = store.previews.filter(
        (candidate) => candidate.id !== current.id,
      );
      store.receipts = this.pruneReceipts([...store.receipts, receipt]);
      return current;
    });
    await this.reconcileReceipt(receipt.id);
    for (const binding of claimedPreview.entries) {
      const intent = intents.get(binding.id)!;
      if (intent.action === 'skip') {
        await this.transitionEffect(receipt.id, binding.id, 'skipped', {
          reason: 'skipped-by-operator',
          rollbackState: 'failed',
          retryable: false,
        });
        await this.updateReceipt(receipt.id, (current) => current.skipped++);
        continue;
      }
      if (!intent.targetName || !isSafeSkillName(intent.targetName)) {
        await this.failEffect(receipt.id, binding.id, 'invalid-target');
        continue;
      }
      const path = this.childPath(this.promptsDir(), binding.name);
      const read = await this.readBoundedRegularFile(path);
      if (!read.ok || !this.matches(binding, read)) {
        await this.failEffect(receipt.id, binding.id, 'source-changed');
        continue;
      }
      // The preview is also bound to the target namespace: accepting a newly
      // appeared (or disappeared) collision would turn a reviewed decision
      // into a different write.
      if (this.skillService.hasSkill(binding.skillName) !== binding.collision) {
        await this.failEffect(
          receipt.id,
          binding.id,
          'source-namespace-changed',
        );
        continue;
      }
      const parsed = parseImportedSkillMarkdown(binding.name, read.content);
      if (
        !isSafeSkillName(parsed.name) ||
        !parsed.body.trim() ||
        parsed.name !== binding.skillName
      ) {
        await this.failEffect(receipt.id, binding.id, 'source-invalid');
        continue;
      }
      const name = intent.targetName;
      const targetRevision = intent.targetRevision;
      const currentTargetRevision = await this.targetRevision(name);
      if (
        (currentTargetRevision ?? null) !== targetRevision ||
        targetRevision !== null ||
        this.skillService.hasSkill(name)
      ) {
        await this.failEffect(receipt.id, binding.id, 'target-not-absent', {
          targetRevision: currentTargetRevision ?? null,
        });
        continue;
      }
      const publication = this.skillService.projectLocalSkillPublication(
        { ...parsed, name, body: parsed.body },
        this.projectHomeDir(),
      );
      await this.transitionEffect(receipt.id, binding.id, 'applying', {
        targetRevision: targetRevision ?? null,
        expectedRevision: publication.revision,
      });
      try {
        const result = await this.skillService.createLocalSkillIfAbsent(
          publication.input,
          this.projectHomeDir(),
        );
        if (!result.success) {
          await this.failEffect(receipt.id, binding.id, 'target-conflict');
          continue;
        }
        const target = {
          name,
          digest: await this.skillService.localSkillRevision(
            name,
            this.projectHomeDir(),
          ),
        };
        try {
          await this.testHooks.afterSkillPublished?.({
            name: target.name,
            revision: target.digest,
          });
          await this.transitionEffect(receipt.id, binding.id, 'applied', {
            revision: target.digest,
            reason: 'imported',
            rollbackState: 'available',
            retryable: true,
          });
          await this.updateReceipt(receipt.id, (current) => {
            if (current.imported.some((item) => item.name === target.name))
              throw new Error('Setup import receipt item already recorded.');
            current.imported.push(target);
          });
        } catch {
          // The applying journal is already durable. Try to compensate, but
          // preserve indeterminacy if either receipt finalization or rollback
          // cannot be durably recorded.
          await this.transitionEffect(receipt.id, binding.id, 'compensating', {
            revision: target.digest,
            reason: 'receipt-finalization-failed',
          }).catch(() => {});
          const compensation = await this.skillService.removeSkillIfRevision(
            name,
            target.digest,
            this.projectHomeDir(),
          );
          await this.transitionEffect(
            receipt.id,
            binding.id,
            compensation.removed ? 'compensated' : 'indeterminate',
            {
              revision: target.digest,
              reason: compensation.removed
                ? 'receipt-finalization-failed'
                : 'compensation-conflict',
              rollbackState: compensation.removed ? 'applied' : 'indeterminate',
              retryable: !compensation.removed,
            },
          ).catch(() => {});
        }
      } catch (error) {
        // The Skill authority could not prove that its record-first
        // compensation completed.  Its directory is an observable effect, so
        // a terminal "failed" receipt would lie about a target an operator
        // still has to inspect or recover.
        if (error instanceof SkillPublicationIndeterminateError) {
          await this.transitionEffect(receipt.id, binding.id, 'indeterminate', {
            reason: 'publication-compensation-indeterminate',
          });
          continue;
        }
        await this.failEffect(receipt.id, binding.id, 'publication-failed');
      }
    }
    return this.publicReceipt(await this.findReceipt(receipt.id));
  }

  /** Bind every final target before it can become a write decision. */
  async reviewTargets(input: SetupImportTargetReviewInput) {
    const preview = (await this.readStore()).previews.find(
      (candidate) => candidate.id === input.previewId,
    );
    if (!preview || Date.parse(preview.expiresAt) <= this.now().getTime())
      throw new SetupImportError('PREVIEW_EXPIRED');
    this.assertApplyInput(preview, input);
    await this.assertDirectoryBinding(
      this.codexHome(),
      preview.directories.root,
    );
    await this.assertDirectoryBinding(
      this.promptsDir(),
      preview.directories.prompts,
    );
    const items: TargetWitnessItem[] = [];
    for (const intent of input.items) {
      const binding = preview.entries.find((entry) => entry.id === intent.id)!;
      if (
        intent.action === 'import' &&
        (!intent.targetName || !isSafeSkillName(intent.targetName))
      )
        throw new SetupImportError('INVALID_APPLY');
      const targetName = intent.targetName ?? binding.skillName;
      items.push({
        id: intent.id,
        action: intent.action,
        ...(intent.action === 'import' ? { targetName } : {}),
        ...(intent.action === 'import'
          ? { targetRevision: (await this.targetRevision(targetName)) ?? null }
          : {}),
      });
    }
    const now = this.now();
    const witness: TargetWitness = {
      id: randomUUID(),
      createdAt: now.toISOString(),
      expiresAt: new Date(
        Math.min(Date.parse(preview.expiresAt), now.getTime() + PREVIEW_TTL_MS),
      ).toISOString(),
      adapterVersion: SOURCE_ADAPTER_VERSION,
      items,
    };
    const updated = await this.mutateStore((store) => {
      const current = store.previews.find(
        (candidate) => candidate.id === input.previewId,
      );
      if (!current || Date.parse(current.expiresAt) <= this.now().getTime())
        throw new SetupImportError('PREVIEW_EXPIRED');
      this.assertApplyInput(current, input);
      current.witnesses = [
        ...(current.witnesses ?? []).filter(
          (candidate) => Date.parse(candidate.expiresAt) > now.getTime(),
        ),
        witness,
      ].slice(-MAX_FILES);
      return current;
    });
    return {
      preview: this.publicPreview(updated),
      witness: this.publicWitness(witness),
    };
  }

  async receipt(id: string) {
    await this.reconcileReceipt(id);
    const found = (await this.readStore()).receipts.find(
      (item) => item.id === id,
    );
    if (!found) throw new SetupImportError('RECEIPT_NOT_FOUND');
    return this.publicReceipt(found);
  }

  async rollback(id: string): Promise<SetupImportPublicReceipt> {
    const receipt = await this.findReceipt(id);
    if (receipt.rolledBackAt) return this.publicReceipt(receipt);
    // The effect journal, not the legacy aggregate arrays, is the rollback
    // worklist. This preserves the exact reviewed source/target relationship
    // through retries and process recovery.
    for (const effect of receipt.effects ?? []) {
      if (
        !effect.targetName ||
        !effect.revision ||
        !this.rollbackNeedsAttempt(effect)
      )
        continue;
      await this.transitionEffect(id, effect.id, 'compensating', {
        rollbackState: 'indeterminate',
        retryable: true,
      });
      try {
        const removed = await this.skillService.removeSkillIfRevision(
          effect.targetName,
          effect.revision,
          this.projectHomeDir(),
        );
        if (!removed.removed) {
          await this.transitionEffect(id, effect.id, 'applied', {
            reason: 'rollback-target-conflict',
            rollbackState: 'conflict',
            retryable: true,
          });
          continue;
        }
        await this.transitionEffect(id, effect.id, 'compensated', {
          reason: 'rollback-applied',
          rollbackState: 'applied',
          retryable: false,
        });
        await this.updateReceipt(id, (current) => {
          if (
            !current.rolledBack.some(
              (target) =>
                target.name === effect.targetName &&
                target.digest === effect.revision,
            )
          )
            current.rolledBack.push({
              name: effect.targetName!,
              digest: effect.revision!,
            });
        });
      } catch {
        // A thrown compare-delete has a possible effect. Leave that fact
        // explicit; receipt reads reconcile it against the canonical revision.
        await this.transitionEffect(id, effect.id, 'indeterminate', {
          reason: 'rollback-unconfirmed',
          rollbackState: 'indeterminate',
          retryable: true,
        });
      }
    }
    const current = await this.updateReceipt(id, (stored) => {
      const items = stored.effects ?? [];
      if (
        items.length > 0 &&
        items.every(
          (effect) => !effect.revision || effect.rollbackState === 'applied',
        )
      )
        stored.rolledBackAt ??= this.now().toISOString();
    });
    return this.publicReceipt(current);
  }

  private codexHome() {
    const configured = process.env.CODEX_HOME;
    if (configured && !isAbsolute(configured))
      throw new SetupImportError('SOURCE_UNAVAILABLE');
    return configured ?? join(homedir(), '.codex');
  }
  private promptsDir() {
    return join(this.codexHome(), 'prompts');
  }
  private storePath() {
    return join(resolveHomeDir(), 'setup-imports.json');
  }
  private receiptStore() {
    const empty = (): Persisted => ({
      schemaVersion: STORE_SCHEMA_VERSION,
      previews: [],
      receipts: [],
    });
    return (
      this.testHooks.receiptStore?.(this.storePath(), empty) ??
      new SetupImportReceiptStore(this.storePath(), empty)
    );
  }
  private exclude(excluded: Record<string, number>, reason: string) {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  }
  private childPath(parent: string, name: string) {
    if (basename(name) !== name) throw new SetupImportError('SOURCE_CHANGED');
    const path = resolve(parent, name);
    if (
      dirname(path) !== resolve(parent) ||
      relative(parent, path).startsWith('..')
    )
      throw new SetupImportError('SOURCE_CHANGED');
    return path;
  }
  private sourceId(name: string, sourceDigest: string) {
    const suffix = `:${sourceDigest.slice(0, 12)}`;
    // A max-length filename must not turn an otherwise safe preview into a
    // self-poisoning persisted id; preserve the discriminator exactly.
    return `${name.slice(0, SETUP_IMPORT_MAX_SOURCE_ID_LENGTH - suffix.length)}${suffix}`;
  }
  private async targetRevision(name: string): Promise<string | undefined> {
    try {
      return await this.skillService.localSkillRevision(
        name,
        this.projectHomeDir(),
      );
    } catch {
      return undefined;
    }
  }
  private async assertSafeDirectory(
    path: string,
    required: boolean,
  ): Promise<DirectoryBinding> {
    try {
      const chain = await bindGuardedDirectories(path);
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new SetupImportError('SOURCE_UNAVAILABLE');
      await revalidateGuardedDirectories(path, chain);
      return boundDirectoryIdentity(stat);
    } catch (error) {
      if (error instanceof SetupImportError) throw error;
      if (required || (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new SetupImportError('SOURCE_UNAVAILABLE');
    }
    throw new SetupImportError('SOURCE_UNAVAILABLE');
  }
  private async assertDirectoryBinding(
    path: string,
    binding: DirectoryBinding,
  ) {
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== binding.dev ||
      stat.ino !== binding.ino ||
      stat.nlink !== binding.nlink ||
      stat.size !== binding.size ||
      stat.mtimeMs !== binding.mtimeMs ||
      stat.ctimeMs !== binding.ctimeMs
    )
      throw new SetupImportError('SOURCE_CHANGED');
  }
  private async readBoundedRegularFile(path: string): Promise<
    | {
        ok: true;
        content: string;
        size: number;
        digest: string;
        dev: number;
        ino: number;
        mtimeMs: number;
      }
    | { ok: false; reason: string }
  > {
    try {
      const listed = await lstat(path);
      if (listed.isSymbolicLink()) return { ok: false, reason: 'symlink' };
      if (!listed.isFile()) return { ok: false, reason: 'special-file' };
      if (listed.nlink !== 1) return { ok: false, reason: 'hard-link' };
      if (listed.size > MAX_FILE_BYTES)
        return { ok: false, reason: 'file-size-limit' };
      const read = await readGuardedUtf8(path, MAX_FILE_BYTES, {
        parentDirectory: dirname(path),
      });
      const stat = read.stat;
      return {
        ok: true,
        content: read.content,
        size: stat.size,
        digest: read.digest,
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('byte limit'))
        return { ok: false, reason: 'file-size-limit' };
      if (message.includes('changed'))
        return { ok: false, reason: 'source-changed' };
      if (message.includes('unsafe'))
        return { ok: false, reason: 'special-file' };
      if (message.includes('encoded data'))
        return { ok: false, reason: 'invalid-utf8' };
      return { ok: false, reason: 'unreadable' };
    }
  }
  private matches(
    binding: SourceBinding,
    read: Exclude<
      Awaited<ReturnType<typeof this.readBoundedRegularFile>>,
      { ok: false }
    >,
  ) {
    return (
      binding.size === read.size &&
      binding.digest === read.digest &&
      binding.dev === read.dev &&
      binding.ino === read.ino &&
      binding.mtimeMs === read.mtimeMs
    );
  }
  private publicPreview(record: PreviewRecord): SetupImportPreview {
    const {
      entries,
      directories: _directories,
      adapterVersion: _adapterVersion,
      ...rest
    } = record;
    return {
      ...rest,
      entries: entries.map(
        ({ dev: _dev, ino: _ino, mtimeMs: _mtime, collision, ...entry }) => ({
          ...entry,
          collision,
          warnings: collision ? ['target-collision'] : [],
        }),
      ),
      warnings: Object.keys(record.excluded)
        .sort()
        .map((reason) => `excluded:${reason}`),
    };
  }
  private publicWitness(witness: TargetWitness) {
    return {
      id: witness.id,
      expiresAt: witness.expiresAt,
      items: witness.items.map(
        ({ id, action, targetName, targetRevision }) => ({
          id,
          action,
          ...(targetName ? { targetName } : {}),
          ...(targetRevision !== undefined ? { targetRevision } : {}),
        }),
      ),
    };
  }
  private publicReceipt(receipt: ReceiptRecord): SetupImportPublicReceipt {
    const items = (receipt.effects ?? []).map((effect) =>
      this.publicItem(effect),
    );
    return {
      id: receipt.id,
      createdAt: receipt.createdAt,
      previewId: receipt.previewId,
      items,
      retryable: items.some((item) => item.rollback.retryable),
      ...(receipt.rolledBackAt ? { rolledBackAt: receipt.rolledBackAt } : {}),
    };
  }
  private publicItem(effect: EffectRecord): SetupImportPublicItem {
    const rollback = this.publicRollback(effect);
    const outcome =
      effect.state === 'applied'
        ? 'imported'
        : effect.state === 'skipped'
          ? 'skipped'
          : effect.state === 'compensated'
            ? 'rolled-back'
            : effect.state === 'failed'
              ? 'failed'
              : 'indeterminate';
    return {
      sourceId: effect.id,
      ...(effect.targetName ? { reviewedTarget: effect.targetName } : {}),
      state: effect.state,
      outcome,
      ...(effect.reason ? { reasonCode: effect.reason } : {}),
      ...(this.repairCode(effect)
        ? { repairCode: this.repairCode(effect) }
        : {}),
      ...(effect.revision ? { targetRevision: effect.revision } : {}),
      rollback,
    };
  }
  private publicRollback(effect: EffectRecord): {
    state: RollbackState;
    retryable: boolean;
  } {
    if (effect.rollbackState)
      return {
        state: effect.rollbackState,
        retryable: effect.retryable ?? effect.rollbackState !== 'applied',
      };
    if (effect.state === 'applied')
      return { state: 'available', retryable: true };
    if (effect.state === 'compensated')
      return { state: 'applied', retryable: false };
    if (effect.state === 'indeterminate')
      return { state: 'indeterminate', retryable: true };
    return { state: 'failed', retryable: effect.retryable ?? false };
  }
  private repairCode(effect: EffectRecord): string | undefined {
    switch (effect.reason) {
      case 'invalid-target':
        return 'choose-valid-target';
      case 'target-not-absent':
      case 'target-conflict':
        return 'choose-different-target';
      case 'source-changed':
      case 'source-invalid':
      case 'source-namespace-changed':
      case 'recovered-no-publication':
        return 'create-new-preview';
      case 'recovered-pending-no-effect':
        return 're-preview';
      case 'rollback-target-conflict':
      case 'target-changed-during-compensation':
        return 'resolve-target-conflict-and-retry';
      case 'rollback-unconfirmed':
      case 'compensation-incomplete':
        return 'retry-rollback';
      case 'missing-target':
        return 'inspect-receipt';
      default:
        return undefined;
    }
  }
  private rollbackNeedsAttempt(effect: EffectRecord) {
    return (
      Boolean(effect.revision) &&
      (effect.state === 'applied' || effect.state === 'indeterminate') &&
      this.publicRollback(effect).retryable
    );
  }
  private pruneReceipts(receipts: ReceiptRecord[]) {
    const cutoff = this.now().getTime() - RECEIPT_TTL_MS;
    return receipts
      .filter((receipt) => Date.parse(receipt.createdAt) >= cutoff)
      .slice(-MAX_RECEIPTS);
  }
  private async readStore(): Promise<Persisted> {
    try {
      const parsed = (await this.receiptStore().read<Persisted>()) as Persisted;
      if (
        parsed.schemaVersion !== STORE_SCHEMA_VERSION ||
        !Array.isArray(parsed.previews) ||
        !Array.isArray(parsed.receipts)
      ) {
        throw new Error('invalid setup import receipt store schema');
      }
      return this.normalizeStore(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          schemaVersion: STORE_SCHEMA_VERSION,
          previews: [],
          receipts: [],
        };
      }
      throw new SetupImportError('STORE_UNAVAILABLE');
    }
  }
  private normalizeStore(store: Persisted): Persisted {
    if (
      store.schemaVersion !== STORE_SCHEMA_VERSION ||
      !Array.isArray(store.previews) ||
      !Array.isArray(store.receipts) ||
      store.previews.length > MAX_RECEIPTS ||
      store.receipts.length > MAX_RECEIPTS ||
      !store.previews.every(previewRecord) ||
      !store.receipts.every(receiptRecord)
    ) {
      throw new Error('invalid setup import receipt store schema');
    }
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      previews: store.previews,
      receipts: this.pruneReceipts(store.receipts).map((receipt) => ({
        ...receipt,
        rolledBack: receipt.rolledBack ?? [],
        effects: receipt.effects ?? [],
      })),
    };
  }
  private async mutateStore<T>(update: (store: Persisted) => T): Promise<T> {
    let result: T;
    let updateError: unknown;
    try {
      await this.receiptStore().mutate<Persisted>((current) => {
        try {
          const store = this.normalizeStore(current);
          result = update(store);
          // Validate/canonicalize the complete next state, not only what was
          // read. A malformed callback result must never become durable.
          const canonical = this.normalizeStore(store);
          store.previews = canonical.previews;
          store.receipts = canonical.receipts;
          return store;
        } catch (error) {
          updateError = error;
          throw error;
        }
      });
    } catch {
      if (updateError instanceof SetupImportError) throw updateError;
      throw new SetupImportError('STORE_UNAVAILABLE');
    }
    return result!;
  }
  private async findReceipt(id: string): Promise<ReceiptRecord> {
    const receipt = (await this.readStore()).receipts.find(
      (item) => item.id === id,
    );
    if (!receipt) throw new SetupImportError('RECEIPT_NOT_FOUND');
    return receipt;
  }
  private async updateReceipt(
    id: string,
    update: (receipt: ReceiptRecord) => void,
  ): Promise<ReceiptRecord> {
    return this.mutateStore((store) => {
      const receipt = store.receipts.find((item) => item.id === id);
      if (!receipt) throw new SetupImportError('RECEIPT_NOT_FOUND');
      if (receipt.rolledBackAt) throw new SetupImportError('RECEIPT_CONFLICT');
      update(receipt);
      return receipt;
    });
  }
  private async transitionEffect(
    receiptId: string,
    effectId: string,
    state: EffectState,
    facts: Partial<
      Pick<
        EffectRecord,
        | 'targetRevision'
        | 'revision'
        | 'reason'
        | 'rollbackState'
        | 'retryable'
        | 'expectedRevision'
      >
    > = {},
  ) {
    return this.updateReceipt(receiptId, (receipt) => {
      const effect = receipt.effects?.find(
        (candidate) => candidate.id === effectId,
      );
      if (!effect) throw new Error('Setup import effect is unavailable.');
      Object.assign(effect, facts, {
        state,
        updatedAt: this.now().toISOString(),
      });
    });
  }
  private async failEffect(
    receiptId: string,
    effectId: string,
    reason: string,
    facts: Partial<Pick<EffectRecord, 'targetRevision'>> = {},
  ) {
    await this.transitionEffect(receiptId, effectId, 'failed', {
      ...facts,
      reason,
    });
    await this.updateReceipt(receiptId, (current) => {
      current.failed++;
    });
  }
  /** Reconcile a crash between effect execution and terminal receipt write. */
  private async reconcileReceipt(id: string) {
    const receipt = await this.findReceipt(id);
    for (const effect of receipt.effects ?? []) {
      if (effect.state === 'pending') {
        // Receipt creation is durable before any effect begins. A restart at
        // this point proves no publication was attempted, so pending must not
        // become a forever-actionable lie.
        await this.transitionEffect(id, effect.id, 'failed', {
          reason: 'recovered-pending-no-effect',
          retryable: true,
        });
        continue;
      }
      if (effect.state !== 'applying' && effect.state !== 'compensating')
        continue;
      if (!effect.targetName) {
        await this.transitionEffect(id, effect.id, 'indeterminate', {
          reason: 'missing-target',
        });
        continue;
      }
      let revision: string | undefined;
      try {
        revision = await this.skillService.localSkillRevision(
          effect.targetName,
          this.projectHomeDir(),
        );
      } catch {}
      if (effect.state === 'applying') {
        if (
          revision &&
          effect.expectedRevision &&
          revision === effect.expectedRevision
        ) {
          await this.transitionEffect(id, effect.id, 'applied', {
            revision,
            reason: 'recovered-after-apply',
            rollbackState: 'available',
            retryable: true,
          });
          await this.updateReceipt(id, (current) => {
            if (
              !current.imported.some((item) => item.name === effect.targetName)
            )
              current.imported.push({
                name: effect.targetName!,
                digest: revision!,
              });
          });
        } else if (!revision)
          await this.transitionEffect(id, effect.id, 'failed', {
            reason: 'recovered-no-publication',
          });
        else
          await this.transitionEffect(id, effect.id, 'indeterminate', {
            reason: 'target-changed-during-apply',
            rollbackState: 'conflict',
            retryable: true,
          });
      } else if (!revision) {
        await this.transitionEffect(id, effect.id, 'compensated', {
          reason: 'recovered-after-compensation',
          rollbackState: 'applied',
          retryable: false,
        });
      } else if (effect.revision && revision === effect.revision) {
        await this.transitionEffect(id, effect.id, 'indeterminate', {
          reason: 'compensation-incomplete',
          rollbackState: 'indeterminate',
          retryable: true,
        });
      } else {
        await this.transitionEffect(id, effect.id, 'indeterminate', {
          reason: 'target-changed-during-compensation',
          rollbackState: 'conflict',
          retryable: true,
        });
      }
    }
  }
  private assertApplyInput(
    preview: PreviewRecord,
    input: {
      items: Array<{
        id: string;
        action: 'import' | 'skip';
        targetName?: string;
      }>;
    },
  ) {
    const intents = new Map(input.items.map((item) => [item.id, item]));
    if (
      intents.size !== input.items.length ||
      intents.size !== preview.entries.length ||
      preview.entries.some((entry) => !intents.has(entry.id))
    ) {
      throw new SetupImportError('INVALID_APPLY');
    }
  }
  private assertWitness(preview: PreviewRecord, witness: TargetWitness) {
    if (
      witness.adapterVersion !== SOURCE_ADAPTER_VERSION ||
      witness.items.length !== preview.entries.length
    )
      throw new SetupImportError('INVALID_APPLY');
    const ids = new Set(witness.items.map((item) => item.id));
    if (
      ids.size !== witness.items.length ||
      preview.entries.some((entry) => !ids.has(entry.id))
    )
      throw new SetupImportError('INVALID_APPLY');
  }
}
