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
import {
  PLUGIN_DRAFT_LEASE_TTL_MS,
  type PluginDraftStatus,
} from '@kontourai/station-contracts/plugin-draft';
import { buildPluginDraft } from '@kontourai/station-shared/build';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  PluginDraftService,
  pluginDraftId,
} from '../../../services/plugins/plugin-draft-service.js';
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
    // In-process builder: this file tests the service and routes; the
    // disposable build process has its own process-heavy test.
    build: buildPluginDraft,
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
        // In-process builder: this file tests the service and routes; the
        // disposable build process has its own process-heavy test.
        build: buildPluginDraft,
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

  // S3 review round 2 MEDIUM: a build that never settles (a FIFO input, a
  // wedged esbuild) used to hold a global build slot forever and block
  // release. The service races every build against a deadline.
  test(
    'a build that never settles is stopped at the deadline, frees its slot, and can be released',
    async () => {
      const draftsRoot = join(tempDir('station-draft-home-'), 'plugin-drafts');
      const hung = tempDir('station-draft-hung-');
      const next = tempDir('station-draft-next-');
      writePlugin(hung);
      writePlugin(next);
      const builds: string[] = [];
      let now = Date.now();
      const service = new PluginDraftService({
        draftsRoot,
        emitRebuilt: () => {},
        maxConcurrentBuilds: 1,
        buildTimeoutMs: 200,
        now: () => now,
        pollIntervalMs: 60_000,
        build: async (options) => {
          builds.push(options.pluginDir);
          if (options.pluginDir === hung) return new Promise(() => {});
          return { ok: false, diagnostics: [{ text: 'stub' }] };
        },
      });
      cleanup.push(() => service.dispose());
      service.lease('hung', hung);
      service.lease('next', next);
      await service.idle('hung', hung);
      const stopped = service.status('hung', hung);
      expect(stopped.state).toBe('failed');
      expect(stopped.diagnostics[0].text).toContain('did not finish within');
      // The slot came back: the queued draft built.
      await service.idle('next', next);
      expect(builds).toEqual([hung, next]);
      now += 10 * 60_000;
      service.releaseExpired();
      expect(existsSync(join(draftsRoot, stopped.draftId as string))).toBe(
        false,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a lease with rebuild builds now when no change is observed, and status carries the watcher state',
    async () => {
      // A watcher that arms and never reports anything: the case the manual
      // rebuild exists for.
      const inertWatch = () => ({
        targets: ['.'],
        pollIntervalMs: 2_000,
        status: () => ({
          nativeArmed: true,
          nativeDelivered: false,
          nativeError: null,
          pollingActive: false,
          pollingError: 'more than 2000 entries or 250ms per scan',
          pollingDelivered: false,
        }),
        close: () => {},
      });
      const projectDir = tempDir('station-draft-inert-');
      const emitted: number[] = [];
      const service = new PluginDraftService({
        // In-process builder: this file tests the service and routes; the
        // disposable build process has its own process-heavy test.
        build: buildPluginDraft,
        draftsRoot: join(tempDir('station-draft-home-'), 'plugin-drafts'),
        emitRebuilt: (event) => emitted.push(event.generation),
        watch: inertWatch,
      });
      cleanup.push(() => service.dispose());
      const app = new Hono();
      app.route(
        '/api/projects',
        createPluginDraftRoutes({
          service,
          resolveProjectDirectory: () => projectDir,
        }),
      );
      writePlugin(projectDir, 'first');
      await app.request('/api/projects/demo/plugin-draft/lease', {
        method: 'POST',
      });
      await service.idle('demo', projectDir);
      const first = service.status('demo', projectDir);
      expect(first.generation).toBe(1);
      expect(first.watch).toEqual({
        native: true,
        polling: false,
        reason: 'more than 2000 entries or 250ms per scan',
      });

      writeSource(projectDir, 'second');
      // A plain refresh does not build: nothing reported a change.
      await app.request('/api/projects/demo/plugin-draft/lease', {
        method: 'POST',
      });
      await service.idle('demo', projectDir);
      expect(service.status('demo', projectDir).generation).toBe(1);

      await app.request('/api/projects/demo/plugin-draft/lease', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rebuild: true }),
      });
      await service.idle('demo', projectDir);
      expect(service.status('demo', projectDir).generation).toBe(2);
      expect(emitted).toEqual([1, 2]);
    },
    TEST_TIMEOUT_MS,
  );

  // Round 3 LOW: a forced rebuild is bounded. It is ignored while a build is
  // running or queued, and allowed at most once per 5s.
  test('forced rebuilds are ignored while one is in flight and rate limited', async () => {
    let now = 1_000_000;
    let release: (() => void) | undefined;
    const builds: number[] = [];
    const projectDir = tempDir('station-draft-rate-');
    writePlugin(projectDir);
    const service = new PluginDraftService({
      draftsRoot: join(tempDir('station-draft-home-'), 'plugin-drafts'),
      emitRebuilt: () => {},
      now: () => now,
      watch: () => ({
        targets: ['.'],
        pollIntervalMs: 2_000,
        status: () => ({
          nativeArmed: false,
          nativeDelivered: false,
          nativeError: null,
          pollingActive: false,
          pollingError: null,
          pollingDelivered: false,
        }),
        close: () => {},
      }),
      build: async () => {
        builds.push(now);
        await new Promise<void>((resolvePromise) => {
          release = resolvePromise;
        });
        return { ok: false, diagnostics: [{ text: 'stub' }] };
      },
    });
    cleanup.push(() => service.dispose());
    const waitForBuilds = async (count: number) => {
      const deadline = Date.now() + 5_000;
      while (builds.length < count && Date.now() < deadline)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    };
    service.lease('demo', projectDir);
    await waitForBuilds(1);
    // In flight: ignored, not queued.
    for (let i = 0; i < 5; i += 1)
      service.lease('demo', projectDir, { rebuild: true });
    release?.();
    await service.idle('demo', projectDir);
    expect(builds).toHaveLength(1);

    const settle = async () => {
      await waitForBuilds(builds.length + 1);
      release?.();
      await service.idle('demo', projectDir);
    };
    service.lease('demo', projectDir, { rebuild: true });
    await settle();
    expect(builds).toHaveLength(2);
    // Within the interval: ignored.
    now += 4_999;
    expect(service.lease('demo', projectDir, { rebuild: true }).state).toBe(
      'failed',
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(builds).toHaveLength(2);
    now += 1;
    service.lease('demo', projectDir, { rebuild: true });
    await settle();
    expect(builds).toHaveLength(3);
  });

  // S3 verifier G2: both bundle routes declare their type and forbid
  // sniffing, so a draft's bytes are never reinterpreted as another type.
  test(
    'js and css revisions are served with their type, nosniff and no caching',
    async () => {
      const h = harness();
      writePlugin(h.projectDir);
      writeFileSync(
        join(h.projectDir, 'src', 'style.css'),
        '.pulse{color:red}\n',
      );
      writeFileSync(
        join(h.projectDir, 'src', 'index.tsx'),
        "import './style.css';\nexport const components = { pulse: () => 'css' };\n",
      );
      await h.lease();
      const ready = await h.waitFor((s) => s.state === 'ready');
      expect(ready.hasCss).toBe(true);
      for (const [file, type] of [
        ['bundle.js', 'application/javascript'],
        ['bundle.css', 'text/css'],
      ] as const) {
        const response = await h.app.request(
          `/api/projects/demo/plugin-draft/generations/1/${ready.digest}/${file}`,
        );
        expect(response.status, file).toBe(200);
        expect(response.headers.get('content-type'), file).toContain(type);
        expect(response.headers.get('x-content-type-options'), file).toBe(
          'nosniff',
        );
        expect(response.headers.get('cache-control'), file).toBe(
          'private, no-store',
        );
      }
    },
    TEST_TIMEOUT_MS,
  );

  // S3 verifier G3: one folder under two Project slugs is two drafts.
  test(
    'the same folder leased under two slugs is two independent drafts',
    async () => {
      expect(pluginDraftId('/p', 'a')).not.toBe(pluginDraftId('/p', 'b'));
      const projectDir = tempDir('station-draft-shared-');
      writePlugin(projectDir);
      const closed: string[] = [];
      let now = Date.now();
      const service = new PluginDraftService({
        build: buildPluginDraft,
        draftsRoot: join(tempDir('station-draft-home-'), 'plugin-drafts'),
        emitRebuilt: () => {},
        now: () => now,
        watch: (options) => ({
          targets: ['.'],
          pollIntervalMs: 2_000,
          status: () => ({
            nativeArmed: true,
            nativeDelivered: false,
            nativeError: null,
            pollingActive: true,
            pollingError: null,
            pollingDelivered: false,
          }),
          close: () => closed.push(options.cwd),
        }),
      });
      cleanup.push(() => service.dispose());
      const a = service.lease('alpha', projectDir);
      now += 1_000;
      const b = service.lease('beta', projectDir);
      expect(a.draftId).toBeDefined();
      expect(a.draftId).not.toBe(b.draftId);
      await service.idle('alpha', projectDir);
      await service.idle('beta', projectDir);
      expect(service.status('alpha', projectDir)).toMatchObject({
        projectSlug: 'alpha',
        draftId: a.draftId,
      });
      expect(service.status('beta', projectDir)).toMatchObject({
        projectSlug: 'beta',
        draftId: b.draftId,
      });
      // Expire only alpha's lease: beta keeps watching.
      now += PLUGIN_DRAFT_LEASE_TTL_MS - 500;
      service.releaseExpired();
      expect(service.status('alpha', projectDir).state).toBe('idle');
      expect(service.status('beta', projectDir).state).not.toBe('idle');
      expect(closed).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  // S3 verifier G7: a lease lasts one TTL from its last renewal, exactly.
  test('a renewal extends the lease by exactly one TTL', () => {
    let now = 5_000_000;
    const projectDir = tempDir('station-draft-ttl-');
    const service = new PluginDraftService({
      draftsRoot: join(tempDir('station-draft-home-'), 'plugin-drafts'),
      emitRebuilt: () => {},
      now: () => now,
      build: async () => ({ ok: false, diagnostics: [{ text: 'stub' }] }),
      watch: () => ({
        targets: ['.'],
        pollIntervalMs: 2_000,
        status: () => ({
          nativeArmed: true,
          nativeDelivered: false,
          nativeError: null,
          pollingActive: true,
          pollingError: null,
          pollingDelivered: false,
        }),
        close: () => {},
      }),
    });
    cleanup.push(() => service.dispose());
    const first = service.lease('demo', projectDir);
    expect(first.leaseExpiresAt).toBe(
      new Date(now + PLUGIN_DRAFT_LEASE_TTL_MS).toISOString(),
    );
    now += 10_000;
    const renewed = service.lease('demo', projectDir);
    expect(renewed.leaseExpiresAt).toBe(
      new Date(now + PLUGIN_DRAFT_LEASE_TTL_MS).toISOString(),
    );
    now += PLUGIN_DRAFT_LEASE_TTL_MS - 1;
    service.releaseExpired();
    expect(service.status('demo', projectDir).state).not.toBe('idle');
    now += 1;
    service.releaseExpired();
    expect(service.status('demo', projectDir).state).toBe('idle');
  });

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
