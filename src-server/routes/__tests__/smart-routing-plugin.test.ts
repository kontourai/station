import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { routingDecision } from '../../telemetry/metrics.js';
import { registerPluginPublicRoutes } from '../plugins/plugin-public-routes.js';

vi.mock('../../telemetry/metrics.js', () => ({
  pluginServerRequestDuration: { record: vi.fn() },
  pluginServerRequests: { add: vi.fn() },
  routingDecision: { add: vi.fn() },
}));

const cleanupDirs: string[] = [];
const exampleDir = fileURLToPath(
  new URL('../../../examples/smart-routing/', import.meta.url),
);

beforeEach(() => {
  vi.mocked(routingDecision.add).mockClear();
});

afterEach(async () => {
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function writePluginFile(pluginDir: string, fileName: string): void {
  const target = join(pluginDir, fileName);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(join(exampleDir, fileName), 'utf-8'));
}

function createSmartRoutingApp() {
  const root = mkdtempSync(join(tmpdir(), 'station-smart-routing-'));
  cleanupDirs.push(root);
  const pluginDir = join(root, 'plugins', 'smart-routing');
  writePluginFile(pluginDir, 'plugin.json');
  writePluginFile(pluginDir, 'plugin.mjs');
  writeFileSync(
    join(root, 'plugin-grants.json'),
    JSON.stringify({ 'smart-routing': ['plugin.server'] }, null, 2),
  );

  const app = new Hono();
  registerPluginPublicRoutes(app, {
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as any,
    pluginsDir: join(root, 'plugins'),
    projectHomeDir: root,
  });
  return app;
}

async function decide(promptBody: Record<string, unknown>) {
  const app = createSmartRoutingApp();
  const response = await app.request('/smart-routing/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(promptBody),
  });
  return {
    body: await response.json(),
    status: response.status,
  };
}

describe('smart-routing example plugin', () => {
  test('routes short simple prompts to the cheap tier', async () => {
    const { body, status } = await decide({
      prompt: 'Summarize this note quickly.',
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      fallbackUsed: false,
      modelTier: 'cheap',
      reason: 'budget-intent',
      signals: {
        hasCodeBlock: false,
        hasComplexIntent: false,
        hasLongContext: false,
      },
    });
  });

  test('routes complex prompts to the strong tier', async () => {
    const { body, status } = await decide({
      prompt:
        'Diagnose this TypeScript migration and produce an architecture test plan for backward compatibility.',
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      fallbackUsed: false,
      modelTier: 'strong',
      reason: 'complexity-signals',
      signals: {
        hasComplexIntent: true,
      },
    });
  });

  test('falls back to the default tier without routable input', async () => {
    const { body, status } = await decide({});

    expect(status).toBe(200);
    expect(body).toMatchObject({
      fallbackUsed: true,
      modelTier: 'default',
      reason: 'no-routable-input',
      signals: {
        charCount: 0,
        wordCount: 0,
      },
    });
  });

  test('records routing-decision telemetry for each decision', async () => {
    await decide({
      prompt: 'Debug the production performance regression.',
    });

    expect(routingDecision.add).toHaveBeenCalledWith(1, {
      fallbackUsed: false,
      modelTier: 'strong',
      plugin: 'smart-routing',
      reason: 'complexity-signals',
    });
  });
});
