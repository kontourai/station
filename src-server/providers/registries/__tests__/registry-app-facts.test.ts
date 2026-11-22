import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { RegistryItem } from '@kontourai/station-contracts/catalog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { JsonManifestRegistryProvider } from '../json-manifest-registry.js';
import { RegistryAppFactsReader } from '../registry-app-facts.js';
import { readRegistrySourceConfiguration } from '../registry-source-configuration.js';

const repoRoot = process.cwd();
const temporary = trackTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
});

function example(name: string, file: string): string {
  return resolve(repoRoot, 'examples', name, file);
}

/** Facts of every entry, keyed by id, from the provider's catalog snapshot. */
async function factsById(
  provider: JsonManifestRegistryProvider,
): Promise<Map<string, RegistryItem['app']>> {
  const snapshot = await provider.getCatalogSnapshot();
  return new Map(snapshot.items.map((item) => [item.id, item.app]));
}

describe('app facts in the repository catalog', () => {
  it('describes apps from their real manifests and nothing else', async () => {
    const provider = new JsonManifestRegistryProvider(
      resolve(repoRoot, 'examples/registry/manifest.json'),
      temporary('app-facts-home-'),
    );
    const facts = await factsById(provider);

    expect(facts.get('knowledge-docs-starter')).toEqual({
      kind: 'app',
      screens: ['Library', 'Ask', 'Sources'],
      panes: [],
      opensAs: ['screen', 'project-view'],
      worksWith: ['chats-and-agents', 'knowledge'],
      agents: 1,
      promptActions: ['Summarize selected documents'],
      knowledge: ['Starter Documents'],
      toolServers: [],
      sandboxedToolView: false,
    });
    expect(facts.get('enterprise-layout')).toMatchObject({
      kind: 'app',
      screens: ['Dashboard', 'Calendar', 'CRM', 'Notes'],
      agents: 1,
      knowledge: ['Meeting Notes'],
    });
    // Two primary panes that need a project, and no layout.
    expect(facts.get('coding-starter')).toMatchObject({
      kind: 'app',
      screens: [],
      panes: ['Coding Workspace', 'Coding Diff Review'],
      opensAs: ['project-view'],
      agents: 1,
    });
    // A plugin that only adds a routing provider, and a skills collection.
    expect(facts.get('smart-routing')).toEqual({ kind: 'none' });
    expect(facts.get('matt-pocock-engineering')).toEqual({ kind: 'none' });
  });
});

/** A local catalog of real example manifests plus deliberately broken ones. */
function catalogTree() {
  const root = temporary('app-facts-catalog-');
  const entries: Array<{ id: string; source: string }> = [];
  const add = (id: string, files: Record<string, string>) => {
    mkdirSync(join(root, id), { recursive: true });
    for (const [name, contents] of Object.entries(files))
      writeFileSync(join(root, id, name), contents);
    entries.push({ id, source: `../${id}` });
  };
  const copyExample = (id: string, name: string, files: string[]) => {
    mkdirSync(join(root, id), { recursive: true });
    for (const file of files)
      copyFileSync(example(name, file), join(root, id, file));
    entries.push({ id, source: `../${id}` });
  };
  const writeIndex = () => {
    mkdirSync(join(root, 'registry'), { recursive: true });
    writeFileSync(
      join(root, 'registry', 'index.json'),
      JSON.stringify({
        version: 1,
        plugins: entries.map((entry) => ({
          ...entry,
          displayName: entry.id,
          description: entry.id,
          version: '1.0.0',
        })),
      }),
    );
    return join(root, 'registry', 'index.json');
  };
  return { root, add, copyExample, entries, writeIndex };
}

const knowledgeManifest = () =>
  readFileSync(example('knowledge-docs-starter', 'plugin.json'), 'utf8');
const knowledgeLayout = () =>
  JSON.parse(
    readFileSync(example('knowledge-docs-starter', 'layout.json'), 'utf8'),
  );

function layoutWithTabs(count: number): string {
  return JSON.stringify({
    ...knowledgeLayout(),
    tabs: Array.from({ length: count }, (_, index) => ({
      id: `tab-${index}`,
      label: `Tab ${index}`,
      component: 'knowledge-library',
    })),
  });
}

describe('app facts read from a local catalog', () => {
  it('marks the sandboxed tool view and keeps bad entries from affecting the rest', async () => {
    const tree = catalogTree();
    tree.copyExample('session-activity', 'workspace-pane-starter', [
      'plugin.json',
    ]);
    tree.copyExample('knowledge', 'knowledge-docs-starter', [
      'plugin.json',
      'layout.json',
    ]);
    tree.add('missing', {});
    tree.add('malformed', { 'plugin.json': '{"name": "malformed",' });
    tree.add('missing-layout', { 'plugin.json': knowledgeManifest() });
    tree.entries.push({
      id: 'remote',
      source: 'https://example.invalid/remote-plugin.git',
    });
    const provider = new JsonManifestRegistryProvider(
      tree.writeIndex(),
      temporary('app-facts-home-'),
    );
    const read = vi.spyOn(RegistryAppFactsReader.prototype, 'read');
    const facts = await factsById(provider);

    // A remote package is never handed to the reader, so nothing is fetched.
    expect(read.mock.calls.map(([entryId]) => entryId)).not.toContain('remote');
    expect(read.mock.calls.map(([entryId]) => entryId)).toContain('knowledge');
    expect(facts.get('session-activity')).toEqual({
      kind: 'app',
      screens: [],
      panes: ['Session activity'],
      opensAs: ['project-view', 'pane'],
      worksWith: ['chats-and-agents'],
      agents: 0,
      promptActions: ['Summarize activity'],
      knowledge: [],
      toolServers: ['station-sessions-mcp'],
      sandboxedToolView: true,
    });
    expect(facts.get('knowledge')).toMatchObject({
      kind: 'app',
      screens: ['Library', 'Ask', 'Sources'],
    });
    for (const id of ['missing', 'malformed', 'missing-layout', 'remote']) {
      expect(facts.has(id)).toBe(true);
      expect(facts.get(id)).toBeUndefined();
    }
  });

  it('refuses a list over its bound instead of truncating it', async () => {
    const tree = catalogTree();
    tree.add('at-bound', {
      'plugin.json': knowledgeManifest(),
      'layout.json': layoutWithTabs(32),
    });
    tree.add('over-bound', {
      'plugin.json': knowledgeManifest(),
      'layout.json': layoutWithTabs(33),
    });
    tree.add('oversized-layout', {
      'plugin.json': knowledgeManifest(),
      'layout.json': JSON.stringify({
        ...knowledgeLayout(),
        description: 'x'.repeat(256 * 1024),
      }),
    });
    const facts = await factsById(
      new JsonManifestRegistryProvider(
        tree.writeIndex(),
        temporary('app-facts-home-'),
      ),
    );

    const atBound = facts.get('at-bound');
    expect(atBound?.kind === 'app' && atBound.screens).toHaveLength(32);
    expect(facts.get('over-bound')).toBeUndefined();
    expect(facts.get('oversized-layout')).toBeUndefined();
  });

  it('reads a changed package again on the next listing', async () => {
    const tree = catalogTree();
    tree.copyExample('knowledge', 'knowledge-docs-starter', [
      'plugin.json',
      'layout.json',
    ]);
    const provider = new JsonManifestRegistryProvider(
      tree.writeIndex(),
      temporary('app-facts-home-'),
    );
    expect((await factsById(provider)).get('knowledge')).toMatchObject({
      screens: ['Library', 'Ask', 'Sources'],
    });

    const layout = knowledgeLayout();
    layout.tabs[1].label = 'Questions and answers';
    writeFileSync(
      join(tree.root, 'knowledge', 'layout.json'),
      JSON.stringify(layout),
    );
    expect((await factsById(provider)).get('knowledge')).toMatchObject({
      screens: ['Library', 'Questions and answers', 'Sources'],
    });

    writeFileSync(join(tree.root, 'knowledge', 'plugin.json'), '{');
    expect((await factsById(provider)).get('knowledge')).toBeUndefined();
  });

  it('reads a folder source confined to the folder', async () => {
    const tree = catalogTree();
    tree.copyExample('knowledge', 'knowledge-docs-starter', [
      'plugin.json',
      'layout.json',
    ]);
    const provider = new JsonManifestRegistryProvider(
      tree.writeIndex(),
      temporary('app-facts-home-'),
      undefined,
      undefined,
      { root: tree.root },
    );
    expect((await factsById(provider)).get('knowledge')).toMatchObject({
      kind: 'app',
      screens: ['Library', 'Ask', 'Sources'],
    });
  });
});

/** A provider whose warnings are kept, so a test can tell which layer refused. */
function providerWithWarnings(index: string, origin: { root?: string } = {}) {
  const warn = vi.fn();
  const provider = new JsonManifestRegistryProvider(
    index,
    temporary('app-facts-home-'),
    undefined,
    { warn },
    origin,
  );
  const refusal = (entryId: string) =>
    warn.mock.calls
      .filter(
        ([, detail]) => (detail as { entryId?: string }).entryId === entryId,
      )
      .map(([, detail]) => String((detail as { error?: unknown }).error));
  return { provider, refusal };
}

/** The knowledge starter's manifest with its layout source replaced. */
function manifestWithLayoutSource(source: string): string {
  const manifest = JSON.parse(knowledgeManifest());
  manifest.layout.source = source;
  return JSON.stringify(manifest);
}

describe('app facts stay inside their package', () => {
  for (const asFolderSource of [false, true]) {
    const kind = asFolderSource ? 'a folder source' : 'a catalog source';
    it(`does not read a layout outside the package, from ${kind}`, async () => {
      const tree = catalogTree();
      // A valid layout outside the package: read, it would yield facts.
      mkdirSync(join(tree.root, 'outside'), { recursive: true });
      writeFileSync(
        join(tree.root, 'outside', 'layout.json'),
        JSON.stringify(knowledgeLayout()),
      );
      tree.add('relative', {
        'plugin.json': manifestWithLayoutSource('../outside/layout.json'),
      });
      tree.add('linked', { 'plugin.json': knowledgeManifest() });
      symlinkSync(
        join(tree.root, 'outside', 'layout.json'),
        join(tree.root, 'linked', 'layout.json'),
      );
      const { provider, refusal } = providerWithWarnings(
        tree.writeIndex(),
        asFolderSource ? { root: tree.root } : {},
      );
      const facts = await factsById(provider);

      for (const id of ['relative', 'linked']) {
        expect(facts.get(id)).toBeUndefined();
        expect(refusal(id)).toEqual([
          expect.stringContaining('resolves outside its package'),
        ]);
      }
    });
  }

  it('re-reads a layout whose in-package link target changed', async () => {
    const tree = catalogTree();
    tree.add('linked', {
      'plugin.json': knowledgeManifest(),
      'layout-v1.json': JSON.stringify(knowledgeLayout()),
    });
    symlinkSync(
      join(tree.root, 'linked', 'layout-v1.json'),
      join(tree.root, 'linked', 'layout.json'),
    );
    const provider = new JsonManifestRegistryProvider(
      tree.writeIndex(),
      temporary('app-facts-home-'),
    );
    expect((await factsById(provider)).get('linked')).toMatchObject({
      screens: ['Library', 'Ask', 'Sources'],
    });

    const layout = knowledgeLayout();
    layout.tabs[0].label = 'Shelf';
    writeFileSync(
      join(tree.root, 'linked', 'layout-v1.json'),
      JSON.stringify(layout),
    );
    expect((await factsById(provider)).get('linked')).toMatchObject({
      screens: ['Shelf', 'Ask', 'Sources'],
    });
  });

  it('refuses more layouts than the bound before reading any of them', async () => {
    const tree = catalogTree();
    const manifest = JSON.parse(knowledgeManifest());
    // None of these files exist: reading one would refuse as missing.
    manifest.layouts = Array.from({ length: 32 }, (_, index) => ({
      slug: `extra-${index}`,
      source: `./missing-${index}.json`,
    }));
    tree.add('many-layouts', { 'plugin.json': JSON.stringify(manifest) });
    const { provider, refusal } = providerWithWarnings(tree.writeIndex());

    expect((await factsById(provider)).get('many-layouts')).toBeUndefined();
    expect(refusal('many-layouts')).toEqual([
      expect.stringContaining('too many layouts'),
    ]);
  });

  it('reads nothing again for an unchanged catalog', async () => {
    const tree = catalogTree();
    tree.copyExample('knowledge', 'knowledge-docs-starter', [
      'plugin.json',
      'layout.json',
    ]);
    tree.copyExample('session-activity', 'workspace-pane-starter', [
      'plugin.json',
    ]);
    const provider = new JsonManifestRegistryProvider(
      tree.writeIndex(),
      temporary('app-facts-home-'),
    );
    const reads = vi.spyOn(
      RegistryAppFactsReader.prototype as unknown as {
        readPackageFile: (...args: unknown[]) => Promise<Buffer>;
      },
      'readPackageFile',
    );
    await factsById(provider);
    // plugin.json and layout.json, then the pane-only plugin.json.
    expect(reads).toHaveBeenCalledTimes(3);
    await factsById(provider);
    expect(reads).toHaveBeenCalledTimes(3);
  });
});

describe('app facts in a stored catalog snapshot', () => {
  it('keeps facts within bounds and drops others without refusing the file', () => {
    const file = join(temporary('app-facts-config-'), 'registry-sources.json');
    const item = (id: string, app: unknown) => ({ id, installed: false, app });
    const valid = { kind: 'none' };
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sources: [],
        disabled: [],
        snapshots: {
          catalog: {
            revision: 'a'.repeat(64),
            checkedAt: new Date(0).toISOString(),
            data: [item('kept', valid), item('dropped', { kind: 'window' })],
          },
        },
      }),
    );
    const data = readRegistrySourceConfiguration(file).snapshots.catalog?.data;
    expect(data?.map((entry) => [entry.id, entry.app])).toEqual([
      ['kept', valid],
      ['dropped', undefined],
    ]);
  });
});
