import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writePlugin(directory: string, name: string, commandId: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'plugin.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      extensions: {
        'io.kontourai.station': {
          commands: [
            {
              version: '1.0',
              id: commandId,
              title: 'Open plugins',
              intent: { kind: 'navigate', surfaceId: 'plugins' },
            },
          ],
        },
      },
    }),
  );
}

describe('installed plugin inventory route', () => {
  test('never projects preview or mismatched staging manifests as installed commands', async () => {
    const projectHomeDir = mkdtempSync(
      join(tmpdir(), 'plugin-installed-inventory-'),
    );
    roots.push(projectHomeDir);
    const pluginsDir = join(projectHomeDir, 'plugins');
    const agentsDir = join(projectHomeDir, 'agents');
    writePlugin(
      join(pluginsDir, 'installed-plugin'),
      'installed-plugin',
      'installed-plugin.open-plugins',
    );
    writePlugin(
      join(pluginsDir, '.preview-unapproved-deadbeef'),
      'unapproved-plugin',
      'unapproved-plugin.open-plugins',
    );
    writePlugin(
      join(pluginsDir, 'wrong-directory'),
      'other-plugin',
      'other-plugin.open-plugins',
    );
    const app = new Hono();
    registerPluginInstallRoutes(app, {
      agentsDir,
      pluginsDir,
      projectHomeDir,
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      } as never,
    });

    const response = await app.request('/');
    const body = (await readJson(response)) as {
      plugins: Array<{
        name: string;
        commandGeneration: string;
        commandContributions: Array<{ id: string }>;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.plugins).toEqual([
      expect.objectContaining({
        name: 'installed-plugin',
        commandGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
        commandContributions: [
          {
            version: '1.0',
            id: 'installed-plugin.open-plugins',
            title: 'Open plugins',
            intent: { kind: 'navigate', surfaceId: 'plugins' },
          },
        ],
      }),
    ]);
  });
});
