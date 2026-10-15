// @vitest-environment node

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ToolServerCredentialStore,
  toolServerCredentialStoreMutationLockPath,
  toolServerIntegrationMutationLockPath,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

interface ContendedMutation {
  testBudgetMs: number;
  imports: string;
  lock: string;
  childMutation: string;
  parentMutation: () => Promise<unknown>;
}

async function runContendedMutation({
  testBudgetMs,
  imports,
  lock,
  childMutation,
  parentMutation,
}: ContendedMutation): Promise<void> {
  // Worker setup clears the runner's scaling environment; its configured
  // test budget retains the resolved host-pressure allowance.
  const readyBudgetMs = Math.floor(testBudgetMs / 3);
  // Once contention exists, release before the production 10-second lock
  // deadline even when the outer test budget permits a longer wait.
  const progressBudgetMs = Math.min(5_000, Math.floor(testBudgetMs / 30));
  const lifecycleUrl = new URL(
    '../../../packages/shared/src/lifecycle-events.ts',
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
       import { readdirSync, readFileSync } from 'node:fs';
       import { basename, dirname, join } from 'node:path';
       ${imports}
       const lock = process.argv[1];
       const watchdogMs = Number(process.argv[2]);
       const progressWatchdogMs = Number(process.argv[3]);
       let release;
       let poll;
       let watchdog;
       let finishing = false;
       let challenged = false;
       async function finish(reason) {
         if (finishing) return;
         finishing = true;
         clearInterval(poll);
         clearTimeout(watchdog);
         try {
           process.send({ type: 'released', reason });
           release();
           ${childMutation}
           process.exit(0);
         } catch (error) {
           process.stderr.write(String(error));
           process.exit(2);
         }
       }
       try {
         release = acquireFileMutationLock(lock);
         // This guard bounds fixture failure, not the production lock deadline.
         watchdog = setTimeout(() => void finish('watchdog'), watchdogMs);
         process.on('disconnect', () => {
           release();
           process.exit(2);
         });
         process.on('message', (message) => {
           if (message === 'progress' && challenged) void finish('progress');
         });
         poll = setInterval(() => {
           if (challenged) return;
           try {
             // A real waiting claim establishes contention before asking the
             // parent to service IPC. The holder's own claim is already gone.
             for (const name of readdirSync(dirname(lock))) {
               if (!name.startsWith(basename(lock) + '.') || !name.endsWith('.tmp')) continue;
               let owner;
               try {
                 owner = JSON.parse(readFileSync(join(dirname(lock), name), 'utf8'));
               } catch (error) {
                 if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
                 throw error;
               }
               if (owner.pid !== process.ppid) continue;
               challenged = true;
               clearTimeout(watchdog);
               watchdog = setTimeout(() => void finish('watchdog'), progressWatchdogMs);
               process.send({ type: 'contended' });
               break;
             }
           } catch (error) {
             process.stderr.write(String(error));
             process.exit(2);
           }
         }, 10);
         process.send({ type: 'locked' });
       } catch (error) {
         process.stderr.write(String(error));
         process.exit(2);
       }`,
      lock,
      String(readyBudgetMs),
      String(progressBudgetMs),
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true },
  );
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-8_192);
  });
  let releaseReason: unknown;
  let progressed = false;
  let mutationSettled = false;
  let mutation: Promise<unknown> | undefined;
  let progress: NodeJS.Immediate | undefined;
  let progressError: Error | null = null;
  const closed = deferred<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  const ready = deferred<void>();
  const failed = deferred<never>();
  let locked = false;
  child.once('error', failed.reject);
  child.once('close', (code, signal) => {
    if (!locked) {
      failed.reject(
        new Error(
          `lock holder exited code=${code} signal=${signal} ready=${locked}: ${stderr}`,
        ),
      );
    }
    closed.resolve({ code, signal });
  });
  const guard = setTimeout(
    () => failed.reject(new Error('lock holder handshake did not complete')),
    Math.floor((testBudgetMs * 2) / 3),
  );
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      failed.reject(new Error('invalid lock holder message'));
      return;
    }
    if (message.type === 'locked') {
      locked = true;
      ready.resolve();
    } else if (message.type === 'contended') {
      progress = setImmediate(() => {
        if (releaseReason !== undefined) return;
        if (mutationSettled) {
          failed.reject(
            new Error('parent mutation completed before the holder released'),
          );
          return;
        }
        progressed = true;
        child.send('progress', (error) => {
          if (error) progressError = error;
        });
      });
    } else if (message.type === 'released' && 'reason' in message) {
      releaseReason = message.reason;
    } else {
      failed.reject(new Error('unexpected lock holder message'));
    }
  });
  try {
    await Promise.race([ready.promise, failed.promise]);
    mutation = parentMutation().finally(() => {
      mutationSettled = true;
    });
    // Observe rejection immediately, but report the holder's causal release
    // result before any secondary mutation error from the negative control.
    void mutation.catch(() => {});
    const result = await Promise.race([closed.promise, failed.promise]);
    if (result.code !== 0 || result.signal) {
      throw new Error(
        `lock holder exited code=${result.code} signal=${result.signal}: ${stderr}`,
      );
    }
    expect(
      releaseReason,
      'parent must service the held-lock challenge before watchdog release',
    ).toBe('progress');
    expect(
      progressed,
      'parent event-loop progress while its mutation was contending',
    ).toBe(true);
    if (progressError) throw progressError;
    await mutation;
  } finally {
    clearTimeout(guard);
    clearImmediate(progress);
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await closed.promise;
    // Drain an already-started operation before afterEach removes its root.
    await mutation?.catch(() => {});
  }
}

describe('integration configuration cross-process mutation', () => {
  test('a synchronous child holder does not block generic JSON RMW and both process updates survive', async ({
    task,
  }) => {
    const root = mkdtempSync(join(tmpdir(), 'station-json-process-'));
    roots.push(root);
    const path = join(root, 'state.json');
    await mutateJsonFile(path, {}, (current) => ({ ...current, seed: true }));
    const storageUrl = new URL('../file-storage-helpers.ts', import.meta.url)
      .href;
    await runContendedMutation({
      testBudgetMs: task.timeout,
      imports: `import { mutateJsonFile } from ${JSON.stringify(storageUrl)};`,
      lock: `${path}.mutation`,
      childMutation: `await mutateJsonFile(${JSON.stringify(path)}, {}, (current) => ({ ...current, child: true }));`,
      parentMutation: () =>
        mutateJsonFile(path, {}, (current) => ({
          ...current,
          parent: true,
        })),
    });
    expect(readJsonFile(path, {})).toEqual({
      seed: true,
      child: true,
      parent: true,
    });
  });

  test('a synchronous child holder does not block credential RMW and both process updates survive', async ({
    task,
  }) => {
    const root = mkdtempSync(join(tmpdir(), 'station-credential-process-'));
    roots.push(root);
    const store = new ToolServerCredentialStore(root);
    await store.upsert('shared', 'SEED', 'seed');
    const credentialStoreUrl = new URL(
      '../../services/plugins/tool-server-credential-store.ts',
      import.meta.url,
    ).href;
    await runContendedMutation({
      testBudgetMs: task.timeout,
      imports: `import { ToolServerCredentialStore } from ${JSON.stringify(credentialStoreUrl)};`,
      lock: toolServerCredentialStoreMutationLockPath(root),
      childMutation: `await new ToolServerCredentialStore(${JSON.stringify(root)}).upsert('shared', 'CHILD', 'child');`,
      parentMutation: () => store.upsert('shared', 'PARENT', 'parent'),
    });
    expect(store.get('shared', 'SEED')).toBe('seed');
    expect(store.get('shared', 'CHILD')).toBe('child');
    expect(store.get('shared', 'PARENT')).toBe('parent');
    expect(toolServerCredentialStoreMutationLockPath(root)).toContain(
      'tool-server-credentials.json.mutation',
    );
  });

  test('a synchronous CLI holder does not block the server event loop and both updates survive', async ({
    task,
  }) => {
    const root = mkdtempSync(join(tmpdir(), 'station-integration-process-'));
    roots.push(root);
    const portabilityUrl = new URL(
      '../../../packages/cli/src/commands/portability-io.ts',
      import.meta.url,
    ).href;
    mkdirSync(join(root, 'integrations'), { recursive: true });
    await runContendedMutation({
      testBudgetMs: task.timeout,
      imports: `import { writeIntegration } from ${JSON.stringify(portabilityUrl)};`,
      lock: toolServerIntegrationMutationLockPath(root, 'merge-cli-ui'),
      childMutation: `await writeIntegration('merge-cli-ui', { id: 'merge-cli-ui', kind: 'mcp', env: { CLI_TOKEN: 'cli' } }, ${JSON.stringify(root)});`,
      parentMutation: () =>
        saveIntegrationConfig(root, 'merge-cli-ui', {
          id: 'merge-cli-ui',
          kind: 'mcp',
          secretEnv: { UI_TOKEN: 'ui' },
        }),
    });
    expect((await loadIntegrationConfig(root, 'merge-cli-ui')).env).toEqual({
      CLI_TOKEN: 'cli',
      UI_TOKEN: 'ui',
    });
  });
});
