import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
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
import { parseImportedSkillMarkdown } from '../../services/agents/skill-metadata.js';
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
  const request = (path: string, init?: RequestInit) => app.request(path, init);
  const skillExists = (name: string) =>
    existsSync(join(project, 'skills', name, 'SKILL.md'));
  /** The imported skill as Station reads it back from its own SKILL.md. */
  const importedSkill = (name: string) =>
    parseImportedSkillMarkdown(
      'SKILL.md',
      readFileSync(join(project, 'skills', name, 'SKILL.md'), 'utf8'),
    );
  return {
    root,
    codex,
    project,
    service,
    post,
    request,
    skillExists,
    importedSkill,
  };
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
    // No imported skill remains, under its source name or the chosen one.
    for (const name of ['review-pr', 'changelog-codex', 'write-tests']) {
      expect(service.hasSkill(name), name).toBe(false);
      expect(skillExists(name), name).toBe(false);
    }
  });

  test('Codex prompt front matter becomes the description, never part of the body', async () => {
    const { codex, post, importedSkill } = await realImportApp();
    const prompts = join(codex, 'prompts');
    const files: Record<string, string> = {
      'described.md':
        '---\ndescription: Review a pull request\n---\nReview $1 for tests.\n',
      'hinted.md':
        '---\ndescription: Explain a file\nargument-hint: [FILE=<path>]\n---\nExplain $FILE plainly.\n',
      'named.md': '---\nname: other-name\n---\nDraft notes for $ARGUMENTS.\n',
      'unquoted.md':
        '---\ndescription: Review a change by area\nargument-hint: [FILE=<path>] [FOCUS=<area>]\n---\nReview $FILE with focus on $FOCUS.\n',
      'complete.md':
        '---\nname: complete\ndescription: Fully described\n---\nUse $NAME.\n',
      'bare.md': 'No front matter here.\n',
    };
    for (const [file, text] of Object.entries(files))
      writeFileSync(join(prompts, file), text);

    const preview = await post('/previews', { sourceId: 'codex-prompts' });
    expect(
      preview.entries
        .map((entry: { skillName: string }) => entry.skillName)
        .sort(),
    ).toEqual(['bare', 'complete', 'described', 'hinted', 'named', 'unquoted']);
    const review = await post(`/previews/${preview.id}/targets`, {
      items: preview.entries.map(
        (entry: { id: string; skillName: string }) => ({
          id: entry.id,
          action: 'import',
          targetName: entry.skillName,
        }),
      ),
    });
    await post(`/previews/${preview.id}/apply`, {
      witnessId: review.witness.id,
    });

    const expected: Record<string, { description?: string; body: string }> = {
      described: {
        description: 'Review a pull request',
        body: 'Review $1 for tests.',
      },
      hinted: { description: 'Explain a file', body: 'Explain $FILE plainly.' },
      named: { body: 'Draft notes for $ARGUMENTS.' },
      unquoted: {
        description: 'Review a change by area',
        body: 'Review $FILE with focus on $FOCUS.',
      },
      complete: { description: 'Fully described', body: 'Use $NAME.' },
      bare: { body: 'No front matter here.' },
    };
    for (const [name, want] of Object.entries(expected)) {
      const skill = importedSkill(name);
      expect(skill.body, name).toBe(want.body);
      expect(skill.body.includes('---'), name).toBe(false);
      if (want.description)
        expect(skill.description, name).toBe(want.description);
    }
  });

  test('a symlinked Codex home is not offered, so no entry leads to a refusal', async () => {
    const { root, codex, request } = await realImportApp();
    const real = join(root, 'dotfiles-codex');
    renameSync(codex, real);
    writeFileSync(join(real, 'prompts', 'review.md'), 'Review.');
    symlinkSync(real, codex);

    const sources = (await (await request('/sources')).json()) as {
      data: unknown;
    };
    expect(sources.data).toEqual([{ id: 'codex-prompts', available: false }]);
  });

  test('a prompts folder past the entry limit is refused with its own reason', async () => {
    const { codex, request, post } = await realImportApp();
    const prompts = join(codex, 'prompts');
    for (let index = 0; index < 128; index += 1)
      writeFileSync(join(prompts, `p${index}.md`), `Prompt ${index}.`);
    // At the limit the folder still previews.
    const atLimit = await post('/previews', { sourceId: 'codex-prompts' });
    expect(atLimit.excluded['count-limit']).toBe(128 - 32);

    writeFileSync(join(prompts, 'one-more.md'), 'One more.');
    const sources = (await (await request('/sources')).json()) as {
      data: unknown;
    };
    expect(sources.data).toEqual([{ id: 'codex-prompts', available: true }]);
    const refused = await request('/previews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: 'codex-prompts' }),
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({
      success: false,
      error: 'The Codex prompts folder has too many files to import.',
      code: 'TOO_MANY_FILES',
    });
  });

  test('a file name with control or direction characters is not offered', async () => {
    const { codex, post } = await realImportApp();
    const prompts = join(codex, 'prompts');
    writeFileSync(join(prompts, 'ctl\u0007name.md'), 'Bell.');
    writeFileSync(join(prompts, 'evil\u202Edm.txt.md'), 'Reversed.');
    writeFileSync(join(prompts, 'plain.md'), 'Plain.');

    const preview = await post('/previews', { sourceId: 'codex-prompts' });
    expect(
      preview.entries.map((entry: { name: string }) => entry.name),
    ).toEqual(['plain.md']);
    expect(preview.excluded['unsafe-name']).toBe(2);
  });

  /** Preview, bind the given targets, and apply, the way the dialog does. */
  async function importWith(
    post: (path: string, body?: unknown) => Promise<any>,
    choose: (entry: {
      id: string;
      name: string;
      skillName: string;
    }) => string | undefined,
    between?: () => Promise<unknown>,
  ) {
    const preview = await post('/previews', { sourceId: 'codex-prompts' });
    const review = await post(`/previews/${preview.id}/targets`, {
      items: preview.entries.map(
        (entry: { id: string; name: string; skillName: string }) => {
          const targetName = choose(entry);
          return targetName
            ? { id: entry.id, action: 'import', targetName }
            : { id: entry.id, action: 'skip' };
        },
      ),
    });
    await between?.();
    return post(`/previews/${preview.id}/apply`, {
      witnessId: review.witness.id,
    });
  }

  test('two prompts that derive one name both import when the second is renamed, and undo removes both', async () => {
    const { codex, project, service, post, skillExists } =
      await realImportApp();
    writeFileSync(join(codex, 'prompts', 'review pr.md'), 'First prompt.');
    writeFileSync(join(codex, 'prompts', 'review-pr.md'), 'Second prompt.');
    await service.createLocalSkill(
      { name: 'mine', body: 'The person’s own skill.' },
      project,
    );

    const receipt = await importWith(post, (entry) =>
      entry.name === 'review pr.md' ? 'review-pr' : 'review-pr-codex',
    );
    expect(
      receipt.items.map(
        (item: {
          reviewedTarget: string;
          outcome: string;
          reasonCode?: string;
        }) => [item.reviewedTarget, item.outcome, item.reasonCode],
      ),
    ).toEqual(
      expect.arrayContaining([
        ['review-pr', 'imported', 'imported'],
        ['review-pr-codex', 'imported', 'imported'],
      ]),
    );
    expect(skillExists('review-pr')).toBe(true);
    expect(skillExists('review-pr-codex')).toBe(true);

    const undone = await post(`/receipts/${receipt.id}/rollback`);
    expect(undone.rolledBackAt).toEqual(expect.any(String));
    expect(skillExists('review-pr')).toBe(false);
    expect(skillExists('review-pr-codex')).toBe(false);
    expect(skillExists('mine')).toBe(true);
  });

  test('a skill someone else creates under the source name between review and apply still refuses the item', async () => {
    const { codex, project, service, post, skillExists } =
      await realImportApp();
    writeFileSync(join(codex, 'prompts', 'review.md'), 'Review prompt.');

    const receipt = await importWith(
      post,
      () => 'review-imported',
      () =>
        service.createLocalSkill(
          { name: 'review', body: 'Made by someone else meanwhile.' },
          project,
        ),
    );
    expect(receipt.items).toEqual([
      expect.objectContaining({
        reviewedTarget: 'review-imported',
        outcome: 'failed',
        reasonCode: 'source-namespace-changed',
      }),
    ]);
    expect(skillExists('review-imported')).toBe(false);
  });

  test('two items of one run that target the same name: the second is refused as target-not-absent', async () => {
    const { codex, post, skillExists } = await realImportApp();
    writeFileSync(join(codex, 'prompts', 'alpha.md'), 'Alpha.');
    writeFileSync(join(codex, 'prompts', 'beta.md'), 'Beta.');

    const receipt = await importWith(post, () => 'same');
    const outcomes = receipt.items.map(
      (item: { outcome: string; reasonCode?: string }) =>
        `${item.outcome}:${item.reasonCode}`,
    );
    expect(outcomes.sort()).toEqual([
      'failed:target-not-absent',
      'imported:imported',
    ]);
    expect(skillExists('same')).toBe(true);
  });

  // Three layers refuse to write over an existing skill: apply's
  // target-not-absent check, `createLocalSkillIfAbsent`, and the check inside
  // `createLocalSkillOwned`. This test pins the OUTCOME (the person's files
  // are byte-identical, checked first) through all of them. Removing any one
  // layer leaves it green because the other two still protect the bytes; it
  // fails only when all three are gone. It proves the property, not each
  // layer.
  test('an import aimed at an existing skill, or a case variant of it, never changes its files', async () => {
    const { codex, project, service, post } = await realImportApp();
    await service.createLocalSkill(
      { name: 'mine', description: 'Mine', body: 'The person’s own words.' },
      project,
    );
    const files = ['SKILL.md', 'skill.json'].map((file) =>
      join(project, 'skills', 'mine', file),
    );
    const before = files.map((file) => readFileSync(file));
    writeFileSync(join(codex, 'prompts', 'exact.md'), 'Overwrite attempt.');
    writeFileSync(join(codex, 'prompts', 'variant.md'), 'Case attempt.');

    const receipt = await importWith(post, (entry) =>
      entry.name === 'exact.md' ? 'mine' : 'Mine',
    );
    files.forEach((file, index) => {
      expect(readFileSync(file).equals(before[index]!), file).toBe(true);
    });
    expect(
      receipt.items.map((item: { outcome: string }) => item.outcome),
    ).toEqual(['failed', 'failed']);
  });
});
