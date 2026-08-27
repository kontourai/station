/**
 * Canonical Flow Agents skills as Station skills (S3 item 3) — these tests
 * run against the REAL artifacts in the installed @kontourai/flow-agents
 * package and the REAL agent-skills-ts-sdk parser (no mocks): what they prove
 * is that the published package's current skills/<name>/SKILL.md files load,
 * enumerate, and assign through Station's existing skill machinery intact.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../telemetry/metrics.js', () => ({
  canonicalSkillsDiscovered: { add: vi.fn() },
  skillDiscoveries: { add: vi.fn() },
  skillActivations: { add: vi.fn() },
  skillActivationDuration: { record: vi.fn() },
  skillDiscoveryDuration: { record: vi.fn() },
  skillOps: { add: vi.fn() },
}));

const { resolveFlowAgentsSkillsSource, resolveCanonicalSkillSources } =
  await import('../flow/flow-agents-skills-source.js');
const { SkillService } = await import('../agents/skill-service.js');

const require = createRequire(import.meta.url);
const packageRoot = dirname(
  require.resolve('@kontourai/flow-agents/package.json'),
);

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function createConfigLoaderStub(homeDir: string) {
  return {
    getProjectHomeDir: () => homeDir,
    loadSkill: vi.fn().mockRejectedValue(new Error('not installed')),
    saveSkill: vi.fn(),
    deleteSkill: vi.fn(),
  } as any;
}

describe('flow-agents canonical skills source', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'flow-agents-skills-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('the installed package ships SKILL.md skills and resolves as a source', () => {
    const source = resolveFlowAgentsSkillsSource({});
    expect(source).not.toBeNull();
    expect(source?.root).toBe(join(packageRoot, 'skills'));
    expect(source?.label).toBe('flow-agents');
    expect(source?.version).toMatch(/^\d+\.\d+\.\d+/);
    // flow-agents 2.0.1 ships the top-level skills/ PLUS kit skill dirs; the
    // top-level source is among the canonical sources.
    const sources = resolveCanonicalSkillSources({});
    expect(sources).toContainEqual(source);
    expect(sources).toContainEqual(
      expect.objectContaining({
        root: join(packageRoot, 'kits', 'builder', 'skills'),
        label: 'flow-agents',
      }),
    );
  });

  test('explicit but invalid FLOW_AGENTS_SKILLS_ROOT does NOT fall through', () => {
    expect(
      resolveFlowAgentsSkillsSource({
        FLOW_AGENTS_SKILLS_ROOT: join(homeDir, 'nowhere'),
      }),
    ).toBeNull();
  });

  test('canonical package skills enumerate as installed Station skills', async () => {
    const service = new SkillService(createConfigLoaderStub(homeDir), logger, {
      canonicalSources: resolveCanonicalSkillSources({}) ?? [],
    });
    await service.discoverSkills(homeDir);

    const skills = service.listSkills();
    const names = skills.map((skill) => skill.name);
    for (const expected of [
      'agentic-engineering',
      'browser-test',
      'dependency-update',
      'eval-rebuild',
      'github-cli',
      'search-first',
    ]) {
      expect(names).toContain(expected);
    }

    const searchFirst = skills.find((skill) => skill.name === 'search-first');
    expect(searchFirst).toMatchObject({
      source: 'flow-agents',
      installed: true,
    });
    expect(searchFirst?.path).toBe(join(packageRoot, 'skills', 'search-first'));
  });

  test('a canonical skill loads with its content intact (byte-identical body)', async () => {
    const service = new SkillService(createConfigLoaderStub(homeDir), logger, {
      canonicalSources: resolveCanonicalSkillSources({}) ?? [],
    });
    await service.discoverSkills(homeDir);

    const config = await service.getSkill('search-first');
    expect(config.source).toBe('flow-agents');
    expect(config.path).toBe(join(packageRoot, 'skills', 'search-first'));

    // The served body is the package's SKILL.md body — no conversion, no
    // copied-and-drifted content.
    const raw = readFileSync(
      join(packageRoot, 'skills', 'search-first', 'SKILL.md'),
      'utf-8',
    );
    expect(raw).toContain(config.body ?? '');
    expect(config.body).toContain('# Search-First');
    expect(config.body).toContain('Research before building.');
  });

  test('canonical skills are assignable to a managed agent (catalog prompt + activate_skill tool)', async () => {
    const service = new SkillService(createConfigLoaderStub(homeDir), logger, {
      canonicalSources: resolveCanonicalSkillSources({}) ?? [],
    });
    await service.discoverSkills(homeDir);

    // A managed agent assigned skills: ['search-first'] gets exactly that
    // catalog entry…
    const prompt = service.getSkillCatalogPrompt(['search-first']);
    expect(prompt).toContain('search-first');
    expect(prompt).not.toContain('github-cli');

    // …and the activate_skill tool serves the canonical content.
    const tool = service.getSkillTool(['search-first']);
    expect(tool).not.toBeNull();
    const result = await tool?.execute({ name: 'search-first' });
    expect(result.content).toContain('Search-First');
    expect(result.error).toBeUndefined();
  });

  test('a locally installed skill overrides a canonical skill on name collision', async () => {
    const localDir = join(homeDir, 'skills', 'search-first');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(
      join(localDir, 'SKILL.md'),
      [
        '---',
        'name: search-first',
        'description: Local override',
        '---',
        '',
        'Local body.',
      ].join('\n'),
    );

    const service = new SkillService(createConfigLoaderStub(homeDir), logger, {
      canonicalSources: resolveCanonicalSkillSources({}) ?? [],
    });
    await service.discoverSkills(homeDir);

    const searchFirst = service
      .listSkills()
      .find((skill) => skill.name === 'search-first');
    expect(searchFirst?.source).not.toBe('flow-agents');
    expect(searchFirst?.description).toBe('Local override');
  });

  test('no canonical sources configured: discovery behaves exactly as before', async () => {
    const service = new SkillService(createConfigLoaderStub(homeDir), logger);
    await service.discoverSkills(homeDir);
    expect(service.listSkills()).toEqual([]);
  });
});
