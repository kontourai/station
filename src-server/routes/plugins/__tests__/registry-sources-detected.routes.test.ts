/**
 * Registry sources whose kinds are detected from their content
 * (docs/decisions/registry-sources-detected-by-structure.md), through the real
 * Registry routes: add a source → detection → catalog listing by kind →
 * install selection resolution. No test reaches the network; GitHub is a
 * recorder that answers per URL.
 */
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  RegistryItem,
  RegistrySource,
} from '@kontourai/station-contracts/catalog';
import {
  MANAGED_POLICY_CAPABILITY_DISABLED_CODE,
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { ensureStationHomeSchema } from '../../../domain/home-schema-gate.js';
import { AMBIGUOUS_AGENT_SOURCE_STATUS } from '../../../providers/registries/agent-registry-provider.js';
import { JsonManifestRegistryProvider } from '../../../providers/registries/json-manifest-registry.js';
import { registerManifestRegistryProvider } from '../../../providers/registries/register-manifest-registry.js';
import {
  clearAll,
  registerAgentRegistryProvider,
} from '../../../providers/registries/registry.js';
import {
  detectRegistrySourceTree,
  REGISTRY_SOURCE_SCAN_LIMITS,
  RegistrySourceScanRefusal,
  readLocalSourceTree,
} from '../../../providers/registries/registry-source-detection.js';
import { installManagedCapabilityLimits } from '../../../security/managed-capability-limits.js';
import { SkillService } from '../../../services/agents/skill-service.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { computePluginContentDigest } from '../../../services/plugins/plugin-content-integrity.js';
import { resolvePluginRegistryInstall } from '../../../services/plugins/plugin-install-transaction.js';
import { createLogger } from '../../../utils/logger.js';
import { createRegistryRoutes } from '../registry.js';

const temporary = trackTempDirs();
const logger = createLogger({ name: 'detected-sources-test', level: 'error' });

afterEach(() => {
  installManagedCapabilityLimits(null);
  clearAll();
  vi.unstubAllGlobals();
});

// ── Fixtures in the exact shapes real sources publish ─────────────────────
//
// Bil0000/Hill-Climb at 551c997e9eb3ae81fed9edf1d8a66bd32cd0dbf8 (MIT): a root
// `.claude-plugin/marketplace.json` whose one plugin is the repository itself,
// a `.claude-plugin/plugin.json`, and `skills/hill-climb/SKILL.md`. The two
// JSON files and the SKILL.md frontmatter are byte-for-byte; the SKILL.md body
// is its first section only.
const HILL_CLIMB: Record<string, string> = {
  '.claude-plugin/marketplace.json': `{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "hill-climb",
  "description": "Goal-driven loops for coding agents, scored by a check the agent can't fool.",
  "owner": { "name": "Bil0000", "url": "https://github.com/Bil0000" },
  "plugins": [
    {
      "name": "hill-climb",
      "description": "Reach any goal a command can score, in small checked steps, across one or many repos.",
      "source": "./",
      "category": "development",
      "tags": ["agents", "loop", "tests", "performance", "audit"]
    }
  ]
}
`,
  '.claude-plugin/plugin.json': `{
  "name": "hill-climb",
  "version": "1.0.0",
  "description": "Give your coding agent a goal and a number. It climbs in small steps, keeps what the check proves, undoes the rest, and can't edit the check to win.",
  "author": { "name": "Bil0000", "url": "https://github.com/Bil0000" },
  "homepage": "https://github.com/Bil0000/Hill-Climb",
  "repository": "https://github.com/Bil0000/Hill-Climb",
  "license": "MIT",
  "keywords": ["agents", "skills", "autonomous", "testing", "performance", "audit", "claude-code", "codex"]
}
`,
  'skills/hill-climb/SKILL.md': `---
name: hill-climb
description: Reach any goal that a command can score (faster, fewer bugs, an audit, "make X stable", a port, a UI, a text) in small steps, keeping wins and undoing losses, across one or many repos. Use for "hill climb", "/hill-climb", "climb this", "keep going until it passes", or to resume or report on a climb.
---

# Hill climb

You work toward a goal in many small steps. A check scores each step with no
human in the loop. \`scripts/climb.py\` keeps the score: you edit code, it runs
the check, commits a win or undoes a loss, and writes the log. Never write a
score down yourself, and never decide a step "basically" passed.
`,
  'skills/hill-climb/references/checks.md': '# Checks\n',
  'README.md': '# Hill Climb\n',
};

// The anthropics/skills layout: a marketplace whose `strict: false` plugins
// name skill folders, beside `skills/<name>/SKILL.md` packages.
const ANTHROPIC_SKILLS: Record<string, string> = {
  '.claude-plugin/marketplace.json': JSON.stringify(
    {
      name: 'anthropic-agent-skills',
      owner: { name: 'Example Owner' },
      metadata: { description: 'Anthropic example skills', version: '1.0.0' },
      plugins: [
        {
          name: 'document-skills',
          description: 'Document processing',
          source: './',
          strict: false,
          skills: ['./skills/pdf'],
        },
        {
          name: 'example-skills',
          description: 'Examples',
          source: './',
          strict: false,
          skills: ['./skills/skill-creator', './skills/theme-factory'],
        },
      ],
    },
    null,
    2,
  ),
  'skills/pdf/SKILL.md':
    '---\nname: pdf\ndescription: Work with PDF files\n---\n\n# PDF\n',
  'skills/pdf/LICENSE.txt': 'License\n',
  'skills/skill-creator/SKILL.md':
    '---\nname: skill-creator\ndescription: Create skills\n---\n\n# Skill creator\n',
  'skills/theme-factory/SKILL.md':
    '---\nname: theme-factory\ndescription: Style artifacts\n---\n\n# Themes\n',
};

async function folder(files: Record<string, string>, prefix = 'source-') {
  const root = temporary(prefix);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

/** An Agent Plugins 1.0 package the manifest's plugin pipeline installs. */
function agentPluginPackage(name: string): Record<string, string> {
  return {
    [`packages/${name}/plugin.json`]: JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name,
      version: '1.0.0',
    }),
  };
}

/** A folder with a root Station manifest listing packages beside skills. */
async function stationFolder(entries: {
  plugins?: string[];
  agents?: string[];
  skills?: string[];
  tools?: number;
}) {
  const files: Record<string, string> = {};
  for (const name of [...(entries.plugins ?? []), ...(entries.agents ?? [])])
    Object.assign(files, agentPluginPackage(name));
  for (const name of entries.skills ?? [])
    files[`skills/${name}/SKILL.md`] =
      `---\nname: ${name}\ndescription: ${name} work\n---\n\nInstructions\n`;
  files['registry.json'] = JSON.stringify({
    version: 1,
    plugins: [
      ...(entries.plugins ?? []).map((id) => ({
        id,
        displayName: id,
        description: `${id} plugin`,
        version: '1.0.0',
        source: `./packages/${id}`,
      })),
      ...(entries.agents ?? []).map((id) => ({
        id,
        type: 'agent',
        displayName: id,
        description: `${id} agent`,
        version: '1.0.0',
        source: `./packages/${id}`,
      })),
    ],
    tools: Array.from({ length: entries.tools ?? 0 }, (_, n) => ({
      id: `tool-${n}`,
      displayName: `Tool ${n}`,
      description: 'A tool server',
      version: '1.0.0',
      source: `./tools/${n}`,
    })),
  });
  return folder(files);
}

function setup(home = temporary('detected-home-')) {
  clearAll();
  const config = new ConfigLoader({ projectHomeDir: home });
  const service = new SkillService(config, logger);
  const store = new EventStore(join(home, 'events.sqlite'));
  const app = withOperatorPrincipal(
    createRegistryRoutes(config, async () => {}, undefined, service, {
      logger,
      canSeePlugin: () => true,
      packageMcpJournal: store.createPackageMcpAdmissionJournal(),
      visibility: {
        resolvePrincipal: () => ({
          id: LOCAL_OPERATOR_PRINCIPAL_ID,
          kind: 'human',
          display: 'Operator',
        }),
      },
    }),
  );
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const json = async <T>(path: string, method = 'GET', body?: unknown) =>
    (await (await request(path, method, body)).json()) as T;
  const add = async (body: Record<string, unknown>) => {
    const response = await request('/sources', 'POST', body);
    const outcome = (await response.json()) as {
      data: RegistrySource;
      error?: string;
    };
    expect(response.status, JSON.stringify(outcome)).toBe(201);
    return outcome.data;
  };
  const list = async (kind: 'skills' | 'plugins' | 'agents') =>
    (await json<{ data: RegistryItem[] }>(`/${kind}`)).data;
  return { home, config, request, json, add, list, store };
}

function installPolicy(registries: Record<string, unknown>) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { registries },
  });
  if (!parsed.ok) throw new Error('fixture policy refused');
  installManagedCapabilityLimits({
    summary: summarizeManagedPolicy(parsed.document),
  });
}

const gitBlob = (text: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest('hex');

/**
 * GitHub's commits, recursive tree and raw endpoints for one repository, at a
 * commit the test can move. Every requested URL is recorded.
 */
function fakeGitHub(owner: string, repo: string) {
  const state = { commit: 'a'.repeat(40), files: { ...HILL_CLIMB } };
  const requested: string[] = [];
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const tree = () => `${state.commit.slice(0, 39)}f`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requested.push(url);
      if (url === `${api}/commits/HEAD`)
        return Response.json({
          sha: state.commit,
          commit: { tree: { sha: tree() } },
        });
      if (url === `${api}/git/trees/${tree()}?recursive=1`) {
        const directories = new Set<string>();
        for (const path of Object.keys(state.files)) {
          const parts = path.split('/');
          for (let n = 1; n < parts.length; n++)
            directories.add(parts.slice(0, n).join('/'));
        }
        return Response.json({
          sha: tree(),
          truncated: false,
          tree: [
            ...[...directories].map((path) => ({
              path,
              type: 'tree',
              mode: '040000',
              sha: 'c'.repeat(40),
            })),
            ...Object.entries(state.files).map(([path, text]) => ({
              path,
              type: 'blob',
              mode: '100644',
              sha: gitBlob(text),
              size: Buffer.byteLength(text),
            })),
          ],
        });
      }
      const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${state.commit}/`;
      if (url.startsWith(raw)) {
        const path = decodeURIComponent(url.slice(raw.length));
        const text = state.files[path];
        if (text !== undefined) return new Response(text);
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return { state, requested };
}

const kinds = (source: RegistrySource) =>
  Object.fromEntries(
    (source.detection?.kinds ?? []).map((kind) => [
      kind.kind,
      { count: kind.count, installable: kind.installable, via: kind.via },
    ]),
  );

describe('a source is a location; what it provides comes from its content', () => {
  test('a source providing skills and plugins together lists both catalogs, and each selection resolves through its own installer', async () => {
    const { add, list, request, home } = setup();
    const root = await stationFolder({
      plugins: ['hello'],
      skills: ['clarify'],
      tools: 2,
    });
    // No adapter and no kind: only a location.
    const source = await add({ location: root });
    expect(source.adapter).toBe('directory');
    expect(source.detection).toMatchObject({
      state: 'detected',
      index: 'station-manifest:registry.json',
    });
    expect(kinds(source)).toEqual({
      skills: { count: 1, installable: true, via: 'skill-md' },
      plugins: { count: 1, installable: true, via: 'station-manifest' },
      integrations: { count: 2, installable: false, via: 'station-manifest' },
    });

    const skills = await list('skills');
    const plugins = await list('plugins');
    const skill = skills.find((item) => item.catalog?.sourceId === source.id);
    const plugin = plugins.find((item) => item.catalog?.sourceId === source.id);
    expect(skill?.catalog).toMatchObject({ kind: 'skills', itemId: 'clarify' });
    expect(plugin?.catalog).toMatchObject({ kind: 'plugins', itemId: 'hello' });

    const installed = await request('/skills/install', 'POST', {
      id: skill!.id,
    });
    expect(installed.status, await installed.clone().text()).toBe(200);
    await access(join(home, 'skills/clarify/SKILL.md'));
    expect(await resolvePluginRegistryInstall(plugin!.id)).toMatchObject({
      source: join(root, 'packages/hello'),
    });
  });

  test('the Hill-Climb layout: its marketplace index decides plugins, its SKILL.md is still an installable skill', async () => {
    const { add, list, request, home } = setup();
    const source = await add({ location: await folder(HILL_CLIMB) });
    expect(source.detection?.index).toBe(
      'claude-marketplace:.claude-plugin/marketplace.json',
    );
    // One plugin, from the index, not two: the index decides the plugins kind,
    // so `.claude-plugin/plugin.json` is not counted again by the scan.
    expect(kinds(source)).toEqual({
      skills: { count: 1, installable: true, via: 'skill-md' },
      plugins: { count: 1, installable: false, via: 'claude-marketplace' },
    });
    expect(
      source.detection?.kinds.find((kind) => kind.kind === 'plugins')?.note,
    ).toContain('not a format Station installs');
    expect(
      (await list('plugins')).filter(
        (item) => item.catalog?.sourceId === source.id,
      ),
    ).toEqual([]);
    const [skill] = (await list('skills')).filter(
      (item) => item.catalog?.sourceId === source.id,
    );
    expect(skill?.catalog?.itemId).toBe('hill-climb');
    expect(
      (await request('/skills/install', 'POST', { id: skill!.id })).status,
    ).toBe(200);
    await access(join(home, 'skills/hill-climb/references/checks.md'));
  });

  test('the anthropics/skills layout lists every skill even though a marketplace index sits at its root', async () => {
    const { add, list } = setup();
    const source = await add({ location: await folder(ANTHROPIC_SKILLS) });
    expect(kinds(source)).toMatchObject({
      skills: { count: 3, installable: true },
      plugins: { count: 2, installable: false, via: 'claude-marketplace' },
    });
    expect(
      (await list('skills'))
        .filter((item) => item.catalog?.sourceId === source.id)
        .map((item) => item.catalog?.itemId)
        .sort(),
    ).toEqual(['pdf', 'skill-creator', 'theme-factory']);
  });

  test('a source with nothing Station recognizes is added and shows that, not an error', async () => {
    const { add, json } = setup();
    const source = await add({
      displayName: 'Notes',
      location: await folder({ 'README.md': '# Notes\n', 'notes/a.txt': 'a' }),
    });
    expect(source.detection).toMatchObject({
      state: 'nothing-recognized',
      kinds: [],
    });
    expect(source.error).toBeUndefined();
    const listed = (
      await json<{ data: RegistrySource[] }>('/sources')
    ).data.find((row) => row.id === source.id);
    expect(listed).toMatchObject({ status: 'ready', enabled: true });
  });

  test('a location or ref Station cannot use is refused with the reason', async () => {
    const { request } = setup();
    for (const [body, reason] of [
      [
        { location: 'https://github.com/owner/repo/tree/main' },
        'put a branch or tag in Ref',
      ],
      [{ location: '/tmp', ref: 'main' }, 'only to a GitHub repository'],
      [{ location: 'http://example.com/catalog.json' }, 'plain http'],
    ] as const) {
      const response = await request('/sources', 'POST', body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(
        reason,
      );
    }
  });
});

describe('legacy registry-sources.json migrates with no action', () => {
  test('a file an earlier Station wrote keeps every stored selection resolving, then gains detected kinds', async () => {
    // Stage 1: produce the exact bytes an earlier Station persisted. Its
    // snapshot data and selection revisions have the same shape and formula;
    // it keyed a source's one snapshot by the bare id, chose the kind through
    // `adapter`, and had no `detections`.
    const skillsRoot = await folder({
      'clarify/SKILL.md':
        '---\nname: clarify\ndescription: Clarify work\n---\n\nInstructions\n',
    });
    const manifestRoot = await stationFolder({
      plugins: ['hello'],
      agents: ['reviewer'],
    });
    const before = setup();
    const skillsSource = await before.add({
      displayName: 'Team skills',
      adapter: 'directory',
      location: skillsRoot,
    });
    const manifestSource = await before.add({
      displayName: 'Team catalog',
      adapter: 'manifest',
      location: join(manifestRoot, 'registry.json'),
    });
    await before.list('skills');
    await before.list('plugins');
    const current = JSON.parse(
      await readFile(join(before.home, 'config/registry-sources.json'), 'utf8'),
    ) as {
      sources: Array<Record<string, unknown>>;
      snapshots: Record<string, { data: RegistryItem[] }>;
    };
    const legacySnapshot = (id: string, kind: string) =>
      current.snapshots[`${id}#${kind}`]!;
    const storedSkill = legacySnapshot(skillsSource.id, 'skills').data[0]!;
    const storedPlugin = legacySnapshot(manifestSource.id, 'plugins').data[0]!;
    const legacy = {
      version: 1,
      sources: current.sources.map(
        ({ displayName, adapter, location, id, enabled }) => ({
          displayName,
          adapter,
          location,
          id,
          enabled,
        }),
      ),
      snapshots: {
        [skillsSource.id]: legacySnapshot(skillsSource.id, 'skills'),
        [manifestSource.id]: legacySnapshot(manifestSource.id, 'plugins'),
      },
      disabled: [],
    };
    // One Station process serves one home: retire the first home's sources
    // so only the migrated home owns these ids.
    for (const id of [skillsSource.id, manifestSource.id])
      expect((await before.request(`/sources/${id}`, 'DELETE')).status).toBe(
        200,
      );

    // Stage 2: a fresh Station home holding only that legacy file.
    const home = temporary('detected-legacy-home-');
    await mkdir(join(home, 'config'), { recursive: true });
    await writeFile(
      join(home, 'config/registry-sources.json'),
      `${JSON.stringify(legacy, null, 2)}\n`,
    );
    const after = setup(home);
    const rows = (await after.json<{ data: RegistrySource[] }>('/sources'))
      .data;
    expect(rows.find((row) => row.id === skillsSource.id)).toMatchObject({
      kind: 'skills',
      adapter: 'directory',
      status: 'stale',
    });
    expect(rows.find((row) => row.id === manifestSource.id)).toMatchObject({
      kind: 'plugins',
    });
    expect(rows.every((row) => row.detection === undefined)).toBe(true);

    // The selections the earlier Station handed out resolve unchanged.
    const installed = await after.request('/skills/install', 'POST', {
      id: storedSkill.id,
    });
    expect(installed.status, await installed.clone().text()).toBe(200);
    await access(join(home, 'skills/clarify/SKILL.md'));
    expect(await resolvePluginRegistryInstall(storedPlugin.id)).toMatchObject({
      source: join(manifestRoot, 'packages/hello'),
    });

    // The first catalog read detects what each source provides: the
    // manifest also lists an agent, which the old adapter never exposed.
    const agents = await after.list('agents');
    expect(
      agents.find((item) => item.catalog?.sourceId === manifestSource.id)
        ?.catalog,
    ).toMatchObject({ kind: 'agents', itemId: 'reviewer' });
    const migrated = (await after.json<{ data: RegistrySource[] }>('/sources'))
      .data;
    expect(
      kinds(migrated.find((row) => row.id === manifestSource.id)!),
    ).toMatchObject({
      plugins: { count: 1, installable: true },
      agents: { count: 1, installable: true },
    });

    // The rewritten file is still one an earlier Station reads: the same
    // source keys, an adapter on each, and at most 32 snapshots.
    const rewritten = JSON.parse(
      await readFile(join(home, 'config/registry-sources.json'), 'utf8'),
    ) as {
      sources: Array<Record<string, unknown>>;
      snapshots: Record<string, unknown>;
    };
    for (const source of rewritten.sources)
      expect(Object.keys(source).sort()).toEqual([
        'adapter',
        'displayName',
        'enabled',
        'id',
        'location',
      ]);
    expect(Object.keys(rewritten.snapshots).length).toBeLessThanOrEqual(32);
    expect(Object.keys(rewritten.snapshots)).toContain(
      `${skillsSource.id}#skills`,
    );
  });
});

describe('agents come from every source', () => {
  test('two agent sources are both listed, with distinct selections, and one installs through the plugin pipeline', async () => {
    const home = temporary('detected-agent-home-');
    await ensureStationHomeSchema(home);
    const { add, list, request } = setup(home);
    const first = await stationFolder({ agents: ['reviewer'] });
    const second = await stationFolder({ agents: ['reviewer'] });
    const a = await add({ displayName: 'First team', location: first });
    const b = await add({ displayName: 'Second team', location: second });
    expect(kinds(a)).toEqual({
      agents: { count: 1, installable: true, via: 'station-manifest' },
    });
    const agents = (await list('agents')).filter(
      (item) => item.catalog?.itemId === 'reviewer',
    );
    expect(
      agents.map((item) => [item.catalogSourceName, item.catalog?.sourceId]),
    ).toEqual([
      ['First team', a.id],
      ['Second team', b.id],
    ]);
    expect(new Set(agents.map((item) => item.id)).size).toBe(2);

    const chosen = agents[1]!;
    const response = await request('/agents/install', 'POST', {
      id: chosen.id,
      dataPolicy: 'preserve',
      consent: {
        permissions: [],
        contentDigest: computePluginContentDigest(
          join(second, 'packages'),
          'reviewer',
        ),
        dependencies: [],
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const installed = (await list('agents')).filter((item) => item.installed);
    expect(installed.map((item) => item.catalog?.sourceId)).toEqual([b.id]);
  });

  test('registered agent catalogs are merged, not first-wins, and an id two catalogs offer is refused rather than picked', async () => {
    const { json, request, home } = setup();
    const configured = await stationFolder({ agents: ['planner', 'shared'] });
    registerManifestRegistryProvider(
      new JsonManifestRegistryProvider(join(configured, 'registry.json'), home),
    );
    const installs: string[] = [];
    registerAgentRegistryProvider(
      {
        listAvailable: async () => [
          { id: 'researcher', installed: false },
          { id: 'shared', installed: false },
        ],
        listInstalled: async () => [],
        install: async (id) => {
          installs.push(id);
          return { success: true, message: `installed ${id}` };
        },
        uninstall: async () => ({ success: false, message: 'none' }),
      },
      'Team plugin',
    );
    const listed = (await json<{ data: RegistryItem[] }>('/agents')).data;
    expect(
      listed.map((item) => [item.id, item.catalogSourceName, item.status]),
    ).toEqual([
      ['planner', 'Configured registry', undefined],
      ['shared', 'Configured registry', AMBIGUOUS_AGENT_SOURCE_STATUS],
      ['researcher', 'Team plugin', undefined],
      ['shared', 'Team plugin', AMBIGUOUS_AGENT_SOURCE_STATUS],
    ]);
    const refused = await request('/agents/install', 'POST', { id: 'shared' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { message: string }).message).toContain(
      'more than one agent catalog (Configured registry, Team plugin)',
    );
    expect(installs).toEqual([]);
    const accepted = await request('/agents/install', 'POST', {
      id: 'researcher',
    });
    expect(accepted.status).toBe(200);
    expect(installs).toEqual(['researcher']);
  });
});

describe('scans are bounded and refuse past a bound', () => {
  test('a source nested past the depth bound is refused as a whole; none of its skills are listed', async () => {
    const { add, list } = setup();
    const deep = Array.from(
      { length: REGISTRY_SOURCE_SCAN_LIMITS.maxDepth + 1 },
      (_, n) => `d${n}`,
    ).join('/');
    const source = await add({
      location: await folder({
        'clarify/SKILL.md':
          '---\nname: clarify\ndescription: Clarify work\n---\n\nInstructions\n',
        [`${deep}/note.txt`]: 'deep',
      }),
    });
    expect(source.detection).toMatchObject({ state: 'refused', kinds: [] });
    expect(source.detection?.reason).toContain(
      `more than ${REGISTRY_SOURCE_SCAN_LIMITS.maxDepth} levels deep`,
    );
    expect(source.status).toBe('error');
    expect(
      (await list('skills')).filter(
        (item) => item.catalog?.sourceId === source.id,
      ),
    ).toEqual([]);
  });

  test('the entry, file-size, skill and definition-read bounds each refuse instead of truncating', async () => {
    const limits = { ...REGISTRY_SOURCE_SCAN_LIMITS };
    const root = await folder({
      'a/SKILL.md': '---\nname: a\ndescription: a\n---\n',
      'b/SKILL.md': '---\nname: b\ndescription: b\n---\n',
      'x/mcp.json': JSON.stringify({ mcpServers: { one: {} } }),
      'y/mcp.json': JSON.stringify({ mcpServers: { two: {} } }),
    });
    const refusal = async (overrides: Partial<typeof limits>) => {
      const bounded = { ...limits, ...overrides };
      try {
        await detectRegistrySourceTree(
          await readLocalSourceTree(root, bounded),
          { limits: bounded },
        );
        return null;
      } catch (error) {
        return error;
      }
    };
    expect(await refusal({})).toBeNull();
    for (const [bound, overrides] of [
      ['maxEntries', { maxEntries: 7 }],
      ['maxSkills', { maxSkills: 1 }],
      ['maxFileBytes', { maxFileBytes: 10 }],
      ['maxDefinitionReads', { maxDefinitionReads: 1 }],
    ] as const) {
      const error = await refusal(overrides);
      expect(error, bound).toBeInstanceOf(RegistrySourceScanRefusal);
      expect((error as RegistrySourceScanRefusal).bound).toBe(bound);
    }
  });

  test('a GitHub tree the API reports as truncated is refused, not read in part', async () => {
    const { add } = setup();
    const github = fakeGitHub('Bil0000', 'Hill-Climb');
    const fetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const response = await fetch(input, init);
        if (!String(input).includes('/git/trees/')) return response;
        const body = (await response.json()) as Record<string, unknown>;
        return Response.json({ ...body, truncated: true });
      }),
    );
    const source = await add({
      location: 'https://github.com/Bil0000/Hill-Climb',
    });
    expect(source.detection).toMatchObject({ state: 'refused', kinds: [] });
    expect(github.requested.some((url) => url.startsWith('https://raw.'))).toBe(
      false,
    );
  });
});

describe('updates are detected against the source as it is now', () => {
  test('refreshing a GitHub source reads the commit its ref names now, reports the change, and refuses a selection from the old revision', async () => {
    const { add, list, request, home } = setup();
    const github = fakeGitHub('Bil0000', 'Hill-Climb');
    const source = await add({
      location: 'https://github.com/Bil0000/Hill-Climb',
    });
    expect(source.adapter).toBe('github');
    expect(source.detection).toMatchObject({
      state: 'detected',
      revision: github.state.commit,
    });
    expect(kinds(source)).toEqual({
      skills: { count: 1, installable: true, via: 'skill-md' },
      plugins: { count: 1, installable: false, via: 'claude-marketplace' },
    });
    const [old] = (await list('skills')).filter(
      (item) => item.catalog?.sourceId === source.id,
    );

    // Upstream moves: a new commit changes the skill.
    github.state.commit = 'b'.repeat(40);
    github.state.files = {
      ...HILL_CLIMB,
      'skills/hill-climb/SKILL.md': `${HILL_CLIMB['skills/hill-climb/SKILL.md']}\nNew step.\n`,
    };
    const refreshed = (await (
      await request(`/sources/${source.id}/refresh`, 'POST')
    ).json()) as { data: RegistrySource };
    expect(refreshed.data.detection).toMatchObject({
      revision: 'b'.repeat(40),
      changedAt: expect.any(String),
    });
    const stale = await request('/skills/install', 'POST', { id: old!.id });
    expect(stale.status).toBe(409);
    await expect(access(join(home, 'skills/hill-climb'))).rejects.toThrow();
    const [fresh] = (await list('skills')).filter(
      (item) => item.catalog?.sourceId === source.id,
    );
    expect(fresh!.packageRevision).not.toBe(old!.packageRevision);
    expect(
      (await request('/skills/install', 'POST', { id: fresh!.id })).status,
    ).toBe(200);
    expect(
      await readFile(join(home, 'skills/hill-climb/SKILL.md'), 'utf8'),
    ).toContain('New step.');
  });
});

describe('managed policy still applies', () => {
  async function expectManaged(response: Response, subject: string) {
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe(MANAGED_POLICY_CAPABILITY_DISABLED_CODE);
    expect(String(body.error)).toContain(`Acme's policy manages ${subject}`);
  }

  test('an allow list refuses a source by location before anything is read from it', async () => {
    const { request, home } = setup();
    installPolicy({ allowedUrls: ['https://plugins.example.com/r.json'] });
    const github = fakeGitHub('Bil0000', 'Hill-Climb');
    await expectManaged(
      await request('/sources', 'POST', {
        location: 'https://github.com/Bil0000/Hill-Climb',
      }),
      'this marketplace',
    );
    await expectManaged(
      await request('/sources', 'POST', {
        location: await folder(HILL_CLIMB),
      }),
      'this marketplace',
    );
    expect(github.requested).toEqual([]);
    await expect(
      access(join(home, 'config/registry-sources.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('unsigned packages refused: the skills of a mixed source are refused while its plugins stay listed', async () => {
    const { add, list, request, json } = setup();
    const root = await stationFolder({
      plugins: ['hello'],
      skills: ['clarify'],
    });
    installPolicy({ unsignedPackages: false });
    const source = await add({ location: root });
    const row = (await json<{ data: RegistrySource[] }>('/sources')).data.find(
      (entry) => entry.id === source.id,
    )!;
    expect(row).toMatchObject({ enabled: true });
    expect(row.managedDenial).toBeUndefined();
    expect(
      row.detection?.kinds.find((kind) => kind.kind === 'skills')
        ?.managedDenial,
    ).toContain("Acme's policy manages skills from marketplaces");
    expect(
      (await list('skills')).filter(
        (item) => item.catalog?.sourceId === source.id,
      ),
    ).toEqual([]);
    expect(
      (await list('plugins')).filter(
        (item) => item.catalog?.sourceId === source.id,
      ),
    ).toHaveLength(1);
    // A source whose only content is skills is still refused whole.
    await expectManaged(
      await request('/sources', 'POST', {
        location: await folder({
          'clarify/SKILL.md': '---\nname: clarify\ndescription: c\n---\n',
        }),
      }),
      'skills from marketplaces',
    );
  });
});
