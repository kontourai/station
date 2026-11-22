import { describe, expect, test } from 'vitest';
import {
  bindPreToolPolicyGeneration,
  type PreToolPolicyLaunchRead,
} from '../pre-tool-policy-generation.js';

/** A binding over a launch value the test changes, at a revision it moves. */
async function binding(initial: unknown) {
  let revision: number | null = 2;
  let counter = 2;
  let launch = initial;
  let duringRead: (() => void) | undefined;
  const generation = await bindPreToolPolicyGeneration({
    getStableRevision: () => revision,
    readLaunch: async (): Promise<PreToolPolicyLaunchRead> => {
      const read = structuredClone(launch);
      duringRead?.();
      return { state: 'read', spec: { name: 'A', prompt: 'p' }, launch: read };
    },
  });
  return {
    generation,
    change(next: unknown) {
      launch = next;
      counter += 2;
      revision = counter;
    },
    set revision(value: number | null) {
      revision = value;
    },
    set duringRead(fn: (() => void) | undefined) {
      duringRead = fn;
    },
  };
}

describe('pre-tool policy generation fingerprint', () => {
  test("a command's args are ordered: reordering them replaces the session", async () => {
    const b = await binding({ command: 'mcp', args: ['--read-only', 'serve'] });
    b.change({ command: 'mcp', args: ['serve', '--read-only'] });
    expect(await b.generation.refresh()).toBe('replaced');
  });

  test('set-valued lists are not ordered: reordering tool names does not', async () => {
    const b = await binding({ toolNames: ['list', 'delete_repo'] });
    b.change({ toolNames: ['delete_repo', 'list'] });
    expect(await b.generation.refresh()).toBe('current');
  });

  test('a read a change overlapped decides nothing', async () => {
    const original = { command: 'mcp', args: [] };
    const b = await binding(original);
    // The revision moves; the read then sees a half-applied configuration
    // while the next change is still in flight.
    b.change({ command: 'half-written', args: [] });
    b.duringRead = () => {
      b.revision = null;
    };
    expect(await b.generation.refresh()).toBe('settling');
    // That change lands and restores the original: nothing was replaced.
    b.duringRead = undefined;
    b.change(original);
    expect(await b.generation.refresh()).toBe('current');
  });
});
