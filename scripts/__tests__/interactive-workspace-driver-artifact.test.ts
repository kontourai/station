import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Browser, chromium } from '@playwright/test';
import { build } from 'esbuild';
import { expect, test } from 'vitest';
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
    let announceRequests = 0;
    await commandPage.route(
      'http://fixture.invalid/room/live',
      async (route) => {
        if (route.request().postDataJSON().command === 'announce')
          announceRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({
            success: true,
            data: { kind: 'available', result: { outcome: joinRefusal } },
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
        const command =
          button.textContent === 'Join room' ? 'join' : 'announce';
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
