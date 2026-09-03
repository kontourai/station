import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  link,
  mkdtemp,
  realpath,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  SETUP_IMPORT_MAX_SOURCE_ID_LENGTH,
  SETUP_IMPORT_MAX_TARGET_NAME_LENGTH,
} from '@kontourai/station-shared/setup-import-bounds';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ExistingAgentSetupImportModule,
  SetupImportError,
} from '../existing-agent-setup-import.js';
import { readGuardedUtf8 } from '../guarded-setup-import-filesystem.js';
import { SetupImportReceiptStore } from '../setup-import-receipt-store.js';

// The shared lifecycle-lock suite owns process-identity availability. This
// receipt-serialization suite keeps its real store and lock, but supplies a
// stable owner fingerprint so unrelated host process probes cannot make its
// concurrent receipt/rollback assertions flaky.
const processIdentity = vi.hoisted(() => ({
  birth: 'setup-import-test-process-birth' as string | null,
}));

vi.mock('@kontourai/station-shared/process-identity', async () => {
  const actual = await vi.importActual<
    typeof import('@kontourai/station-shared/process-identity')
  >('@kontourai/station-shared/process-identity');
  return {
    ...actual,
    lookupProcessBirthFingerprintCachedAsync: async () => processIdentity.birth,
  };
});

vi.mock('../../../telemetry/metrics.js', () => ({
  skillDiscoveries: { add: vi.fn() },
  skillActivations: { add: vi.fn() },
  skillActivationDuration: { record: vi.fn() },
  skillDiscoveryDuration: { record: vi.fn() },
  skillOps: { add: vi.fn() },
  canonicalSkillsDiscovered: { add: vi.fn() },
}));
const { SkillService } = await import('../../agents/skill-service.js');

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0))
    rmSync(dir, { recursive: true, force: true });
  delete process.env.CODEX_HOME;
  delete process.env.STATION_HOME;
  processIdentity.birth = 'setup-import-test-process-birth';
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'station-setup-import-')),
  );
  cleanup.push(root);
  const codex = join(root, 'codex');
  const project = join(root, 'project');
  mkdirSync(join(codex, 'prompts'), { recursive: true });
  process.env.CODEX_HOME = codex;
  process.env.STATION_HOME = join(root, 'station');
  const loader = {
    getProjectHomeDir: () => project,
    saveSkill: async (name: string, value: unknown) => {
      mkdirSync(join(project, 'skills', name), { recursive: true });
      writeFileSync(
        join(project, 'skills', name, 'skill.json'),
        JSON.stringify(value, null, 2),
      );
    },
    loadSkill: async (name: string) =>
      JSON.parse(
        readFileSync(join(project, 'skills', name, 'skill.json'), 'utf8'),
      ),
    deleteSkill: async (name: string) =>
      rmSync(join(project, 'skills', name), { recursive: true, force: true }),
    listSkills: async () => [],
    skillExists: async () => false,
  };
  const service = new SkillService(loader as never, {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  });
  return {
    root,
    codex,
    project,
    service,
    module: new ExistingAgentSetupImportModule(service, () => project),
  };
}

async function reviewedApply(
  module: ExistingAgentSetupImportModule,
  input: {
    previewId: string;
    items: Array<{
      id: string;
      action: 'import' | 'skip';
      targetName?: string;
    }>;
  },
) {
  const reviewed = await module.reviewTargets(input);
  return module.apply({
    previewId: input.previewId,
    witnessId: reviewed.witness.id,
  });
}

/** A real on-disk ConfigLoader-shaped authority shared by multiple services. */
function serviceFor(
  project: string,
  faults: { saveAfterWrite?: boolean; deleteFails?: boolean } = {},
) {
  const loader = {
    getProjectHomeDir: () => project,
    saveSkill: async (name: string, value: unknown) => {
      const target = join(project, 'skills', name);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'skill.json'), JSON.stringify(value, null, 2));
      if (faults.saveAfterWrite) throw new Error('injected after skill.json');
    },
    loadSkill: async (name: string) => {
      const path = join(project, 'skills', name, 'skill.json');
      if (!existsSync(path)) {
        const error = Object.assign(new Error('absent'), { code: 'ENOENT' });
        throw error;
      }
      return JSON.parse(readFileSync(path, 'utf8'));
    },
    deleteSkill: async (name: string) => {
      if (faults.deleteFails) throw new Error('injected compensation failure');
      rmSync(join(project, 'skills', name), { recursive: true, force: true });
    },
    listSkills: async () => [],
    skillExists: async () => false,
  };
  return new SkillService(loader as never, {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  });
}

describe('ExistingAgentSetupImportModule', () => {
  test.each([
    {
      name: 'symlinked store target',
      prepare: async (store: string, root: string) => {
        writeFileSync(join(root, 'outside-store.json'), '{}');
        await symlink(join(root, 'outside-store.json'), store);
      },
    },
    {
      name: 'hard-linked store target',
      prepare: async (store: string, root: string) => {
        const original = join(root, 'store-source.json');
        writeFileSync(original, '{}');
        await link(original, store);
      },
    },
    {
      name: 'oversized store target',
      prepare: async (store: string) => {
        writeFileSync(store, 'x'.repeat(256 * 1024 + 1));
      },
    },
    {
      name: 'corrupt store contents',
      prepare: async (store: string) => {
        writeFileSync(store, '{not-json');
      },
    },
    {
      name: 'wrong store schema',
      prepare: async (store: string) => {
        writeFileSync(
          store,
          JSON.stringify({ schemaVersion: 2, previews: [], receipts: [] }),
        );
      },
    },
  ])(
    'fails closed for $name through the production receipt store',
    async ({ prepare }) => {
      const { codex, root, module } = await fixture();
      writeFileSync(join(codex, 'prompts', 'review.md'), 'review prompt');
      const station = join(root, 'station');
      mkdirSync(station, { recursive: true });
      await prepare(join(station, 'setup-imports.json'), root);

      await expect(module.preview('codex-prompts')).rejects.toThrow(
        'STORE_UNAVAILABLE',
      );
    },
  );

  test('returns content-free immediate markdown previews and imports through SkillService', async () => {
    const { codex, project, module } = await fixture();
    writeFileSync(
      join(codex, 'prompts', 'review.md'),
      '# Review\nUse the diff.',
    );
    writeFileSync(join(codex, 'prompts', 'secret.txt'), 'not a prompt');
    const preview = await module.preview('codex-prompts');
    expect(JSON.stringify(preview)).not.toContain('Use the diff');
    expect(JSON.stringify(preview)).not.toContain(codex);
    expect(preview.entries).toEqual([
      expect.objectContaining({ name: 'review.md', skillName: 'review' }),
    ]);
    expect(preview.excluded['not-markdown']).toBe(1);
    const receipt = await reviewedApply(module, {
      previewId: preview.id,
      items: preview.entries.map((entry) => ({
        id: entry.id,
        action: 'import',
        targetName: entry.skillName,
      })),
    });
    expect(receipt.items).toEqual([
      expect.objectContaining({
        sourceId: preview.entries[0]!.id,
        reviewedTarget: 'review',
        state: 'applied',
        outcome: 'imported',
        targetRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
        rollback: { state: 'available', retryable: true },
      }),
    ]);
    expect(JSON.stringify(receipt)).not.toContain(codex);
    expect(JSON.stringify(receipt)).not.toContain('Use the diff');
    expect(preview.warnings).toEqual(['excluded:not-markdown']);
    expect(existsSync(join(project, 'skills', 'review', 'SKILL.md'))).toBe(
      true,
    );
  });

  test('uses the real SkillService capability when an ordinary writer races setup import', async () => {
    const { codex, project, service, module } = await fixture();
    writeFileSync(join(codex, 'prompts', 'review.md'), 'from setup');
    const preview = await module.preview('codex-prompts');
    const [receipt, ordinary] = await Promise.all([
      reviewedApply(module, {
        previewId: preview.id,
        items: preview.entries.map((entry) => ({
          id: entry.id,
          action: 'import' as const,
          targetName: 'shared',
        })),
      }),
      service.createLocalSkill({ name: 'shared', body: 'ordinary' }, project),
    ]);
    expect(
      Number(receipt.items[0]?.outcome === 'imported') +
        Number(ordinary.success),
    ).toBe(1);
    expect(existsSync(join(project, 'skills', 'shared', 'skill.json'))).toBe(
      true,
    );
  });

  test('serializes same-target setup, ordinary create, update, and compare-delete across service instances', async () => {
    const { codex, project } = await fixture();
    const setupService = serviceFor(project);
    const ordinaryService = serviceFor(project);
    const module = new ExistingAgentSetupImportModule(
      setupService,
      () => project,
    );
    writeFileSync(join(codex, 'prompts', 'review.md'), 'from setup');
    const preview = await module.preview('codex-prompts');
    const [receipt, ordinary] = await Promise.all([
      reviewedApply(module, {
        previewId: preview.id,
        items: [
          {
            id: preview.entries[0]!.id,
            action: 'import',
            targetName: 'shared',
          },
        ],
      }),
      ordinaryService.createLocalSkill(
        { name: 'shared', body: 'ordinary' },
        project,
      ),
    ]);
    expect(
      Number(receipt.items[0]?.outcome === 'imported') +
        Number(ordinary.success),
    ).toBe(1);

    const revision = await setupService.localSkillRevision('shared', project);
    const [updated, removed] = await Promise.allSettled([
      ordinaryService.updateLocalSkill(
        'shared',
        { body: 'preserve this edit' },
        project,
      ),
      setupService.removeSkillIfRevision('shared', revision, project),
    ]);
    const skillPath = join(project, 'skills', 'shared', 'SKILL.md');
    if (existsSync(skillPath)) {
      expect(readFileSync(skillPath, 'utf8')).toContain('preserve this edit');
      expect(updated.status).toBe('fulfilled');
      expect(removed).toMatchObject({
        status: 'fulfilled',
        value: { conflict: true },
      });
    } else {
      expect(removed).toMatchObject({
        status: 'fulfilled',
        value: { removed: true },
      });
      expect(updated.status).toBe('rejected');
    }
  });

  test('compensates a skill.json-only failure or retains a durable indeterminate effect', async () => {
    const { codex, project } = await fixture();
    const compensated = serviceFor(project, { saveAfterWrite: true });
    await expect(
      compensated.createLocalSkill(
        { name: 'compensated', body: 'body' },
        project,
      ),
    ).rejects.toThrow('injected after skill.json');
    expect(existsSync(join(project, 'skills', 'compensated'))).toBe(false);

    const indeterminate = serviceFor(project, {
      saveAfterWrite: true,
      deleteFails: true,
    });
    const module = new ExistingAgentSetupImportModule(
      indeterminate,
      () => project,
    );
    writeFileSync(join(codex, 'prompts', 'review.md'), 'review');
    const preview = await module.preview('codex-prompts');
    const receipt = await reviewedApply(module, {
      previewId: preview.id,
      items: [
        {
          id: preview.entries[0]!.id,
          action: 'import',
          targetName: 'uncertain',
        },
      ],
    });
    expect(receipt.items).toEqual([
      expect.objectContaining({
        outcome: 'indeterminate',
        state: 'indeterminate',
        reasonCode: 'publication-compensation-indeterminate',
        rollback: { state: 'indeterminate', retryable: true },
      }),
    ]);
    expect(existsSync(join(project, 'skills', 'uncertain', 'skill.json'))).toBe(
      true,
    );
    expect(existsSync(join(project, 'skills', 'uncertain', 'SKILL.md'))).toBe(
      false,
    );
  });

  test('records a recoverable indeterminate receipt when finalization and exact compensation both fail', async () => {
    const { codex, project, root } = await fixture();
    const service = serviceFor(project);
    writeFileSync(join(codex, 'prompts', 'review.md'), 'review');
    let mutations = 0;
    let faultingStore: SetupImportReceiptStore | undefined;
    const module = new ExistingAgentSetupImportModule(
      service,
      () => project,
      undefined,
      {
        receiptStore: (path, empty) => {
          faultingStore ??= new (class extends SetupImportReceiptStore {
            override async mutate<T>(update: (current: T) => T): Promise<T> {
              const result = await super.mutate(update);
              if (++mutations === 6)
                throw new Error('injected post-commit finalization fault');
              return result;
            }
          })(path, empty);
          return faultingStore;
        },
        afterSkillPublished: async ({ name }) => {
          // This is an actual out-of-band edit after the authoritative
          // revision was observed, so compare-and-delete must retain it.
          await writeFile(join(project, 'skills', name, 'SKILL.md'), 'edited');
        },
      },
    );
    const preview = await module.preview('codex-prompts');
    const receipt = await reviewedApply(module, {
      previewId: preview.id,
      items: [
        {
          id: preview.entries[0]!.id,
          action: 'import',
          targetName: 'recoverable',
        },
      ],
    });
    expect(receipt.items).toEqual([
      expect.objectContaining({
        outcome: 'indeterminate',
        state: 'indeterminate',
        reasonCode: 'compensation-conflict',
        rollback: { state: 'indeterminate', retryable: true },
      }),
    ]);
    expect(existsSync(join(project, 'skills', 'recoverable'))).toBe(true);
    const persisted = JSON.parse(
      readFileSync(join(root, 'station', 'setup-imports.json'), 'utf8'),
    );
    expect(persisted.receipts[0].effects[0].state).toBe('indeterminate');
    expect(
      (
        await new ExistingAgentSetupImportModule(
          service,
          () => project,
        ).receipt(receipt.id)
      ).items,
    ).toEqual([
      expect.objectContaining({
        outcome: 'indeterminate',
        state: 'indeterminate',
        reasonCode: 'compensation-conflict',
        rollback: { state: 'indeterminate', retryable: true },
      }),
    ]);
  });

  test('restart reconciliation settles persisted pending, applying, and compensating effects from canonical revisions', async () => {
    const { codex, project, root } = await fixture();
    const service = serviceFor(project);
    const module = new ExistingAgentSetupImportModule(service, () => project);
    writeFileSync(join(codex, 'prompts', 'review.md'), 'review');
    const preview = await module.preview('codex-prompts');
    const receipt = await reviewedApply(module, {
      previewId: preview.id,
      items: [
        { id: preview.entries[0]!.id, action: 'import', targetName: 'recover' },
      ],
    });
    const storePath = join(root, 'station', 'setup-imports.json');
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    const persisted = store.receipts.find(
      (item: { id: string }) => item.id === receipt.id,
    );
    persisted.imported = [];
    persisted.effects[0].state = 'applying';
    persisted.effects[0].revision = undefined;
    writeFileSync(storePath, JSON.stringify(store));
    const restarted = new ExistingAgentSetupImportModule(
      service,
      () => project,
    );
    const recovered = await restarted.receipt(receipt.id);
    expect(recovered.items).toEqual([
      expect.objectContaining({
        outcome: 'imported',
        state: 'applied',
        reasonCode: 'recovered-after-apply',
        rollback: { state: 'available', retryable: true },
      }),
    ]);

    const afterApply = JSON.parse(readFileSync(storePath, 'utf8'));
    const effect = afterApply.receipts.find(
      (item: { id: string }) => item.id === receipt.id,
    ).effects[0];
    effect.state = 'pending';
    effect.reason = undefined;
    effect.rollbackState = undefined;
    effect.retryable = undefined;
    effect.revision = undefined;
    writeFileSync(storePath, JSON.stringify(afterApply));
    expect(
      (
        await new ExistingAgentSetupImportModule(
          service,
          () => project,
        ).receipt(receipt.id)
      ).items,
    ).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        state: 'failed',
        reasonCode: 'recovered-pending-no-effect',
        repairCode: 're-preview',
        rollback: { state: 'failed', retryable: true },
      }),
    ]);

    effect.state = 'compensating';
    effect.revision = await service.localSkillRevision('recover', project);
    await service.removeSkill('recover', project);
    writeFileSync(storePath, JSON.stringify(afterApply));
    expect(
      (
        await new ExistingAgentSetupImportModule(
          service,
          () => project,
        ).receipt(receipt.id)
      ).items,
    ).toEqual([
      expect.objectContaining({
        outcome: 'rolled-back',
        state: 'compensated',
        reasonCode: 'recovered-after-compensation',
        rollback: { state: 'applied', retryable: false },
      }),
    ]);
  });

  test('reads guarded source bytes from one descriptor and rejects growth, link-count, and directory swaps after open', async () => {
    const { root } = await fixture();
    const sourceDir = join(root, 'guarded');
    mkdirSync(sourceDir);
    const source = join(sourceDir, 'source.md');
    writeFileSync(source, 'safe');
    await expect(
      readGuardedUtf8(source, 4, {
        parentDirectory: sourceDir,
        afterOpenForTest: async () => {
          await writeFile(source, 'grows beyond the ceiling');
        },
      }),
    ).rejects.toThrow(/byte limit|changed/);

    writeFileSync(source, 'safe');
    await expect(
      readGuardedUtf8(source, 64, {
        parentDirectory: sourceDir,
        afterOpenForTest: async () => {
          await link(source, join(sourceDir, 'late-hard-link'));
        },
      }),
    ).rejects.toThrow('changed during read');

    rmSync(join(sourceDir, 'late-hard-link'));
    writeFileSync(source, 'safe');
    const restored = await readGuardedUtf8(source, 64, {
      parentDirectory: sourceDir,
      afterOpenForTest: async () => {
        const moved = join(root, 'guarded-moved');
        await rename(sourceDir, moved);
        mkdirSync(sourceDir);
        await writeFile(join(sourceDir, 'source.md'), 'attacker');
        // Restore the original directory before the reader's final path
        // check. Its single descriptor must still return the original bytes,
        // never the attacker pathname that existed during the read.
        rmSync(sourceDir, { recursive: true, force: true });
        await rename(moved, sourceDir);
      },
    });
    expect(restored.content).toBe('safe');
  });

  test('refuses a prompt-directory substitution immediately before bound enumeration', async () => {
    const { codex, project, service } = await fixture();
    const prompts = join(codex, 'prompts');
    const parked = join(codex, 'prompts-original');
    writeFileSync(join(prompts, 'review.md'), 'reviewed bytes');
    const module = new ExistingAgentSetupImportModule(
      service,
      () => project,
      undefined,
      {
        beforePromptEnumerationForTest: () => {
          renameSync(prompts, parked);
          mkdirSync(prompts);
          writeFileSync(join(prompts, 'attacker.md'), 'attacker bytes');
        },
      },
    );
    await expect(module.preview('codex-prompts')).rejects.toThrow(
      'SOURCE_UNAVAILABLE',
    );
    // The attacker directory remained selected at spawn, so a result cannot
    // contain either its filename or bytes. Restore only after the refusal.
    rmSync(prompts, { recursive: true, force: true });
    renameSync(parked, prompts);
  });

  test('refuses a prompt substitution before expected identity refresh even when restored after enumeration', async () => {
    const { codex, project, service } = await fixture();
    const prompts = join(codex, 'prompts');
    const parked = join(codex, 'prompts-original');
    writeFileSync(join(prompts, 'review.md'), 'reviewed bytes');
    let restored = false;
    const module = new ExistingAgentSetupImportModule(
      service,
      () => project,
      undefined,
      {
        beforePromptExpectedIdentityForTest: () => {
          renameSync(prompts, parked);
          // An empty replacement would make a freshly rebound helper succeed
          // with an empty preview. The original path is restored only after
          // that helper has emitted its result.
          mkdirSync(prompts);
        },
        afterPromptEnumerationForTest: () => {
          rmSync(prompts, { recursive: true, force: true });
          renameSync(parked, prompts);
          restored = true;
        },
      },
    );
    await expect(module.preview('codex-prompts')).rejects.toThrow(
      'SOURCE_UNAVAILABLE',
    );
    // The original identity must reject the replacement before it can emit a
    // result, so the post-enumeration restoration hook is never reached.
    expect(restored).toBe(false);
    rmSync(prompts, { recursive: true, force: true });
    renameSync(parked, prompts);
  });

  test('accepts the maximum filename-derived source id and maximum target name', async () => {
    const { codex, project, module } = await fixture();
    const filename = `${'a'.repeat(252)}.md`;
    const targetName = 'b'.repeat(SETUP_IMPORT_MAX_TARGET_NAME_LENGTH);
    writeFileSync(
      join(codex, 'prompts', filename),
      '---\nname: "named"\ndescription: "d"\n---\n\nbody',
    );
    const preview = await module.preview('codex-prompts');
    const entry = preview.entries[0]!;
    expect(filename.length).toBe(255);
    expect(entry.name).toBe(filename);
    expect(entry.id.length).toBeLessThanOrEqual(
      SETUP_IMPORT_MAX_SOURCE_ID_LENGTH,
    );
    const receipt = await reviewedApply(module, {
      previewId: preview.id,
      items: [{ id: entry.id, action: 'import', targetName }],
    });
    expect(receipt.items[0]).toMatchObject({
      outcome: 'imported',
      reviewedTarget: targetName,
    });
    expect(existsSync(join(project, 'skills', targetName, 'SKILL.md'))).toBe(
      true,
    );
  });

  test('receipt store refuses a pre-commit target swap instead of publishing over bytes it did not read', async () => {
    const { root } = await fixture();
    const path = join(root, 'store-race.json');
    writeFileSync(path, JSON.stringify({ value: 'original' }));
    const store = new SetupImportReceiptStore(path, () => ({ value: 'empty' }));
    const replacement = join(root, 'replacement.json');
    const result = store.mutate<{ value: string }>((current) => {
      writeFileSync(replacement, JSON.stringify({ value: 'attacker' }));
      renameSync(replacement, path);
      return { value: `${current.value}-next` };
    });
    await expect(result).rejects.toThrow('changed before commit');
    expect(readFileSync(path, 'utf8')).toContain('attacker');
  });

  test('receipt reads wait for the serialized writer lock before a guarded path replacement', async () => {
    const { root } = await fixture();
    const path = join(root, 'store-read-race.json');
    const store = new SetupImportReceiptStore(path, () => ({
      version: 'empty',
    }));
    await store.mutate(() => ({ version: 'before' }));

    const release = await acquireFileMutationLockAsync(`${path}.mutation`);
    let settled = false;
    const reading = store.read<{ version: string }>().finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    const replacement = join(root, 'store-read-race.next.json');
    writeFileSync(replacement, JSON.stringify({ version: 'after' }));
    renameSync(replacement, path);
    await release();

    await expect(reading).resolves.toEqual({ version: 'after' });
  });

  test('retains the declared 64 receipts and live previews within the bounded 30-day store', async () => {
    const { root, project } = await fixture();
    const max = 64;
    const entries = 32;
    const hash = 'a'.repeat(64);
    const long = (length: number) => 'x'.repeat(length);
    const timestamp = '2026-01-01T00:00:00.000Z';
    const directory = {
      dev: 1,
      ino: 1,
      nlink: 1,
      size: 1,
      mtimeMs: 1,
      ctimeMs: 1,
    };
    const source = {
      id: long(256),
      name: long(256),
      size: 256 * 1024,
      digest: hash,
      dev: 1,
      ino: 1,
      mtimeMs: 1,
      skillName: long(128),
      collision: false,
    };
    const preview = {
      id: long(64),
      createdAt: timestamp,
      expiresAt: '2026-01-01T00:15:00.000Z',
      adapterVersion: 2,
      entries: Array.from({ length: entries }, () => source),
      excluded: Object.fromEntries(
        Array.from({ length: 128 }, (_, index) => [
          `${long(120)}${index}`,
          128,
        ]),
      ),
      directories: { root: directory, prompts: directory },
    };
    const target = { name: long(128), digest: hash };
    const effect = {
      id: long(256),
      action: 'import',
      targetName: long(128),
      sourceDigest: hash,
      adapterVersion: 1,
      targetRevision: hash,
      state: 'indeterminate',
      createdAt: timestamp,
      updatedAt: timestamp,
      reason: long(256),
      revision: hash,
    };
    const receipt = {
      id: long(64),
      createdAt: timestamp,
      previewId: long(64),
      imported: Array.from({ length: entries }, () => target),
      skipped: entries,
      failed: entries * 2,
      rolledBack: Array.from({ length: entries }, () => target),
      rolledBackAt: timestamp,
      effects: Array.from({ length: entries }, () => effect),
    };
    const path = join(root, 'station', 'setup-imports.json');
    const store = new SetupImportReceiptStore(path, () => ({
      schemaVersion: 1,
      previews: [],
      receipts: [],
    }));
    await store.mutate(() => ({
      schemaVersion: 1,
      previews: Array.from({ length: max }, () => preview),
      receipts: Array.from({ length: max }, () => receipt),
    }));
    expect(readFileSync(path).byteLength).toBeLessThan(8 * 1024 * 1024);
    const module = new ExistingAgentSetupImportModule(
      serviceFor(project),
      () => project,
      () => new Date(timestamp),
    );
    await expect(module.receipt('missing')).rejects.toThrow(
      'RECEIPT_NOT_FOUND',
    );
  });

  test('requires an absolute server-resolved CODEX_HOME, rejects a linked ancestor, and digests raw bytes', async () => {
    const { codex, root, module } = await fixture();
    process.env.CODEX_HOME = 'relative-codex-home';
    await expect(module.preview('codex-prompts')).rejects.toThrow(
      'SOURCE_UNAVAILABLE',
    );
    process.env.CODEX_HOME = join(root, 'codex-link');
    await symlink(codex, process.env.CODEX_HOME);
    await expect(module.preview('codex-prompts')).rejects.toThrow(
      'SOURCE_UNAVAILABLE',
    );
    process.env.CODEX_HOME = codex;
    const bytes = Buffer.from('# Caf\u00e9\nUse bytes.', 'utf8');
    writeFileSync(join(codex, 'prompts', 'bytes.md'), bytes);
    const preview = await module.preview('codex-prompts');
    expect(preview.entries[0]?.digest).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });

  test('excludes invalid UTF-8 and treats parseable nested receipt corruption as unavailable', async () => {
    const { codex, root, module } = await fixture();
    writeFileSync(
      join(codex, 'prompts', 'broken.md'),
      Buffer.from([0xff, 0xfe]),
    );
    writeFileSync(join(codex, 'prompts', 'valid.md'), 'valid');
    const preview = await module.preview('codex-prompts');
    expect(preview.excluded['invalid-utf8']).toBe(1);
    const storePath = join(root, 'station', 'setup-imports.json');
    const corrupted = JSON.parse(readFileSync(storePath, 'utf8'));
    corrupted.previews[0].directories.root.ino = 'not-an-inode';
    writeFileSync(storePath, JSON.stringify(corrupted));
    await expect(module.receipt('not-a-receipt')).rejects.toThrow(
      'STORE_UNAVAILABLE',
    );
  });

  test('refuses links, drift, and retains edited targets during exact rollback', async () => {
    const { codex, project, service, module } = await fixture();
    const prompts = join(codex, 'prompts');
    writeFileSync(join(prompts, 'one.md'), 'one');
    writeFileSync(join(prompts, 'linked-source.md'), 'two');
    await link(join(prompts, 'linked-source.md'), join(prompts, 'hard.md'));
    await symlink(join(prompts, 'one.md'), join(prompts, 'symlink.md'));
    const preview = await module.preview('codex-prompts');
    expect(preview.excluded['hard-link']).toBe(2);
    expect(preview.excluded.symlink).toBe(1);
    writeFileSync(join(prompts, 'one.md'), 'changed');
    const stale = await reviewedApply(module, {
      previewId: preview.id,
      items: preview.entries.map((entry) => ({
        id: entry.id,
        action: 'import',
        targetName: entry.skillName,
      })),
    });
    expect(stale.items[0]).toMatchObject({
      outcome: 'failed',
      reasonCode: 'source-changed',
      repairCode: 'create-new-preview',
    });
    const fresh = await module.preview('codex-prompts');
    const receipt = await reviewedApply(module, {
      previewId: fresh.id,
      items: fresh.entries.map((entry) => ({
        id: entry.id,
        action: 'import',
        targetName: entry.skillName,
      })),
    });
    const canonicalBody = readFileSync(
      join(project, 'skills', 'one', 'SKILL.md'),
      'utf8',
    );
    writeFileSync(join(project, 'skills', 'one', 'SKILL.md'), 'edited');
    const rolled = await module.rollback(receipt.id);
    expect(rolled.items[0]).toMatchObject({
      outcome: 'imported',
      rollback: { state: 'conflict', retryable: true },
      reasonCode: 'rollback-target-conflict',
      repairCode: 'resolve-target-conflict-and-retry',
    });
    expect(rolled.retryable).toBe(true);
    expect(existsSync(join(project, 'skills', 'one'))).toBe(true);

    // A restarted module retries the retained exact revision after the
    // operator resolves the conflict; it never relies on in-memory choices.
    writeFileSync(join(project, 'skills', 'one', 'SKILL.md'), canonicalBody);
    const restarted = new ExistingAgentSetupImportModule(
      service,
      () => project,
    );
    const retried = await restarted.rollback(receipt.id);
    expect(retried.items[0]).toMatchObject({
      outcome: 'rolled-back',
      rollback: { state: 'applied', retryable: false },
    });
    expect(retried.rolledBackAt).toEqual(expect.any(String));
  });

  test('requires an explicit collision disposition, persists receipts, and expires previews', async () => {
    const { codex, project, service, module } = await fixture();
    writeFileSync(join(codex, 'prompts', 'review.md'), 'review prompt');
    await service.createLocalSkill(
      { name: 'review', body: 'existing' },
      project,
    );
    const preview = await module.preview('codex-prompts');
    expect(preview.entries[0]).toEqual(
      expect.objectContaining({ collision: true, skillName: 'review' }),
    );
    const receipt = await reviewedApply(module, {
      previewId: preview.id,
      items: [
        {
          id: preview.entries[0]!.id,
          action: 'import',
          targetName: 'review-2',
        },
      ],
    });
    expect(receipt.items[0]).toMatchObject({
      reviewedTarget: 'review-2',
      outcome: 'imported',
    });
    const restarted = new ExistingAgentSetupImportModule(
      service,
      () => project,
    );
    expect(await restarted.receipt(receipt.id)).toEqual(
      expect.objectContaining({
        id: receipt.id,
        items: [
          expect.objectContaining({
            reviewedTarget: 'review-2',
            outcome: 'imported',
          }),
        ],
      }),
    );

    let time = new Date('2026-01-01T00:00:00.000Z');
    const expiring = new ExistingAgentSetupImportModule(
      service,
      () => project,
      () => time,
    );
    const expiringPreview = await expiring.preview('codex-prompts');
    time = new Date(time.getTime() + 16 * 60 * 1000);
    await expect(
      reviewedApply(expiring, {
        previewId: expiringPreview.id,
        items: expiringPreview.entries.map((entry) => ({
          id: entry.id,
          action: 'import',
          targetName: entry.skillName,
        })),
      }),
    ).rejects.toThrow('PREVIEW_EXPIRED');
  });

  test('serializes concurrent preview, apply, and rollback receipt transitions', async () => {
    const { codex, project } = await fixture();
    writeFileSync(join(codex, 'prompts', 'review.md'), 'review prompt');
    const created = new Set<string>();
    const skillService = {
      hasSkill: () => false,
      createLocalSkillIfAbsent: async (input: { name: string }) => {
        created.add(input.name);
        return { success: true };
      },
      localSkillRevision: async (name: string) => {
        if (!created.has(name)) throw new Error('absent');
        return createHash('sha256').update(name).digest('hex');
      },
      removeSkillIfRevision: async () => ({ removed: true, conflict: false }),
      projectLocalSkillPublication: (input: {
        name: string;
        body: string;
      }) => ({
        input,
        revision: createHash('sha256').update(input.name).digest('hex'),
      }),
    };
    const modules = Array.from(
      { length: 3 },
      () =>
        new ExistingAgentSetupImportModule(
          skillService as never,
          () => project,
        ),
    );

    // An unavailable own-process fingerprint is a lifecycle-lock failure, not
    // a receipt-serialization result. Keep this fault proof on the same
    // concurrent preview path, then restore the stable fixture identity for
    // the real receipt/apply/rollback assertions below.
    processIdentity.birth = null;
    const faultSettlements = await Promise.allSettled(
      modules.map((module) => module.preview('codex-prompts')),
    );
    try {
      expect(faultSettlements).toHaveLength(modules.length);
      for (const settlement of faultSettlements) {
        expect(settlement.status).toBe('rejected');
        if (settlement.status !== 'rejected') continue;
        expect(settlement.reason).toBeInstanceOf(SetupImportError);
        expect(settlement.reason.code).toBe('STORE_UNAVAILABLE');
      }
    } finally {
      processIdentity.birth = 'setup-import-test-process-birth';
    }

    const previews = [];
    for (const module of modules)
      previews.push(await module.preview('codex-prompts'));
    const receipts = [];
    for (const [index, preview] of previews.entries()) {
      receipts.push(
        await reviewedApply(modules[index]!, {
          previewId: preview.id,
          items: preview.entries.map((entry) => ({
            id: entry.id,
            action: 'import' as const,
            targetName: `${entry.skillName}-${index}`,
          })),
        }),
      );
    }
    expect(receipts.map((receipt) => receipt.items[0]?.reviewedTarget)).toEqual(
      ['review-0', 'review-1', 'review-2'],
    );

    const rollbacks = await Promise.all(
      receipts.map((receipt, index) => modules[index]!.rollback(receipt.id)),
    );
    expect(rollbacks.map(({ retryable }) => retryable)).toEqual([
      false,
      false,
      false,
    ]);
    const persisted = await Promise.all(
      receipts.map((receipt, index) => modules[index]!.receipt(receipt.id)),
    );
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          items: [
            expect.objectContaining({
              reviewedTarget: 'review-0',
              rollback: { state: 'applied', retryable: false },
            }),
          ],
          rolledBackAt: expect.any(String),
        }),
        expect.objectContaining({
          items: [
            expect.objectContaining({
              reviewedTarget: 'review-1',
              rollback: { state: 'applied', retryable: false },
            }),
          ],
          rolledBackAt: expect.any(String),
        }),
        expect.objectContaining({
          items: [
            expect.objectContaining({
              reviewedTarget: 'review-2',
              rollback: { state: 'applied', retryable: false },
            }),
          ],
          rolledBackAt: expect.any(String),
        }),
      ]),
    );
  });
});
