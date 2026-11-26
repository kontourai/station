/**
 * Registry sources whose kinds are detected from their content
 * (docs/decisions/registry-sources-detected-by-structure.md), through the real
 * Registry routes: add a source → detection → catalog listing by kind →
 * install selection resolution. No test reaches the network; GitHub is a
 * recorder that answers per URL.
 */
import { createHash } from 'node:crypto';
import {
  access,
  link,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { ensureStationHomeSchema } from '../../../domain/home-schema-gate.js';
import {
  AgentCatalogOwnershipRefusal,
  AMBIGUOUS_AGENT_SOURCE_STATUS,
} from '../../../providers/registries/agent-registry-provider.js';
import {
  LocalSourceConfinementError,
  LocalSourceFileTooLargeError,
  readConfinedFile,
} from '../../../providers/registries/confined-local-read.js';
import { FilesystemSkillRegistryProvider } from '../../../providers/registries/filesystem-skill-registry.js';
import { GitHubSkillRegistryProvider } from '../../../providers/registries/github-skill-registry.js';
import { JsonManifestRegistryProvider } from '../../../providers/registries/json-manifest-registry.js';
import { registerManifestRegistryProvider } from '../../../providers/registries/register-manifest-registry.js';
import {
  clearAll,
  registerAgentRegistryProvider,
  registerSkillRegistryProvider,
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
import { resolveInstalledPluginRoot } from '../../../services/plugins/plugin-incarnation.js';
import {
  capturePluginRegistryAcquisition,
  isRegistryPluginRemovalTarget,
  resolvePluginRegistryInstall,
} from '../../../services/plugins/plugin-install-transaction.js';
import { createLogger } from '../../../utils/logger.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';
import { registerPluginLifecycleRoutes } from '../plugin-lifecycle-routes.js';
import { createRegistryRoutes } from '../registry.js';

const temporary = trackTempDirs();
const logger = createLogger({ name: 'detected-sources-test', level: 'error' });

afterEach(() => {
  installManagedCapabilityLimits(null);
  clearAll();
  vi.unstubAllGlobals();
});

// ── Fixtures: synthetic, in the on-disk shapes these layouts use ──────────
//
// A repository with a plugin-only marketplace index beside SKILL.md skills: a
// root `.claude-plugin/marketplace.json` whose one plugin is the repository
// itself, a `.claude-plugin/plugin.json`, a `skills/<name>/SKILL.md` package
// with a references file, and a README. Names and text are invented here.
const PLUGIN_INDEX_WITH_SKILLS: Record<string, string> = {
  '.claude-plugin/marketplace.json': `{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "example-skills-and-plugin",
  "description": "An example marketplace with one plugin.",
  "owner": { "name": "Example Org", "url": "https://example.com" },
  "plugins": [
    {
      "name": "example-skills-and-plugin",
      "description": "Example plugin that bundles one skill.",
      "source": "./",
      "category": "development",
      "tags": ["example"]
    }
  ]
}
`,
  '.claude-plugin/plugin.json': `{
  "name": "example-skills-and-plugin",
  "version": "1.0.0",
  "description": "Example plugin that bundles one skill.",
  "author": { "name": "Example Org", "url": "https://example.com" },
  "license": "MIT",
  "keywords": ["example"]
}
`,
  'skills/release-check/SKILL.md': `---
name: release-check
description: Check that a release branch is ready to tag. Use when asked to prepare or verify a release.
---

# Release check

Run the project's checks, read the changelog, and report what blocks the tag.
`,
  'skills/release-check/references/checklist.md': '# Checklist\n',
  'README.md': '# Example skills and plugin\n',
};

// A marketplace whose `strict: false` plugins name skill folders, beside
// `skills/<name>/SKILL.md` packages. Names and text are invented here.
const SKILL_FOLDER_MARKETPLACE: Record<string, string> = {
  '.claude-plugin/marketplace.json': JSON.stringify(
    {
      name: 'example-skill-collection',
      owner: { name: 'Example Org' },
      metadata: { description: 'Example skill collection', version: '1.0.0' },
      plugins: [
        {
          name: 'writing-skills',
          description: 'Writing helpers',
          source: './',
          strict: false,
          skills: ['./skills/summarize'],
        },
        {
          name: 'review-skills',
          description: 'Review helpers',
          source: './',
          strict: false,
          skills: ['./skills/proofread', './skills/triage'],
        },
      ],
    },
    null,
    2,
  ),
  'skills/summarize/SKILL.md':
    '---\nname: summarize\ndescription: Summarize a document\n---\n\n# Summarize\n',
  'skills/summarize/LICENSE.txt': 'License\n',
  'skills/proofread/SKILL.md':
    '---\nname: proofread\ndescription: Proofread text\n---\n\n# Proofread\n',
  'skills/triage/SKILL.md':
    '---\nname: triage\ndescription: Sort incoming issues\n---\n\n# Triage\n',
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
  const state = {
    commit: 'a'.repeat(40),
    files: { ...PLUGIN_INDEX_WITH_SKILLS },
  };
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

  test('a plugin-only marketplace index decides plugins, and its SKILL.md is still an installable skill', async () => {
    const { add, list, request, home } = setup();
    const source = await add({
      location: await folder(PLUGIN_INDEX_WITH_SKILLS),
    });
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
    expect(skill?.catalog?.itemId).toBe('release-check');
    expect(
      (await request('/skills/install', 'POST', { id: skill!.id })).status,
    ).toBe(200);
    await access(join(home, 'skills/release-check/references/checklist.md'));
  });

  test('a marketplace index naming skill folders still leaves every SKILL.md listed as a skill', async () => {
    const { add, list } = setup();
    const source = await add({
      location: await folder(SKILL_FOLDER_MARKETPLACE),
    });
    expect(kinds(source)).toMatchObject({
      skills: { count: 3, installable: true },
      plugins: { count: 2, installable: false, via: 'claude-marketplace' },
    });
    expect(
      (await list('skills'))
        .filter((item) => item.catalog?.sourceId === source.id)
        .map((item) => item.catalog?.itemId)
        .sort(),
    ).toEqual(['proofread', 'summarize', 'triage']);
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
    const github = fakeGitHub('example-org', 'example-skills-and-plugin');
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
      location: 'https://github.com/example-org/example-skills-and-plugin',
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
    const github = fakeGitHub('example-org', 'example-skills-and-plugin');
    const source = await add({
      location: 'https://github.com/example-org/example-skills-and-plugin',
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
      ...PLUGIN_INDEX_WITH_SKILLS,
      'skills/release-check/SKILL.md': `${PLUGIN_INDEX_WITH_SKILLS['skills/release-check/SKILL.md']}\nNew step.\n`,
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
    await expect(access(join(home, 'skills/release-check'))).rejects.toThrow();
    const [fresh] = (await list('skills')).filter(
      (item) => item.catalog?.sourceId === source.id,
    );
    expect(fresh!.packageRevision).not.toBe(old!.packageRevision);
    expect(
      (await request('/skills/install', 'POST', { id: fresh!.id })).status,
    ).toBe(200);
    expect(
      await readFile(join(home, 'skills/release-check/SKILL.md'), 'utf8'),
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
    const github = fakeGitHub('example-org', 'example-skills-and-plugin');
    await expectManaged(
      await request('/sources', 'POST', {
        location: 'https://github.com/example-org/example-skills-and-plugin',
      }),
      'this marketplace',
    );
    await expectManaged(
      await request('/sources', 'POST', {
        location: await folder(PLUGIN_INDEX_WITH_SKILLS),
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

// ── Review round: confinement, read bounds, agent ownership, downgrade ──────

const OUTSIDE_SECRET = 'OUTSIDE-SECRET';
const skillDocument = (name: string, description = `${name} work`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions\n`;

/** A folder outside every source, holding what a link would leak. */
async function outsideFolder() {
  return folder(
    {
      'clarify/SKILL.md': skillDocument('leaked', OUTSIDE_SECRET),
      'outside/SKILL.md': skillDocument('outside', OUTSIDE_SECRET),
      'marketplace.json': JSON.stringify({
        name: OUTSIDE_SECRET,
        plugins: [{ name: OUTSIDE_SECRET, source: './' }],
      }),
    },
    'outside-',
  );
}

describe.skipIf(process.platform === 'win32')(
  'a local source is read only inside its folder',
  () => {
    test('a directory replaced by a link after the tree was listed is refused, not read through', async () => {
      const outside = await outsideFolder();
      const root = await folder({
        '.claude-plugin/marketplace.json':
          PLUGIN_INDEX_WITH_SKILLS['.claude-plugin/marketplace.json']!,
      });
      const tree = await readLocalSourceTree(root);
      await rename(join(root, '.claude-plugin'), join(root, 'moved'));
      await mkdir(join(outside, '.claude-plugin'));
      await rename(
        join(outside, 'marketplace.json'),
        join(outside, '.claude-plugin/marketplace.json'),
      );
      await symlink(
        join(outside, '.claude-plugin'),
        join(root, '.claude-plugin'),
      );
      const read = await tree
        .read('.claude-plugin/marketplace.json', REGISTRY_SOURCE_SCAN_LIMITS)
        .then(
          (bytes) => bytes.toString('utf8'),
          (error: unknown) => error,
        );
      expect(read).toBeInstanceOf(RegistrySourceScanRefusal);
      expect((read as RegistrySourceScanRefusal).bound).toBe('confinement');
      // Detection over that tree refuses the source as a whole.
      await expect(detectRegistrySourceTree(tree)).rejects.toMatchObject({
        bound: 'confinement',
      });
    });

    test('a linked SKILL.md is neither counted nor listed nor read', async () => {
      const { add, list } = setup();
      const outside = await outsideFolder();
      const root = await folder({
        'skills/real/SKILL.md': skillDocument('real'),
      });
      await mkdir(join(root, 'skills/linked'));
      await symlink(
        join(outside, 'outside/SKILL.md'),
        join(root, 'skills/linked/SKILL.md'),
      );
      const source = await add({ location: root });
      expect(kinds(source)).toEqual({
        skills: { count: 1, installable: true, via: 'skill-md' },
      });
      const rows = (await list('skills')).filter(
        (item) => item.catalog?.sourceId === source.id,
      );
      expect(rows.map((item) => item.catalog?.itemId)).toEqual(['real']);
      expect(JSON.stringify(rows)).not.toContain(OUTSIDE_SECRET);
    });

    test('a skills folder swapped for a link after detection lists and installs nothing from outside', async () => {
      const { add, list, request, json, home } = setup();
      const outside = await outsideFolder();
      const root = await folder({
        'skills/clarify/SKILL.md': skillDocument('clarify'),
      });
      const source = await add({ location: root });
      const [chosen] = (await list('skills')).filter(
        (item) => item.catalog?.sourceId === source.id,
      );
      expect(chosen?.catalog?.itemId).toBe('clarify');
      // After detection: `skills` now points outside the source.
      await rename(join(root, 'skills'), join(root, 'skills-moved'));
      await symlink(outside, join(root, 'skills'));
      const response = await request('/skills');
      const body = JSON.stringify(await response.json());
      expect(body).not.toContain(OUTSIDE_SECRET);
      const row = (
        await json<{ data: RegistrySource[] }>('/sources')
      ).data.find((entry) => entry.id === source.id);
      expect(row?.status).not.toBe('ready');
      const installed = await request('/skills/install', 'POST', {
        id: chosen!.id,
      });
      expect(installed.status).not.toBe(200);
      // Neither the listed skill nor anything from outside was installed.
      for (const name of ['clarify', 'leaked', 'outside'])
        await expect(access(join(home, 'skills', name))).rejects.toThrow();
    });
  },
);

describe('local SKILL.md reads are bounded before they happen', () => {
  const oversized = () =>
    `${skillDocument('big')}${'x'.repeat(REGISTRY_SOURCE_SCAN_LIMITS.maxFileBytes + 1)}`;

  test('detection refuses a source whose SKILL.md is over the bound, and lists none of it', async () => {
    const { add, list } = setup();
    const source = await add({
      location: await folder({
        'skills/small/SKILL.md': skillDocument('small'),
        'skills/big/SKILL.md': oversized(),
      }),
    });
    expect(source.detection).toMatchObject({ state: 'refused', kinds: [] });
    expect(source.detection?.reason).toContain(
      `larger than ${REGISTRY_SOURCE_SCAN_LIMITS.maxFileBytes} bytes`,
    );
    expect(
      (await list('skills')).filter(
        (item) => item.catalog?.sourceId === source.id,
      ),
    ).toEqual([]);
  });

  test('the filesystem skill provider refuses an oversized SKILL.md instead of buffering it', async () => {
    const root = await folder({ 'big/SKILL.md': oversized() });
    await expect(
      new FilesystemSkillRegistryProvider([root]).listAvailable(),
    ).rejects.toBeInstanceOf(LocalSourceFileTooLargeError);
    await expect(
      new FilesystemSkillRegistryProvider([root], {
        confineTo: root,
      }).listAvailable(),
    ).rejects.toBeInstanceOf(LocalSourceFileTooLargeError);
  });
});

describe('a plain agent id needs every agent catalog to answer', () => {
  test('a catalog that cannot be read refuses a plain-id install instead of letting another catalog win', async () => {
    const home = temporary('detected-unavailable-home-');
    await ensureStationHomeSchema(home);
    const { request } = setup(home);
    const configured = await stationFolder({ agents: ['shared'] });
    registerManifestRegistryProvider(
      new JsonManifestRegistryProvider(join(configured, 'registry.json'), home),
    );
    registerAgentRegistryProvider(
      {
        listAvailable: async () => {
          throw new Error('catalog host is down');
        },
        listInstalled: async () => [],
        install: async () => ({ success: true, message: 'should not run' }),
        uninstall: async () => ({ success: false, message: 'none' }),
      },
      'Team plugin',
    );
    const response = await request('/agents/install', 'POST', {
      id: 'shared',
      dataPolicy: 'preserve',
      consent: {
        permissions: [],
        contentDigest: computePluginContentDigest(
          join(configured, 'packages'),
          'shared',
        ),
        dependencies: [],
      },
    });
    const body = (await response.json()) as { code?: string; message?: string };
    expect(response.status, JSON.stringify(body)).toBe(503);
    expect(body.code).toBe('agent-catalog-unavailable');
    expect(body.message).toContain(
      'The agent catalog Team plugin could not be read',
    );
    expect(
      resolveInstalledPluginRoot(join(home, 'plugins'), 'shared'),
    ).toBeNull();
  });
});

/**
 * The configuration reader of a Station that predates detection, verbatim
 * from 463add8e (`registry-source-configuration.ts`): what a downgrade reads.
 */
function legacyConfigurationReader() {
  const sourceInput = z
    .object({
      displayName: z.string().trim().min(1).max(100),
      adapter: z.enum(['manifest', 'directory', 'github']),
      location: z.string().trim().min(1).max(2000),
    })
    .strict();
  const selectionSchema = z
    .object({
      sourceId: z.string().min(1).max(100),
      itemId: z.string().min(1).max(200),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      kind: z.enum(['skills', 'plugins']),
    })
    .strict();
  const registryItemSchema = z.object({
    providesTools: z.boolean().optional(),
    id: z.string().min(1).max(1500),
    displayName: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    version: z.string().max(200).optional(),
    source: z.string().max(2000).optional(),
    status: z.string().max(200).optional(),
    installed: z.boolean(),
    installedPluginName: z.string().max(200).optional(),
    tags: z.array(z.string().max(100)).max(32).optional(),
    catalog: selectionSchema.optional(),
    catalogSourceName: z.string().max(100).optional(),
    catalogFreshness: z.enum(['live', 'stale']).optional(),
    packageRevision: z.string().max(200).optional(),
  });
  const snapshotSchema = z.object({
    data: z.array(registryItemSchema).max(512),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    checkedAt: z.string().datetime(),
  });
  return z.object({
    version: z.literal(1),
    sources: z
      .array(
        sourceInput.extend({ id: z.string().uuid(), enabled: z.boolean() }),
      )
      .max(32),
    snapshots: z
      .record(z.string(), snapshotSchema)
      .refine((snapshots) => Object.keys(snapshots).length <= 32)
      .default({}),
    disabled: z.array(z.string()).max(128),
  });
}

describe('an earlier Station can still read the configuration', () => {
  test('after skills, plugins and agents catalogs persist, with no ref, the earlier reader accepts the file', async () => {
    const { add, list, home } = setup();
    const source = await add({
      location: await stationFolder({
        plugins: ['hello'],
        agents: ['reviewer'],
        skills: ['clarify'],
      }),
    });
    for (const kind of ['skills', 'plugins', 'agents'] as const)
      expect(
        (await list(kind)).some((item) => item.catalog?.sourceId === source.id),
      ).toBe(true);
    const file = JSON.parse(
      await readFile(join(home, 'config/registry-sources.json'), 'utf8'),
    ) as {
      snapshots: Record<string, { data: RegistryItem[] }>;
      kindSnapshots: Record<string, { data: RegistryItem[] }>;
    };
    expect(Object.keys(file.kindSnapshots)).toEqual([`${source.id}#agents`]);
    expect(
      Object.values(file.snapshots).every((snapshot) =>
        snapshot.data.every((item) => item.catalog?.kind !== 'agents'),
      ),
    ).toBe(true);
    const legacy = legacyConfigurationReader().safeParse(file);
    expect(legacy.success, JSON.stringify(legacy.error?.issues[0])).toBe(true);
  });

  test('a configured ref is refused by the earlier reader as a whole, never dropped', async () => {
    const { add, home } = setup();
    fakeGitHub('example-org', 'example-skills-and-plugin');
    const fetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) =>
        fetch(String(input).replace('/commits/main', '/commits/HEAD'), init),
      ),
    );
    await add({
      location: 'https://github.com/example-org/example-skills-and-plugin',
      ref: 'main',
    });
    const file = JSON.parse(
      await readFile(join(home, 'config/registry-sources.json'), 'utf8'),
    );
    expect(file.sources[0].ref).toBe('main');
    expect(legacyConfigurationReader().safeParse(file).success).toBe(false);
  });
});

describe('default sources have names that tell them apart', () => {
  const normalized = (name: string) =>
    name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  test('every default source has a unique name that does not differ only by punctuation', async () => {
    const { json } = setup();
    const home = '/home/someone';
    registerSkillRegistryProvider(
      new FilesystemSkillRegistryProvider([
        `${home}/.codex/skills`,
        `${home}/.claude/.agents/skills`,
        `${home}/station/app-homes/codex/skills`,
        `${home}/station/app-homes/claude/skills`,
      ]),
    );
    registerSkillRegistryProvider(
      new GitHubSkillRegistryProvider({
        owner: 'anthropics',
        repo: 'skills',
        path: 'skills',
        branch: 'main',
      }),
    );
    const defaults = (
      await json<{ data: RegistrySource[] }>('/sources')
    ).data.filter((source) => source.origin === 'configured');
    expect(defaults.map((source) => source.displayName)).toEqual([
      'Codex skills · user',
      'Claude skills · user',
      'Codex skills · Station app home',
      'Claude skills · Station app home',
      'anthropics/skills (default)',
    ]);
    const keys = defaults.map((source) => normalized(source.displayName));
    expect(new Set(keys).size).toBe(keys.length);
    // The location that tells them apart stays on the row.
    expect(defaults.every((source) => source.location)).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')(
  'a multiply linked file in a local source is refused',
  () => {
    test('a hard link added after the check is caught on the opened file', async () => {
      const root = await folder({
        'registry.json': '{"version":1,"plugins":[]}',
      });
      const outside = await outsideFolder();
      const read = await readConfinedFile(
        root,
        join(root, 'registry.json'),
        REGISTRY_SOURCE_SCAN_LIMITS.maxFileBytes,
        {
          beforeOpenForTest: () =>
            link(join(root, 'registry.json'), join(outside, 'second-name')),
        },
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(read).toBeInstanceOf(LocalSourceConfinementError);
      expect((read as Error).message).toContain(
        'cannot be told apart from the file it links to',
      );
    });

    test('a hard-linked registry.json neither passes detection nor reaches the plugin catalog', async () => {
      const { add, list } = setup();
      const outside = await outsideFolder();
      await writeFile(
        join(outside, 'registry.json'),
        JSON.stringify({
          version: 1,
          plugins: [
            {
              id: 'leaked',
              displayName: 'leaked',
              description: OUTSIDE_SECRET,
              version: '1.0.0',
              source: './leaked',
            },
          ],
        }),
      );
      // Linked in before the source is added: detection refuses it.
      const linkedRoot = temporary('hardlink-before-');
      await link(
        join(outside, 'registry.json'),
        join(linkedRoot, 'registry.json'),
      );
      const refused = await add({ location: linkedRoot });
      expect(refused.detection).toMatchObject({ state: 'refused', kinds: [] });
      expect(refused.detection?.reason).toContain('more than one hard link');
      // Swapped in after detection: the manifest read refuses it.
      const root = await stationFolder({ plugins: ['hello'] });
      const source = await add({ location: root });
      expect(
        (await list('plugins')).some(
          (item) => item.catalog?.sourceId === source.id,
        ),
      ).toBe(true);
      await rename(join(root, 'registry.json'), join(root, 'moved.json'));
      await link(join(outside, 'registry.json'), join(root, 'registry.json'));
      const rows = await list('plugins');
      expect(JSON.stringify(rows)).not.toContain(OUTSIDE_SECRET);
      expect(rows.some((item) => item.catalog?.itemId === 'leaked')).toBe(
        false,
      );
    });

    test('detection refuses a hard-linked SKILL.md with the reason, and counts none', async () => {
      const { add, list } = setup();
      const outside = await outsideFolder();
      const root = await folder({
        'skills/ordinary/SKILL.md': skillDocument('ordinary'),
      });
      await mkdir(join(root, 'skills/linked'));
      await link(
        join(outside, 'outside/SKILL.md'),
        join(root, 'skills/linked/SKILL.md'),
      );
      const source = await add({ location: root });
      expect(source.detection).toMatchObject({ state: 'refused', kinds: [] });
      expect(source.detection?.reason).toContain(
        'skills/linked/SKILL.md: Source file has more than one hard link',
      );
      const rows = await list('skills');
      expect(rows.some((item) => item.catalog?.sourceId === source.id)).toBe(
        false,
      );
      expect(JSON.stringify(rows)).not.toContain(OUTSIDE_SECRET);
    });

    test('a hard-linked file inside a package is refused before the package is resolved, hashed or copied', async () => {
      const outside = await outsideFolder();
      const root = await stationFolder({
        plugins: ['hello'],
        skills: ['clarify'],
      });
      const plugins = () =>
        new JsonManifestRegistryProvider(
          join(root, 'registry.json'),
          temporary('hardlink-package-home-'),
          undefined,
          undefined,
          { root },
        );
      const skills = () =>
        new FilesystemSkillRegistryProvider([join(root, 'skills')], {
          confineTo: root,
        });
      expect(await plugins().resolvePackage('hello')).toBeTruthy();
      expect(await skills().getPackageRevision('clarify')).toBeTruthy();
      // A second name for a package's own file, kept outside the source.
      await link(
        join(root, 'packages/hello/plugin.json'),
        join(outside, 'plugin-second-name'),
      );
      await expect(plugins().resolvePackage('hello')).rejects.toThrow(
        'more than one hard link',
      );
      // A file other than SKILL.md in a skill package counts too.
      await writeFile(join(root, 'skills/clarify/notes.md'), 'notes');
      await link(
        join(root, 'skills/clarify/notes.md'),
        join(outside, 'notes-second-name'),
      );
      await expect(skills().getPackageRevision('clarify')).rejects.toThrow(
        'more than one hard link',
      );
    });

    test('a hard-linked SKILL.md is refused by the confined skill provider', async () => {
      const outside = await outsideFolder();
      const root = temporary('hardlink-skill-');
      await mkdir(join(root, 'linked'));
      await link(
        join(outside, 'outside/SKILL.md'),
        join(root, 'linked/SKILL.md'),
      );
      await expect(
        new FilesystemSkillRegistryProvider([root], {
          confineTo: root,
        }).listAvailable(),
      ).rejects.toThrow('more than one hard link');
      await expect(
        new FilesystemSkillRegistryProvider([root], {
          confineTo: root,
        }).getPackageRevision('linked'),
      ).rejects.toThrow('more than one hard link');
    });
  },
);

describe('every install path applies the same agent ownership rule', () => {
  async function catalogs(kind: 'unavailable' | 'ambiguous') {
    const home = temporary(`detected-${kind}-home-`);
    await ensureStationHomeSchema(home);
    const { request } = setup(home);
    const configured = await stationFolder({
      agents: ['shared'],
      plugins: ['hello'],
    });
    registerManifestRegistryProvider(
      new JsonManifestRegistryProvider(join(configured, 'registry.json'), home),
    );
    registerAgentRegistryProvider(
      {
        listAvailable: async () => {
          if (kind === 'unavailable') throw new Error('catalog host is down');
          return [{ id: 'shared', installed: false }];
        },
        listInstalled: async () => [],
        install: async () => ({ success: true, message: 'should not run' }),
        uninstall: async () => ({ success: false, message: 'none' }),
      },
      'Team plugin',
    );
    const install = (path: string, id: string) =>
      request(path, 'POST', {
        id,
        dataPolicy: 'preserve',
        consent: {
          permissions: [],
          contentDigest: computePluginContentDigest(
            join(configured, 'packages'),
            id,
          ),
          dependencies: [],
        },
      });
    return { home, install };
  }

  test.each([
    ['unavailable', 503, 'agent-catalog-unavailable'],
    ['ambiguous', 409, 'agent-catalog-ambiguous'],
  ] as const)(
    'an %s agent catalog owner refuses the agent and plugin install routes and the shared acquisition lookup',
    async (kind, status, code) => {
      const { home, install } = await catalogs(kind);
      for (const path of ['/agents/install', '/plugins/install']) {
        const response = await install(path, 'shared');
        const body = (await response.json()) as { code?: string };
        expect(response.status, `${path} ${JSON.stringify(body)}`).toBe(status);
        expect(body.code).toBe(code);
      }
      // Preview, update and dependency resolution all acquire through this.
      await expect(
        resolvePluginRegistryInstall('shared'),
      ).rejects.toBeInstanceOf(AgentCatalogOwnershipRefusal);
      expect(
        resolveInstalledPluginRoot(join(home, 'plugins'), 'shared'),
      ).toBeNull();
    },
  );

  test('an ordinary plugin is not blocked because an agent catalog is down', async () => {
    const { install } = await catalogs('unavailable');
    const response = await install('/plugins/install', 'hello');
    const body = (await response.json()) as { code?: string };
    expect(body.code).not.toBe('agent-catalog-unavailable');
    expect(response.status, JSON.stringify(body)).toBe(200);
  });
});

/**
 * The ownership rule sits in the one registry resolver, so it holds for every
 * caller that acquires: install, preview, update, dependency preview and
 * installation, and acquisition capture. Removal only looks up.
 */
describe('every acquisition caller of the registry resolver checks agent ownership', () => {
  /** The real plugin install and lifecycle routers (preview, update). */
  function pluginRoutes(home: string, store: EventStore) {
    const app = new Hono();
    const deps = {
      projectHomeDir: home,
      pluginsDir: join(home, 'plugins'),
      agentsDir: join(home, 'agents'),
      logger,
      packageMcpJournal: store.createPackageMcpAdmissionJournal(),
      projectVisiblePlugins:
        () =>
        <T>(items: T) =>
          items,
      visibility: {
        resolvePrincipal: () => ({
          id: LOCAL_OPERATOR_PRINCIPAL_ID,
          kind: 'human' as const,
          display: 'Operator',
        }),
      },
      buildPlugin: async () => {},
    };
    registerPluginInstallRoutes(app, deps);
    registerPluginLifecycleRoutes(app, deps);
    const bound = withOperatorPrincipal(app);
    return (path: string, body: unknown = {}) =>
      bound.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
  }

  /** `parent` depends on `shared`; one readable catalog offers `shared` as an agent. */
  async function catalogs(root: string, home: string) {
    await ensureStationHomeSchema(home);
    const harness = setup(home);
    registerManifestRegistryProvider(
      new JsonManifestRegistryProvider(join(root, 'registry.json'), home),
    );
    registerAgentRegistryProvider(
      {
        listAvailable: async () => [{ id: 'shared', installed: false }],
        listInstalled: async () => [],
        install: async () => ({ success: false, message: 'unused' }),
        uninstall: async () => ({ success: false, message: 'unused' }),
      },
      'Known agent',
    );
    return { ...harness, call: pluginRoutes(home, harness.store) };
  }

  /** A second agent catalog that cannot be read, or that also offers `shared`. */
  function unsettle(kind: 'unavailable' | 'ambiguous') {
    registerAgentRegistryProvider(
      {
        listAvailable: async () => {
          if (kind === 'unavailable') throw new Error('catalog host is down');
          return [{ id: 'shared', installed: false }];
        },
        listInstalled: async () => [],
        install: async () => {
          throw new Error('must not install');
        },
        uninstall: async () => ({ success: false, message: 'unused' }),
      },
      'Second agent catalog',
    );
  }

  async function dependentFolder() {
    const root = await stationFolder({ plugins: ['shared', 'parent'] });
    const path = join(root, 'packages/parent/plugin.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.extensions = {
      'io.kontourai.station': {
        schemaVersion: '1.0',
        dependencies: [{ name: 'shared', version: '*' }],
      },
    };
    await writeFile(path, JSON.stringify(manifest));
    return root;
  }

  const codeOf = async (response: Response) =>
    `${response.status} ${await response.clone().text()}`;

  test.each([
    ['unavailable', 503, 'agent-catalog-unavailable'],
    ['ambiguous', 409, 'agent-catalog-ambiguous'],
  ] as const)(
    'an %s owner refuses install, preview, update, dependency preview and installation, and capture',
    async (kind, status, code) => {
      const root = await dependentFolder();
      const home = temporary(`acquire-${kind}-home-`);
      const { call, request } = await catalogs(root, home);
      // While ownership is settled: consent for parent, and shared installed
      // so a real update has something to update.
      const settled = await call('/preview', { registryId: 'parent' });
      const preview = (await settled.json()) as {
        valid: boolean;
        permissions: { required: string[] };
        contentDigest: string;
        dependencies: Array<{ id: string; consent: Record<string, unknown> }>;
      };
      expect(settled.status, JSON.stringify(preview)).toBe(200);
      expect(preview.dependencies.map(({ id }) => id)).toEqual(['shared']);
      const consent = {
        permissions: preview.permissions.required,
        contentDigest: preview.contentDigest,
        dependencies: ['shared'],
        dependencyApprovals: preview.dependencies.map((dependency) => ({
          id: dependency.id,
          ...dependency.consent,
        })),
      };
      const installed = await request('/plugins/install', 'POST', {
        id: 'shared',
        dataPolicy: 'preserve',
        consent: {
          permissions: [],
          contentDigest: computePluginContentDigest(
            join(root, 'packages'),
            'shared',
          ),
          dependencies: [],
        },
      });
      expect(installed.status, await codeOf(installed)).toBe(200);

      unsettle(kind);
      // Every caller is exercised before anything is asserted, so a failure
      // names each caller that got through, not only the first.
      const outcomes: Record<string, string> = {};
      const record = async (caller: string, response: Response) => {
        outcomes[caller] = await codeOf(response);
      };
      for (const path of ['/agents/install', '/plugins/install'])
        await record(
          path,
          await request(path, 'POST', {
            id: 'shared',
            dataPolicy: 'preserve',
            consent: { permissions: [], contentDigest: 'x', dependencies: [] },
          }),
        );
      await record('preview', await call('/preview', { registryId: 'shared' }));
      await record('update', await call('/shared/update'));
      outcomes.capture = await capturePluginRegistryAcquisition(
        root,
        { name: 'shared', version: '1.0.0' } as never,
        'digest',
        { projectHomeDir: home },
        'shared',
        'unused',
      ).then(
        () => 'captured',
        (error: unknown) =>
          error instanceof AgentCatalogOwnershipRefusal
            ? `${status} ${error.code}`
            : String(error),
      );
      // Removal only looks up, so it still finds the installed package.
      expect(await isRegistryPluginRemovalTarget('shared', home)).toBe(true);

      // A home without shared: parent's preview and installation must
      // acquire shared as a dependency.
      const fresh = temporary(`acquire-${kind}-fresh-`);
      const next = await catalogs(root, fresh);
      unsettle(kind);
      await record(
        'dependency preview',
        await next.call('/preview', { registryId: 'parent' }),
      );
      await record(
        'dependency installation',
        await next.request('/plugins/install', 'POST', {
          id: 'parent',
          dataPolicy: 'preserve',
          consent,
        }),
      );
      const through = Object.entries(outcomes).filter(
        ([, outcome]) =>
          !outcome.startsWith(`${status} `) || !outcome.includes(code),
      );
      expect(Object.fromEntries(through)).toEqual({});
      expect(Object.keys(outcomes)).toHaveLength(7);
      for (const name of ['shared', 'parent'])
        expect(
          resolveInstalledPluginRoot(join(fresh, 'plugins'), name),
        ).toBeNull();
    },
  );
});
