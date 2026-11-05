import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAgentRuntime,
  durableLanguageModel,
  openSqliteAgentJournal,
  runWithAgentTurn,
} from '../index.js';
import { readAgentWire, readSqliteAgentFrames } from '../internal.js';

const children = new Set<ChildProcess>();
const temporary: ReturnType<typeof mkdtempDisposableSync>[] = [];
afterEach(async () => {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  children.clear();
  for (const directory of temporary.splice(0)) directory.remove();
});
it.each([5, 130, 300, 389, 1300])(
  'SIGKILL after %i displayed deltas restores an exact committed prefix without model redispatch',
  async (threshold) => {
    const directory = mkdtempDisposableSync(
      join(tmpdir(), 'agent-prefix-process-'),
    );
    temporary.push(directory);
    const path = join(directory.path, 'journal.sqlite');
    const spawnStart = performance.now();
    let killStart = 0;
    let readyAt = 0;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve(import.meta.dirname, 'turn-prefix-process.fixture.ts'),
        path,
        String(threshold > 400 ? 1600 : 400),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    children.add(child);
    let stderr = '';
    child.stderr?.on('data', (value) => {
      stderr = (stderr + value.toString()).slice(-65536);
    });
    const visible: string[] = [];
    await new Promise<void>((resolveExit, reject) => {
      child.once('error', reject);
      child.on('message', (raw) => {
        try {
          if (
            z
              .object({ kind: z.literal('ready') })
              .strict()
              .safeParse(raw).success
          ) {
            readyAt = performance.now();
            return;
          }
          const batch = z
            .array(
              z.object({ index: z.number().int(), delta: z.string() }).strict(),
            )
            .min(1)
            .max(50)
            .parse(raw);
          for (const message of batch) {
            expect(message.index).toBe(visible.length);
            visible.push(message.delta);
          }
          expect(visible.length).toBeLessThanOrEqual(threshold);
          if (visible.length === threshold) {
            killStart = performance.now();
            child.kill('SIGKILL');
          } else child.send('next');
        } catch (error) {
          reject(error);
        }
      });
      child.once('exit', (_code, signal) =>
        signal === 'SIGKILL' && visible.length === threshold
          ? resolveExit()
          : reject(new Error(`Unexpected child exit ${signal}: ${stderr}`)),
      );
    });
    const killed = performance.now();
    const database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    const journal = openSqliteAgentJournal({ database });
    const reopened = performance.now();
    try {
      const runtime = createAgentRuntime({
        journal,
        owner: {
          id: 'successor',
          pid: process.pid,
          birth: 'successor',
          identityKind: 'exact',
        },
        liveness: (owner) => (owner.id === 'child' ? 'dead' : 'live'),
        implementation: 'prefix/1',
      });
      const lease = await runtime.recover({
        scopeId: 'prefix',
        conversationId: 'conversation',
        invocationId: 'turn',
      });
      if (typeof lease === 'string')
        throw new Error(`Recovery refused: ${lease}`);
      const recovered = performance.now();
      const { effect } = await lease.effect({
        type: 'effectRead',
        id: 'model:0',
      });
      expect(effect.state).toBe('indeterminate');
      expect(effect.attempts).toHaveLength(1);
      const prefix = effect.attempts[0]!.partials.map(
        (wire) =>
          z
            .object({
              type: z.literal('text-delta'),
              id: z.string(),
              delta: z.string(),
            })
            .parse(readAgentWire(wire)).delta,
      );
      expect(prefix.length).toBeGreaterThanOrEqual(visible.length);
      expect(prefix).toEqual(
        Array.from({ length: prefix.length }, (_, i) =>
          String(i).padStart(4, '0'),
        ),
      );
      expect(prefix.slice(0, visible.length)).toEqual(visible);
      const frames = readSqliteAgentFrames({ database, key: lease.key });
      expect(
        frames.map(({ id, position, wire }) => ({ id, position, wire })),
      ).toEqual(
        visible.flatMap((delta, index) => [
          {
            id: `answer:${index}`,
            position: 2 * index,
            wire: `data: ${JSON.stringify({ type: 'text-delta', id: 'answer', delta })}\n\n`,
          },
          {
            id: `control:${index}`,
            position: 2 * index + 1,
            wire: 'data: {"type":"checkpoint"}\n\n',
          },
        ]),
      );
      let calls = 0;
      const model = durableLanguageModel({
        specificationVersion: 'v3',
        provider: 'scripted',
        modelId: 'prefix',
        supportedUrls: {},
        doGenerate: async () => {
          throw new Error('stream required');
        },
        doStream: async () => {
          calls++;
          throw new Error('must never redispatch');
        },
      });
      await expect(
        runWithAgentTurn(lease, () => model.doStream({ prompt: [] })),
      ).rejects.toThrow('MODEL_INDETERMINATE');
      expect(calls).toBe(0);
      process.stderr.write(
        '[prefix-timing] ' +
          JSON.stringify({
            threshold,
            spawnInitMs: readyAt - spawnStart,
            displayMs: killStart - readyAt,
            killMs: killed - killStart,
            reopenMs: reopened - killed,
            recoveryMs: recovered - reopened,
            assertionsMs: performance.now() - recovered,
            child: stderr,
          }) +
          '\n',
      );
    } finally {
      await journal.close();
      database.close();
    }
  },
  30_000,
);
