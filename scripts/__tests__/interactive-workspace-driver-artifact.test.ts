import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Browser, chromium } from '@playwright/test';
import { build } from 'esbuild';
import { expect, test } from 'vitest';
import { referenceBrowserProvisioningOwner } from '../../tests/helpers/reference-browser-lifecycle';
import {
  persistRawBridgeEvidence,
  publishPeerPresence,
} from '../interactive-workspace-playwright-adapter.mjs';

// This is an exposed-driver transport fixture, not a product/user journey or a
// reference measurement. It executes the real browser catch and artifact owner.
test('persists closed driver rejection through a real Chromium binding and production bridge', async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-driver-artifact-')),
  );
  let browser: Browser | undefined;
  const failures: unknown[] = [];
  try {
    const bundled = await build({
      entryPoints: [
        resolve(
          'src-ui/src/performance/interactive-workspace-performance-bridge.ts',
        ),
      ],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'performanceBridge',
      define: {
        'import.meta.env.MODE': '"test"',
        'import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE': '"0"',
      },
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(
      `<textarea data-station-performance-surface="task-editor" data-station-task-id="task-fixture" data-station-working-revision="swsr-v1:${'a'.repeat(64)}"></textarea><section data-station-performance-surface="task-room-presence"><header><p role="status">Live room connected.</p></header><button>Join room</button><button>Announce work</button><button>Leave room</button></section>`,
    );
    await page.addScriptTag({ content: bundled.outputFiles[0]!.text });
    let rejection: 'identity' | 'wire' | 'join' = 'identity';
    const commandPage = await browser.newPage();
    await commandPage.setContent(await page.content());
    let joinRefusal = 'rate_limited';
    let refusedCommand = 'join';
    const requests: string[] = [];
    let announceRequests = 0;
    await commandPage.route(
      'http://fixture.invalid/room/live',
      async (route) => {
        const command = route.request().postDataJSON().command;
        requests.push(command);
        if (command === 'announce') announceRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({
            success: true,
            data: {
              kind: 'available',
              result: {
                outcome:
                  command === refusedCommand
                    ? joinRefusal
                    : command === 'join'
                      ? 'joined'
                      : 'updated',
              },
            },
          }),
        });
      },
    );
    let message = '';
    let invocations = 0;
    await page.exposeBinding(
      '__stationInteractiveWorkspacePerformanceDriver',
      async () => {
        invocations += 1;
        if (rejection === 'wire') throw new Error(message);
        if (rejection === 'join')
          return publishPeerPresence(
            {
              url: () => 'http://fixture.invalid/tasks/task-fixture',
              waitForFunction: commandPage.waitForFunction.bind(commandPage),
              evaluate: commandPage.evaluate.bind(commandPage),
              getByRole: commandPage.getByRole.bind(commandPage),
              waitForResponse: commandPage.waitForResponse.bind(commandPage),
            },
            page,
            14,
            'http://fixture.invalid/tasks/task-fixture',
            'task-fixture',
          );
        // Fault at the exact identity wait; the real producer wraps the failure,
        // observes this real DOM, and rejects across Playwright's actual binding.
        const peer = {
          url: () => 'http://fixture.invalid/tasks/task-fixture',
          waitForFunction: async () => {
            throw new Error('private-token https://private.invalid/actor');
          },
          evaluate: page.evaluate.bind(page),
        };
        return publishPeerPresence(
          peer,
          page,
          7,
          'http://fixture.invalid/tasks/task-fixture',
          'task-fixture',
        );
      },
    );
    const measure = () =>
      page.evaluate(
        `performanceBridge.measureInteractiveWorkspace({sampling:{warmups:0,samples:1},fixtureCorpus:{id:'corpus',sha256:'${'a'.repeat(64)}'},fixtures:[{id:'synthetic-collaboration',workloads:[],measurementPhases:{}}]},'task-fixture')`,
      );
    const artifact = join(root, 'raw-bridge.json');
    persistRawBridgeEvidence(artifact, await measure());
    const read = () =>
      JSON.parse(readFileSync(artifact, 'utf8')).observations[0];
    expect(invocations).toBe(1);
    expect(read()).toMatchObject({
      status: 'NOT_VERIFIED',
      counts: { failures: 1 },
      driverFailure: {
        version: 1,
        stage: 'identity',
        iteration: 7,
        command: null,
        joinOutcome: 'NOT_OBSERVED',
        stream: 'LIVE',
        join: 'ENABLED',
        announce: 'ENABLED',
        dialog: 'NONE',
        telemetry: 'NONE',
      },
      reasonCodes: expect.arrayContaining([
        'PRODUCT_COLLABORATION_PRESENCE_IDENTITY_FAILED',
      ]),
    });
    expect(readFileSync(artifact, 'utf8')).not.toMatch(
      /private-token|private\.invalid|task-fixture/,
    );
    rejection = 'join';
    await commandPage.evaluate(`(() => {
      document
        .querySelector('section')
        .setAttribute('data-viewer-actor-id', 'fixture-peer');
      for (const button of document.querySelectorAll('button')) {
        const command = button.textContent === 'Join room' ? 'join' : button.textContent === 'Leave room' ? 'depart' : 'announce';
        button.disabled = command !== 'join';
        button.addEventListener('click', () => {
          void fetch('http://fixture.invalid/room/live', {
            method: 'POST',
            body: JSON.stringify({ command }),
          });
        });
      }
    })()`);

    for (const outcome of [
      'invalid',
      'forbidden',
      'identity_changed',
      'capacity_exceeded',
      'rate_limited',
      'degraded',
      'unavailable',
    ]) {
      joinRefusal = outcome;
      persistRawBridgeEvidence(artifact, await measure());
      expect(read()).toMatchObject({
        status: 'NOT_VERIFIED',
        driverFailure: {
          stage: 'join',
          iteration: 14,
          joinOutcome: outcome.toUpperCase(),
          command: `Live command Join room status 200 outcome ${outcome.toUpperCase()}`,
          stream: 'LIVE',
          join: 'ENABLED',
          announce: 'DISABLED',
        },
      });
      expect(announceRequests).toBe(0);
    }
    for (const [command, stage, label] of [
      ['depart', 'leave', 'Leave room'],
      ['announce', 'announce', 'Announce work'],
    ]) {
      refusedCommand = command!;
      await commandPage.evaluate(
        command === 'depart'
          ? "document.querySelectorAll('button').forEach(button => { button.disabled = false; })"
          : "document.querySelectorAll('button').forEach(button => { button.disabled = button.textContent === 'Leave room'; })",
      );
      expect(
        await commandPage.getByRole('button', { name: label }).isEnabled(),
      ).toBe(true);
      for (const outcome of [
        'invalid',
        'forbidden',
        'identity_changed',
        'capacity_exceeded',
        'rate_limited',
        'degraded',
        'unavailable',
      ]) {
        joinRefusal = outcome;
        requests.length = 0;
        persistRawBridgeEvidence(artifact, await measure());
        expect(read().driverFailure).toMatchObject({
          stage,
          iteration: 14,
          command: `Live command ${label} status 200 outcome ${outcome.toUpperCase()}`,
        });
        expect(requests).toEqual(
          command === 'depart' ? ['depart'] : ['join', 'announce'],
        );
      }
    }
    rejection = 'wire';
    for (const stage of [
      'navigation-context',
      'task-context',
      'leave-state',
      'ingress-clock',
      'send-clock',
      'announce',
    ]) {
      message = `Collaboration presence ${stage} failed; iteration=209; joinOutcome=JOINED; stream=TERMINAL; join=DISABLED; announce=DISABLED; dialog=VISIBLE; telemetry=UNKNOWN`;
      persistRawBridgeEvidence(artifact, await measure());
      expect(read().driverFailure).toMatchObject({
        stage,
        iteration: 209,
        joinOutcome: 'JOINED',
        stream: 'TERMINAL',
      });
      expect(read().status).toBe('NOT_VERIFIED');
    }
    const valid = message;
    for (const invalid of [
      `${valid}; secret=private-token`,
      valid.replace('209', '210'),
      valid.replace('TERMINAL', 'https://private.invalid'),
      'private-token',
      'x'.repeat(769),
    ]) {
      message = invalid;
      persistRawBridgeEvidence(artifact, await measure());
      expect(read().driverFailure).toBeUndefined();
      expect(read().status).toBe('NOT_VERIFIED');
      expect(readFileSync(artifact, 'utf8')).not.toMatch(
        /private-token|private\.invalid/,
      );
    }
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await browser?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  // Setup/assertion failure remains primary; cleanup still runs independently.
  if (failures.length) throw failures[0];
}, 30_000);

// Real transport/lifetime fixture: closing the seed context must stop its SSE
// observer and heartbeat traffic before the two measured viewers begin.
test('retires provisioning browser traffic before admitting two measured viewers', async () => {
  const streams = new Set<string>();
  const heartbeats = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const viewer = url.searchParams.get('viewer') ?? '';
    if (!['seed', 'owner', 'peer'].includes(viewer)) {
      response.writeHead(404).end();
      return;
    }
    if (url.pathname === '/events') {
      streams.add(viewer);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      response.write('data: connected\n\n');
      response.on('close', () => streams.delete(viewer));
    } else if (url.pathname === '/heartbeat') {
      heartbeats.set(viewer, (heartbeats.get(viewer) ?? 0) + 1);
      response.writeHead(204).end();
    } else if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<script>
        const viewer = new URL(location.href).searchParams.get('viewer');
        new EventSource('/events?viewer=' + encodeURIComponent(viewer));
        setInterval(() => fetch('/heartbeat?viewer=' + encodeURIComponent(viewer)), 25);
      </script>`);
    } else response.writeHead(404).end();
  });
  let browser: Browser | undefined;
  const failures: unknown[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No fixture listener');
    const target = `http://127.0.0.1:${address.port}/`;
    browser = await chromium.launch({ headless: true });
    const seed = await browser.newContext();
    const seedPage = await seed.newPage();
    await seedPage.goto(`${target}?viewer=seed`);
    await expect.poll(() => heartbeats.get('seed') ?? 0).toBeGreaterThan(0);
    expect(streams.has('seed')).toBe(true);
    let releases = 0;
    const owner = referenceBrowserProvisioningOwner(seed, async () => {
      releases += 1;
    });
    await owner.run(async () => {
      expect(seedPage.isClosed()).toBe(true);
      await expect.poll(() => streams.has('seed')).toBe(false);
      const seedCount = heartbeats.get('seed');
      for (const viewer of ['owner', 'peer']) {
        const context = await browser!.newContext();
        await (await context.newPage()).goto(`${target}?viewer=${viewer}`);
      }
      await expect.poll(() => [...streams].sort()).toEqual(['owner', 'peer']);
      await expect.poll(() => heartbeats.get('peer') ?? 0).toBeGreaterThan(1);
      expect(heartbeats.get('seed')).toBe(seedCount);
      expect(browser!.contexts()).toHaveLength(2);
    });
    await owner.close();
    expect(releases).toBe(1);
    const failedContext = await browser.newContext();
    const failedPage = await failedContext.newPage();
    const primary = new Error('fixture handler cleanup failed');
    const refusedOwner = referenceBrowserProvisioningOwner(
      failedContext,
      async () => {
        throw primary;
      },
    );
    let admitted = false;
    await expect(
      refusedOwner.run(async () => {
        admitted = true;
      }),
    ).rejects.toBe(primary);
    expect(failedPage.isClosed()).toBe(true);
    expect(admitted).toBe(false);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await browser?.close();
    } catch (error) {
      failures.push(error);
    }
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (failures.length) throw failures[0];
}, 30_000);
