/**
 * @vitest-environment node
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const configFile = fileURLToPath(
  new URL('../../../vite.config.ts', import.meta.url),
);
const sdkAliases = [
  [
    'core-update-restart-status',
    '../../../packages/sdk/src/core-update-restart-status.ts',
  ],
  ['client', '../../../packages/sdk/src/client/index.ts'],
  [
    'project-task-rooms',
    '../../../packages/sdk/src/query-domains/projectTaskRooms.ts',
  ],
  ['live-activity', '../../../packages/sdk/src/live-activity.ts'],
  ['task-tool-results', '../../../packages/sdk/src/task-tool-results.ts'],
  ['workspace-pane', '../../../packages/sdk/src/workspace-pane.ts'],
  [
    'workspace-file-preview',
    '../../../packages/sdk/src/workspace-file-preview.ts',
  ],
  [
    'workspace-browser-preview',
    '../../../packages/sdk/src/workspace-browser-preview.ts',
  ],
  ['spatial-board', '../../../packages/sdk/src/spatial-board.ts'],
  [
    'resource-posture',
    '../../../packages/sdk/src/query-domains/resourcePosture.ts',
  ],
] as const;

let server: ViteDevServer | undefined;
let cacheDir: string | undefined;

beforeAll(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), 'station-vite-sdk-alias-'));
  try {
    server = await createServer({
      configFile,
      logLevel: 'error',
      cacheDir,
      server: { middlewareMode: true },
    });
  } catch (error) {
    rmSync(cacheDir, { recursive: true, force: true });
    cacheDir = undefined;
    throw error;
  }
});

afterAll(async () => {
  try {
    await server?.close();
  } finally {
    server = undefined;
    if (cacheDir) {
      rmSync(cacheDir, { recursive: true, force: true });
      expect(existsSync(cacheDir)).toBe(false);
      cacheDir = undefined;
    }
  }
});

describe('Vite Station SDK aliases', () => {
  test.each(sdkAliases)(
    'resolves the SDK %s subpath before the SDK root alias',
    async (subpath, expectedRelativePath) => {
      const expectedEntry = fileURLToPath(
        new URL(expectedRelativePath, import.meta.url),
      );
      if (!server || !cacheDir) throw new Error('Vite fixture did not start');

      // This preserves the actual Vite resolution boundary without adding
      // optimized-dependency state under the shared repository node_modules.
      expect(server.config.cacheDir).toBe(cacheDir);

      await expect(
        server.pluginContainer.resolveId(`@kontourai/station-sdk/${subpath}`),
      ).resolves.toMatchObject({ id: expectedEntry });
    },
  );
});
