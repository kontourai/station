/**
 * Plugin draft preview routes (epic #2323 S3) over the REAL draft service:
 * real esbuild, the real shared watcher (with a short polling interval so a
 * silent native watch layer still carries the edit), and a real temp Project
 * folder. The Project read guard that refuses non-members is exercised over
 * the production composition in `runtime-routes-project-guest-admin.test.ts`.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginDraftStatus } from '@kontourai/station-contracts/plugin-draft';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PluginDraftService } from '../../../services/plugins/plugin-draft-service.js';
import { createPluginDraftRoutes } from '../plugin-draft-routes.js';

const TEST_TIMEOUT_MS = 60_000;
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePlugin(dir: string, label = 'first') {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      name: 'connected-pulse',
      version: '1.0.0',
      entrypoint: './src/index.tsx',
      workspacePanes: [
        {
          version: '1.0',
          id: 'pane:plugin%3Aconnected-pulse:pulse:workspace',
          name: 'Connected Pulse',
          rendererId:
            'renderer:plugin%3Aconnected-pulse:plugin-component:pulse',
          renderer: { kind: 'plugin-component', name: 'pulse' },
          placement: {
            supportedRegions: ['primary'],
            preferredRegion: 'primary',
          },
          modes: [{ id: 'default', contextRequirement: { project: true } }],
          provenance: { origin: 'plugin', pluginId: 'connected-pulse' },
          lifecycle: { stage: 'stable' },
        },
      ],
    }),
  );
  writeSource(dir, label);
}

function writeSource(dir: string, label: string) {
  writeFileSync(
    join(dir, 'src', 'index.tsx'),
    `export const components = { pulse: () => ${JSON.stringify(label)} };\n`,
  );
}

function harness(
  options: { maxActiveLeases?: number; now?: () => number } = {},
) {
  const projectDir = tempDir('station-draft-project-');
  const otherDir = tempDir('station-draft-other-');
  const draftsRoot = join(tempDir('station-draft-home-'), 'plugin-drafts');
  const emitted: Array<{
    projectSlug: string;
    draftId: string;
    generation: number;
  }> = [];
  const service = new PluginDraftService({
    draftsRoot,
    emitRebuilt: (event) => emitted.push(event),
    pollIntervalMs: 150,
    debounceMs: 50,
    ...options,
  });
  cleanup.push(() => service.dispose());
  const directories: Record<string, string> = {
    demo: projectDir,
    other: otherDir,
  };
  const app = new Hono();
  app.route(
    '/api/projects',
    createPluginDraftRoutes({
      service,
      resolveProjectDirectory: (slug) => directories[slug],
    }),
  );
  const status = async (slug = 'demo') =>
    (await (
      await app.request(`/api/projects/${slug}/plugin-draft`)
    ).json()) as PluginDraftStatus;
  const lease = async (slug = 'demo') => {
    const response = await app.request(
      `/api/projects/${slug}/plugin-draft/lease`,
      { method: 'POST' },
    );
    return { response, body: (await response.json()) as PluginDraftStatus };
  };
  const waitFor = async (
    predicate: (status: PluginDraftStatus) => boolean,
    slug = 'demo',
  ) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const current = await status(slug);
      if (predicate(current)) return current;
      if (Date.now() > deadline)
        throw new Error(`timed out; last status ${JSON.stringify(current)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return {
    app,
    service,
    projectDir,
    otherDir,
    draftsRoot,
    emitted,
    status,
    lease,
    waitFor,
  };
}

describe('plugin draft routes', () => {
  test(
    'a lease builds the Project folder into host storage and never writes into the folder',
    async () => {
      const h = harness();
      writePlugin(h.projectDir);
      const { response } = await h.lease();
      expect(response.status).toBe(200);
      const ready = await h.waitFor((s) => s.state === 'ready');
      expect(ready.generation).toBe(1);
      expect(ready.draftId).toMatch(/^draft_[0-9a-f]{32}$/);
      expect(ready.registrationKey).toMatch(
        new RegExp(`^${ready.draftId}:[0-9a-f]{12}:1$`),
      );
      expect(ready.digest).toMatch(/^[0-9a-f]{32}$/);
      expect(ready.pluginName).toBe('connected-pulse');
      expect(ready.panes).toEqual([
        {
          id: 'pane:plugin%3Aconnected-pulse:pulse:workspace',
          name: 'Connected Pulse',
          component: 'pulse',
        },
      ]);
      // The author's folder is exactly what they wrote.
      expect(readdirSync(h.projectDir).sort()).toEqual(['plugin.json', 'src']);
      expect(existsSync(join(h.projectDir, 'dist'))).toBe(false);
      expect(existsSync(join(h.projectDir, 'node_modules'))).toBe(false);

      const bundle = await h.app.request(
        `/api/projects/demo/plugin-draft/generations/1/${ready.digest}/bundle.js`,
      );
      expect(bundle.status).toBe(200);
      expect(bundle.headers.get('content-type')).toContain(
        'application/javascript',
      );
      expect(bundle.headers.get('cache-control')).toBe('private, no-store');
      const source = await bundle.text();
      expect(source).toContain('__station_ai_plugin_drafts');
      expect(source).toContain(JSON.stringify(ready.registrationKey));
      expect(source).not.toContain('window.__station_ai_plugins[');

      expect(
        (
          await h.app.request(
            `/api/projects/demo/plugin-draft/generations/2/${ready.digest}/bundle.js`,
          )
        ).status,
      ).toBe(404);
      // The right generation with any other digest is not that revision.
      expect(
        (
          await h.app.request(
            '/api/projects/demo/plugin-draft/generations/1/00000000000000000000000000000000/bundle.js',
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await h.app.request(
            `/api/projects/demo/plugin-draft/generations/..%2F1/${ready.digest}/bundle.js`,
          )
        ).status,
      ).toBe(400);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'status reports manifest diagnostics for a broken plugin.json and serves nothing',
    async () => {
      const h = harness();
      writePlugin(h.projectDir);
      writeFileSync(join(h.projectDir, 'plugin.json'), '{ "name": ');
      await h.lease();
      const failed = await h.waitFor((s) => s.state === 'failed');
      expect(failed.generation).toBeNull();
      expect(failed.diagnostics[0]).toMatchObject({ file: 'plugin.json' });
      expect(failed.diagnostics[0].text).not.toContain(h.projectDir);
      expect(h.emitted).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a source error becomes a diagnostic with a Project-relative location',
    async () => {
      const h = harness();
      writePlugin(h.projectDir);
      writeFileSync(
        join(h.projectDir, 'src', 'index.tsx'),
        "import missing from 'not-installed-anywhere';\nexport const components = { pulse: () => missing };\n",
      );
      await h.lease();
      const failed = await h.waitFor((s) => s.state === 'failed');
      expect(failed.diagnostics[0]).toMatchObject({
        file: 'src/index.tsx',
        line: 1,
      });
      expect(existsSync(join(h.projectDir, 'node_modules'))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a file edit produces a new generation and emits the rebuilt event; an unchanged save does not',
    async () => {
      const h = harness();
      writePlugin(h.projectDir, 'first');
      await h.lease();
      const first = await h.waitFor((s) => s.state === 'ready');
      expect(h.emitted).toEqual([
        { projectSlug: 'demo', draftId: first.draftId, generation: 1 },
      ]);

      writeSource(h.projectDir, 'second');
      const second = await h.waitFor(
        (s) => s.state === 'ready' && s.generation === 2,
      );
      expect(second.registrationKey).toBe(
        first.registrationKey?.replace(/:1$/, ':2'),
      );
      expect(second.digest).not.toBe(first.digest);
      expect(h.emitted.at(-1)).toEqual({
        projectSlug: 'demo',
        draftId: first.draftId,
        generation: 2,
      });
      const bundle = await (
        await h.app.request(
          `/api/projects/demo/plugin-draft/generations/2/${second.digest}/bundle.js`,
        )
      ).text();
      expect(bundle).toContain('second');

      // Rewriting identical bytes is not a revision.
      const emittedBefore = h.emitted.length;
      writeSource(h.projectDir, 'second');
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await h.service.idle('demo', h.projectDir);
      expect((await h.status()).generation).toBe(2);
      expect(h.emitted.length).toBe(emittedBefore);
    },
    TEST_TIMEOUT_MS,
  );

  // S3 review MEDIUM-1: the generation counter restarts with each server
  // lifetime, so a revision is named by a per-lifetime key and its digest.
  // A viewer who chose "revision 1" in one lifetime can neither be served a
  // later lifetime's revision 1 nor mistake it for the one they chose.
  test(
    'a revision from a previous server lifetime is neither the same key nor served',
    async () => {
      const first = harness();
      writePlugin(first.projectDir, 'first lifetime');
      await first.lease();
      const before = await first.waitFor((s) => s.state === 'ready');
      first.service.dispose();

      const second = new PluginDraftService({
        draftsRoot: join(tempDir('station-draft-home2-'), 'plugin-drafts'),
        emitRebuilt: () => {},
        pollIntervalMs: 150,
        debounceMs: 50,
      });
      cleanup.push(() => second.dispose());
      writeSource(first.projectDir, 'second lifetime');
      second.lease('demo', first.projectDir);
      await second.idle('demo', first.projectDir);
      const after = second.status('demo', first.projectDir);
      expect(after.generation).toBe(before.generation);
      expect(after.draftId).toBe(before.draftId);
      expect(after.registrationKey).not.toBe(before.registrationKey);
      expect(after.digest).not.toBe(before.digest);
      expect(
        second.bundleFile(
          'demo',
          first.projectDir,
          before.generation as number,
          before.digest as string,
          'js',
        ),
      ).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test('status without a lease is idle and starts nothing', async () => {
    const h = harness();
    writePlugin(h.projectDir);
    const idle = await h.status();
    expect(idle).toMatchObject({ state: 'idle', generation: null });
    expect(existsSync(h.draftsRoot)).toBe(false);
    expect(
      (
        await h.app.request(
          '/api/projects/demo/plugin-draft/generations/1/00000000000000000000000000000000/bundle.js',
        )
      ).status,
    ).toBe(404);
  });

  test('a Project without a folder is refused', async () => {
    const h = harness();
    const response = await h.app.request(
      '/api/projects/missing/plugin-draft/lease',
      { method: 'POST' },
    );
    expect(response.status).toBe(404);
  });

  test(
    'an expired lease releases the watcher and removes the built revisions',
    async () => {
      let now = Date.now();
      const h = harness({ now: () => now });
      writePlugin(h.projectDir);
      await h.lease();
      const ready = await h.waitFor((s) => s.state === 'ready');
      const draftDir = join(h.draftsRoot, ready.draftId as string);
      expect(existsSync(draftDir)).toBe(true);
      now += 10 * 60_000;
      h.service.releaseExpired();
      expect((await h.status()).state).toBe('idle');
      expect(existsSync(draftDir)).toBe(false);
      // A released draft does not rebuild on edit.
      const emittedBefore = h.emitted.length;
      writeSource(h.projectDir, 'after-release');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(h.emitted.length).toBe(emittedBefore);
    },
    TEST_TIMEOUT_MS,
  );

  test('caps concurrently leased drafts', async () => {
    const build = vi.fn(async () => ({
      ok: false as const,
      diagnostics: [{ text: 'stub' }],
    }));
    const h = harness({ maxActiveLeases: 1 });
    // Swap in a stub builder: this test is about lease accounting only.
    (h.service as unknown as { build: typeof build }).build = build;
    writePlugin(h.projectDir);
    writePlugin(h.otherDir);
    expect((await h.lease('demo')).body.state).not.toBe('unavailable');
    const refused = await h.lease('other');
    expect(refused.body.state).toBe('unavailable');
    expect(refused.body.diagnostics[0].text).toContain('Too many');
  });
});
