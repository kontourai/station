import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  deleteSkillPackageAt,
  saveSkillConfigIn,
} from '../../domain/config-loader-storage.js';
import { ExistingAgentSetupImportModule } from '../../services/setup/existing-agent-setup-import.js';
import { createSetupImportRoutes } from '../setup-imports.js';

// Same stable lock-owner fingerprint as the module suite, so host process
// probes cannot make the receipt store's lock flaky here.
vi.mock('@kontourai/station-shared/process-identity', async () => {
  const actual = await vi.importActual<
    typeof import('@kontourai/station-shared/process-identity')
  >('@kontourai/station-shared/process-identity');
  return {
    ...actual,
    lookupProcessBirthFingerprintCachedAsync: async () =>
      'setup-import-route-test-process-birth',
  };
});
vi.mock('../../telemetry/metrics.js', () => ({
  skillDiscoveries: { add: vi.fn() },
  skillActivations: { add: vi.fn() },
  skillActivationDuration: { record: vi.fn() },
  skillDiscoveryDuration: { record: vi.fn() },
  skillOps: { add: vi.fn() },
  canonicalSkillsDiscovered: { add: vi.fn() },
}));
const { SkillService } = await import('../../services/agents/skill-service.js');

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0))
    rmSync(dir, { recursive: true, force: true });
  delete process.env.CODEX_HOME;
  delete process.env.STATION_HOME;
});

/**
 * The real module behind the real routes, reading Codex prompts from a
 * fixture folder named by `CODEX_HOME` and writing skills to a temporary
 * project home, the way the Skills page's dialog drives it.
 */
async function realImportApp() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'station-setup-import-routes-')),
  );
  cleanup.push(root);
  const codex = join(root, 'codex');
  const project = join(root, 'project');
  mkdirSync(join(codex, 'prompts'), { recursive: true });
  process.env.CODEX_HOME = codex;
  process.env.STATION_HOME = join(root, 'station');
  const loader = {
    getProjectHomeDir: () => project,
    saveSkillIn: async (directory: string, value: unknown) =>
      saveSkillConfigIn(project, directory, value as never),
    deleteSkillAt: async (name: string, directory: string) =>
      deleteSkillPackageAt(project, name, directory),
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
  const app = createSetupImportRoutes(
    new ExistingAgentSetupImportModule(service, () => project),
    { operatorIdentityForRequest: () => 'operator' },
  );
  const post = async (path: string, body?: unknown) => {
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json()) as { success: boolean; data: any };
    expect(response.status, JSON.stringify(json)).toBeLessThan(300);
    return json.data;
  };
  const skillExists = (name: string) =>
    existsSync(join(project, 'skills', name, 'SKILL.md'));
  return { codex, project, service, post, skillExists };
}

describe('setup import routes', () => {
  test('refuses non-operators before any source filesystem access', async () => {
    const module = { sources: vi.fn(async () => []) };
    const app = createSetupImportRoutes(module as never, {
      operatorIdentityForRequest: () => undefined,
    });
    const response = await app.request('/sources');
    expect(response.status).toBe(403);
    expect(module.sources).not.toHaveBeenCalled();
  });

  test('permits only operator authority to reach the local module', async () => {
    const module = {
      sources: vi.fn(async () => [{ id: 'codex-prompts', available: false }]),
    };
    const app = createSetupImportRoutes(module as never, {
      operatorIdentityForRequest: () => 'operator',
    });
    const response = await app.request('/sources');
    expect(response.status).toBe(200);
    expect(module.sources).toHaveBeenCalledOnce();
  });

  test('passes the canonical itemized receipt through every receipt route', async () => {
    const receipt = {
      id: 'receipt-1',
      createdAt: 'now',
      previewId: 'preview-1',
      retryable: true,
      items: [
        {
          sourceId: 'review.md:abc',
          reviewedTarget: 'review',
          state: 'applied',
          outcome: 'imported',
          targetRevision: 'a'.repeat(64),
          rollback: { state: 'available', retryable: true },
        },
      ],
    };
    const module = {
      apply: vi.fn(async () => receipt),
      receipt: vi.fn(async () => receipt),
      rollback: vi.fn(async () => receipt),
    };
    const witnessId = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const app = createSetupImportRoutes(module as never, {
      operatorIdentityForRequest: () => 'operator',
    });

    await expect(
      (
        await app.request('/previews/preview-1/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ witnessId }),
        })
      ).json(),
    ).resolves.toEqual({ success: true, data: receipt });
    await expect(
      (await app.request('/receipts/receipt-1')).json(),
    ).resolves.toEqual({
      success: true,
      data: receipt,
    });
    await expect(
      (
        await app.request('/receipts/receipt-1/rollback', { method: 'POST' })
      ).json(),
    ).resolves.toEqual({ success: true, data: receipt });
    expect(module.apply).toHaveBeenCalledWith({
      previewId: 'preview-1',
      witnessId,
    });
    expect(module.receipt).toHaveBeenCalledWith('receipt-1');
    expect(module.rollback).toHaveBeenCalledWith('receipt-1');
  });

  test('hosted composition rejects even an operator before the module can touch local state', async () => {
    const module = { sources: vi.fn(async () => []) };
    const app = createSetupImportRoutes(module as never, {
      operatorIdentityForRequest: () => 'operator-credential',
      isHostedExecution: () => true,
    });
    const response = await app.request('/sources');
    expect(response.status).toBe(404);
    expect(module.sources).not.toHaveBeenCalled();
  });

  test('imports Codex prompts, renames a conflict inline, and undoes the whole import', async () => {
    const { codex, project, service, post, skillExists } =
      await realImportApp();
    const prompts = join(codex, 'prompts');
    writeFileSync(join(prompts, 'review-pr.md'), 'Review the pull request.');
    writeFileSync(join(prompts, 'write-tests.md'), 'Write focused tests.');
    writeFileSync(join(prompts, 'changelog.md'), 'Draft a changelog entry.');
    await service.createLocalSkill(
      { name: 'changelog', body: 'The skill the person already had.' },
      project,
    );

    const preview = await post('/previews', { sourceId: 'codex-prompts' });
    const byName = (skillName: string) =>
      preview.entries.find(
        (entry: { skillName: string }) => entry.skillName === skillName,
      );
    expect(byName('changelog').collision).toBe(true);
    expect(byName('review-pr').collision).toBe(false);

    const review = await post(`/previews/${preview.id}/targets`, {
      items: [
        {
          id: byName('review-pr').id,
          action: 'import',
          targetName: 'review-pr',
        },
        { id: byName('write-tests').id, action: 'skip' },
        {
          id: byName('changelog').id,
          action: 'import',
          targetName: 'changelog-codex',
        },
      ],
    });
    const receipt = await post(`/previews/${preview.id}/apply`, {
      witnessId: review.witness.id,
    });
    expect(
      receipt.items
        .filter((item: { outcome: string }) => item.outcome === 'imported')
        .map((item: { reviewedTarget: string }) => item.reviewedTarget)
        .sort(),
    ).toEqual(['changelog-codex', 'review-pr']);
    expect(skillExists('review-pr')).toBe(true);
    expect(skillExists('changelog-codex')).toBe(true);
    expect(skillExists('write-tests')).toBe(false);
    expect(receipt.retryable).toBe(true);

    const undone = await post(`/receipts/${receipt.id}/rollback`);
    expect(undone.rolledBackAt).toEqual(expect.any(String));
    expect(skillExists('review-pr')).toBe(false);
    expect(skillExists('changelog-codex')).toBe(false);
    // Undo removes only what the import created.
    expect(service.hasSkill('changelog')).toBe(true);
    expect(skillExists('changelog')).toBe(true);
    // No imported skill remains: the person's own skill is the only one left.
    expect(
      readdirSync(join(project, 'skills')).filter((name) => skillExists(name)),
    ).toEqual(['changelog']);
  });
});
