/**
 * #3564 — working-memory and workflow-state writes are serialized and
 * atomic. Both are `StorageAdapter` methods VoltAgent calls only when
 * working memory or workflows are enabled (neither is today), so they are
 * exercised through `FileMemoryAdapter`, the object VoltAgent holds.
 *
 * The probe from the issue: before the fix the files were rewritten in
 * place (truncate, then write), so a read that landed between the two saw an
 * empty or partial document, and two read-modify-write updates lost one
 * another's field.
 */

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorkflowStateEntry } from '@voltagent/core';
import { beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../memory-adapter.js';

const USER = 'u1';
const CONVERSATION = 'c1';
const WRITES = 300;

function entry(
  overrides: Partial<WorkflowStateEntry> = {},
): WorkflowStateEntry {
  return {
    id: 'exec-1',
    workflowId: 'wf-1',
    workflowName: 'Workflow',
    status: 'running',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('working memory and workflow state writes (#3564)', () => {
  const tempDir = trackTempDirs();
  let home: string;
  let adapter: FileMemoryAdapter;

  beforeEach(async () => {
    home = tempDir('station-memory-state-concurrency-');
    adapter = new FileMemoryAdapter({ projectHomeDir: home });
    await adapter.createConversation({
      id: CONVERSATION,
      resourceId: 'agent-a',
      userId: USER,
      title: 'T',
      metadata: {},
    });
  });

  test('concurrent working-memory writes are never read torn, and the last call wins', async () => {
    const scope = 'conversation' as const;
    // Large enough that a non-atomic write spans several syscalls.
    const body = (i: number) => `${i}:${'m'.repeat(20_000)}`;
    await adapter.setWorkingMemory({
      conversationId: CONVERSATION,
      userId: USER,
      content: body(-1),
      scope,
    });

    const reads: Array<Promise<string | null>> = [];
    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < WRITES; i++) {
      writes.push(
        adapter.setWorkingMemory({
          conversationId: CONVERSATION,
          userId: USER,
          content: body(i),
          scope,
        }),
      );
      reads.push(
        adapter.getWorkingMemory({
          conversationId: CONVERSATION,
          userId: USER,
          scope,
        }),
      );
    }

    const settled = await Promise.allSettled(reads);
    await Promise.all(writes);

    const failed = settled.filter((result) => result.status === 'rejected');
    expect(failed).toHaveLength(0);
    for (const result of settled) {
      const content = (result as PromiseFulfilledResult<string | null>).value;
      expect(content).toMatch(/^-?\d+:m{20000}$/);
    }
    expect(
      await adapter.getWorkingMemory({
        conversationId: CONVERSATION,
        userId: USER,
        scope,
      }),
    ).toBe(body(WRITES - 1));
  });

  test('a delete issued right after a write removes what that write publishes', async () => {
    const params = {
      conversationId: CONVERSATION,
      userId: USER,
      scope: 'conversation' as const,
    };

    await Promise.all([
      adapter.setWorkingMemory({ ...params, content: 'one' }),
      adapter.deleteWorkingMemory(params),
    ]);

    // Unqueued, the delete finds nothing to remove and the write then lands.
    expect(await adapter.getWorkingMemory(params)).toBeNull();
  });

  test('a delete queued after a write removes it, and a write after a delete survives', async () => {
    const params = {
      conversationId: CONVERSATION,
      userId: USER,
      scope: 'user' as const,
    };
    const sequence = [
      adapter.setWorkingMemory({ ...params, content: 'one' }),
      adapter.deleteWorkingMemory(params),
      adapter.setWorkingMemory({ ...params, content: 'two' }),
      adapter.deleteWorkingMemory(params),
      adapter.setWorkingMemory({ ...params, content: 'three' }),
    ];
    await Promise.all(sequence);

    expect(await adapter.getWorkingMemory(params)).toBe('three');
  });

  test('concurrent workflow-state writes are never read torn', async () => {
    await adapter.setWorkflowState('exec-1', entry());
    const reads: Array<Promise<WorkflowStateEntry | null>> = [];
    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < WRITES; i++) {
      writes.push(
        adapter.setWorkflowState(
          'exec-1',
          entry({ workflowName: `Workflow ${i} ${'w'.repeat(20_000)}` }),
        ),
      );
      reads.push(adapter.getWorkflowState('exec-1'));
    }

    const read = await Promise.all(reads);
    await Promise.all(writes);

    // `getWorkflowStateEntry` swallows a parse failure into `null`, which is
    // how a torn read shows up here.
    expect(read.filter((state) => state === null)).toHaveLength(0);
    expect((await adapter.getWorkflowState('exec-1'))?.workflowName).toBe(
      `Workflow ${WRITES - 1} ${'w'.repeat(20_000)}`,
    );
  });

  test('concurrent updates to different fields keep every field', async () => {
    await adapter.setWorkflowState('exec-1', entry());

    await Promise.all([
      adapter.updateWorkflowState('exec-1', { workflowName: 'Renamed' }),
      adapter.updateWorkflowState('exec-1', { status: 'completed' }),
      adapter.updateWorkflowState('exec-1', { workflowId: 'wf-2' }),
    ]);

    expect(await adapter.getWorkflowState('exec-1')).toMatchObject({
      workflowName: 'Renamed',
      status: 'completed',
      workflowId: 'wf-2',
    });
  });

  test('updating an entry that does not exist still rejects', async () => {
    await expect(
      adapter.updateWorkflowState('missing', { status: 'error' }),
    ).rejects.toThrow('Workflow state missing not found');
  });

  /**
   * Reads the file itself, bypassing the adapter and its queue, in a tight
   * loop while `write` runs. The queue orders writers against each other but
   * takes no part in reads, so only an atomic publish keeps this reader from
   * seeing the empty or half-written file an in-place `writeFile` exposes
   * between its truncate and its last byte. A single read that catches that
   * window fails the test; correct code has no such window, so it cannot flake.
   */
  async function readsWhile(
    path: string,
    write: () => Promise<void>,
  ): Promise<{ reads: number; torn: string[] }> {
    let writing = true;
    const torn: string[] = [];
    let reads = 0;
    const reader = (async () => {
      while (writing) {
        const text = await readFile(path, 'utf-8');
        reads++;
        try {
          JSON.parse(text);
        } catch {
          torn.push(`${text.length} bytes: ${text.slice(0, 40)}`);
        }
      }
    })();
    try {
      await write();
    } finally {
      writing = false;
    }
    await reader;
    return { reads, torn };
  }

  test('a raw reader never sees a partial working-memory file while it is rewritten', async () => {
    const params = {
      conversationId: CONVERSATION,
      userId: USER,
      scope: 'conversation' as const,
    };
    const paths = (
      adapter as unknown as {
        paths: {
          getConversationWorkingMemoryPath(r: string, c: string): string;
        };
      }
    ).paths;
    const path = paths.getConversationWorkingMemoryPath(
      'agent-a',
      CONVERSATION,
    );
    await adapter.setWorkingMemory({ ...params, content: 'seed' });

    const { reads, torn } = await readsWhile(path, async () => {
      for (let i = 0; i < 40; i++) {
        await adapter.setWorkingMemory({
          ...params,
          content: `${i}:${'m'.repeat(i % 2 === 0 ? 4_000_000 : 10)}`,
        });
      }
    });

    expect(reads).toBeGreaterThan(0);
    expect(torn).toEqual([]);
  });

  test('a raw reader never sees a partial workflow-state file while it is rewritten', async () => {
    const paths = (
      adapter as unknown as {
        paths: { getWorkflowStatePath(id: string): string };
      }
    ).paths;
    const path = paths.getWorkflowStatePath('exec-1');
    await adapter.setWorkflowState('exec-1', entry());

    const { reads, torn } = await readsWhile(path, async () => {
      for (let i = 0; i < 40; i++) {
        await adapter.setWorkflowState(
          'exec-1',
          entry({
            workflowName: `${i}:${'w'.repeat(i % 2 === 0 ? 4_000_000 : 10)}`,
          }),
        );
      }
    });

    expect(reads).toBeGreaterThan(0);
    expect(torn).toEqual([]);
  });

  test('no temporary file is left beside a published document', async () => {
    await adapter.setWorkflowState('exec-1', entry());
    await adapter.updateWorkflowState('exec-1', { status: 'completed' });
    await adapter.setWorkingMemory({
      conversationId: CONVERSATION,
      userId: USER,
      content: 'x',
      scope: 'conversation',
    });

    const workflowDir = dirname(
      (
        adapter as unknown as {
          paths: { getWorkflowStatePath(id: string): string };
        }
      ).paths.getWorkflowStatePath('exec-1'),
    );
    expect(readdirSync(workflowDir)).toEqual(['exec-1.json']);
  });
});
