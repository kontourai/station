// @vitest-environment node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ToolServerCredentialStore,
  toolServerCredentialStoreMutationLockPath,
} from '../../services/plugins/tool-server-credential-store.js';
import {
  loadIntegrationConfig,
  saveIntegrationConfig,
} from '../config-loader-storage.js';
import { mutateJsonFile, readJsonFile } from '../file-storage-helpers.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('integration configuration cross-process mutation', () => {
  test('a synchronous child holder does not block generic JSON RMW and both process updates survive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-json-process-'));
    roots.push(root);
    const path = join(root, 'state.json');
    await mutateJsonFile(path, {}, (current) => ({ ...current, seed: true }));
    const lifecycleUrl = new URL(
      '../../../packages/shared/src/lifecycle-events.ts',
      import.meta.url,
    ).href;
    const storageUrl = new URL('../file-storage-helpers.ts', import.meta.url)
      .href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import { acquireFileMutationLock } from ${JSON.stringify(lifecycleUrl)};
         import { mutateJsonFile } from ${JSON.stringify(storageUrl)};
         const path = process.argv[1];
         const release = acquireFileMutationLock(path + '.mutation');
         process.stdout.write('locked\\n');
         setTimeout(async () => {
           try {
             release();
             await mutateJsonFile(path, {}, (current) => ({ ...current, child: true }));
             process.exit(0);
           } catch (error) {
             process.stderr.write(String(error));
             process.exit(2);
           }
         }, 250);`,
        path,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    await once(child.stdout!, 'data');

    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      const mutation = mutateJsonFile(path, {}, (current) => ({
        ...current,
        parent: true,
      }));
      const [code] = await once(child, 'exit');
      expect(code).toBe(0);
      await mutation;
    } finally {
      clearInterval(ticker);
      if (child.exitCode === null) child.kill('SIGKILL');
    }

    expect(ticks).toBeGreaterThanOrEqual(5);
    expect(readJsonFile(path, {})).toEqual({
      seed: true,
      child: true,
      parent: true,
    });
  });

  test('a synchronous child holder does not block credential RMW and both process updates survive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-credential-process-'));
    roots.push(root);
    const store = new ToolServerCredentialStore(root);
    await store.upsert('shared', 'SEED', 'seed');
    const lifecycleUrl = new URL(
      '../../../packages/shared/src/lifecycle-events.ts',
      import.meta.url,
    ).href;
    const credentialStoreUrl = new URL(
      '../../services/plugins/tool-server-credential-store.ts',
      import.meta.url,
    ).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import { acquireFileMutationLock } from ${JSON.stringify(lifecycleUrl)};
         import { ToolServerCredentialStore, toolServerCredentialStoreMutationLockPath } from ${JSON.stringify(credentialStoreUrl)};
         const root = process.argv[1];
         const release = acquireFileMutationLock(toolServerCredentialStoreMutationLockPath(root));
         process.stdout.write('locked\\n');
         setTimeout(async () => {
           try {
             release();
             await new ToolServerCredentialStore(root).upsert('shared', 'CHILD', 'child');
             process.exit(0);
           } catch (error) {
             process.stderr.write(String(error));
             process.exit(2);
           }
         }, 250);`,
        root,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    await once(child.stdout!, 'data');

    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      const mutation = store.upsert('shared', 'PARENT', 'parent');
      const [code] = await once(child, 'exit');
      expect(code).toBe(0);
      await mutation;
    } finally {
      clearInterval(ticker);
      if (child.exitCode === null) child.kill('SIGKILL');
    }

    expect(ticks).toBeGreaterThanOrEqual(5);
    expect(store.get('shared', 'SEED')).toBe('seed');
    expect(store.get('shared', 'CHILD')).toBe('child');
    expect(store.get('shared', 'PARENT')).toBe('parent');
    expect(toolServerCredentialStoreMutationLockPath(root)).toContain(
      'tool-server-credentials.json.mutation',
    );
  });

  test('a synchronous CLI holder does not block the server event loop and both updates survive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-integration-process-'));
    roots.push(root);
    const lifecycleUrl = new URL(
      '../../../packages/shared/src/lifecycle-events.ts',
      import.meta.url,
    ).href;
    const portabilityUrl = new URL(
      '../../../packages/cli/src/commands/portability-io.ts',
      import.meta.url,
    ).href;
    const credentialStoreUrl = new URL(
      '../../services/plugins/tool-server-credential-store.ts',
      import.meta.url,
    ).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import { acquireFileMutationLock } from ${JSON.stringify(lifecycleUrl)};
         import { mkdirSync } from 'node:fs';
         import { writeIntegration } from ${JSON.stringify(portabilityUrl)};
         import { toolServerIntegrationMutationLockPath } from ${JSON.stringify(credentialStoreUrl)};
         const root = process.argv[1];
         const id = 'merge-cli-ui';
         mkdirSync(root + '/integrations', { recursive: true });
         const release = acquireFileMutationLock(toolServerIntegrationMutationLockPath(root, id));
         process.stdout.write('locked\\n');
         setTimeout(async () => {
           try {
             release();
             await writeIntegration(id, { id, kind: 'mcp', env: { CLI_TOKEN: 'cli' } }, root);
             process.exit(0);
           } catch (error) {
             process.stderr.write(String(error));
             process.exit(2);
           }
         }, 250);`,
        root,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    await once(child.stdout!, 'data');

    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      const save = saveIntegrationConfig(root, 'merge-cli-ui', {
        id: 'merge-cli-ui',
        kind: 'mcp',
        secretEnv: { UI_TOKEN: 'ui' },
      });
      const [code] = await once(child, 'exit');
      expect(code).toBe(0);
      await save;
    } finally {
      clearInterval(ticker);
      if (child.exitCode === null) child.kill('SIGKILL');
    }

    expect(ticks).toBeGreaterThanOrEqual(5);
    expect((await loadIntegrationConfig(root, 'merge-cli-ui')).env).toEqual({
      CLI_TOKEN: 'cli',
      UI_TOKEN: 'ui',
    });
  });
});
