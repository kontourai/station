import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { bodyRef, encode } from '../encoding.js';
import { DEFAULT_MODEL_POLICY } from '../index.js';
import { openSqliteRuntimeBodies } from '../sqlite.js';

const children = new Set<ChildProcess>();
const temporary: ReturnType<typeof mkdtempDisposableSync>[] = [];
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((r) => child.once('exit', () => r()));
    }
  }
  children.clear();
  for (const t of temporary.splice(0)) t.remove();
});
for (const phase of ['before-commit', 'after-commit'])
  it(`actual SIGKILL ${phase} preserves the real SQLite body commit boundary`, async () => {
    const directory = mkdtempDisposableSync(join(tmpdir(), 'runtime-process-'));
    temporary.push(directory);
    const path = join(directory.path, 'host.sqlite');
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve(import.meta.dirname, 'body-process.fixture.ts'),
        path,
        phase,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    children.add(child);
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 65536) child.kill('SIGKILL');
    });
    const message = await new Promise<unknown>((resolveMessage, reject) => {
      child.once('message', resolveMessage);
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        reject(
          Error(`Child exited before boundary ${code}/${signal}: ${stderr}`),
        ),
      );
    });
    expect(z.object({ phase: z.string() }).parse(message).phase).toBe(phase);
    const exited = new Promise<void>((r, j) =>
      child.once('exit', (_code, signal) =>
        signal === 'SIGKILL' ? r() : j(Error(`Expected SIGKILL: ${signal}`)),
      ),
    );
    child.kill('SIGKILL');
    await exited;
    const database = new DatabaseSync(path);
    try {
      database.exec('PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;');
      const bodies = openSqliteRuntimeBodies({
        database,
        policy: DEFAULT_MODEL_POLICY,
      });
      if (phase === 'after-commit') {
        const ref = z.object({ ref: bodyRef }).parse(message).ref;
        expect(await bodies.read(ref)).toEqual(
          encode({ type: 'text-delta', id: 'a', delta: 'PROCESS-DURABLE' }),
        );
      } else
        expect(
          database
            .prepare('SELECT count(*) AS n FROM agent_runtime_bodies')
            .get()?.n,
        ).toBe(0);
      await bodies.close();
    } finally {
      database.close();
    }
  });
