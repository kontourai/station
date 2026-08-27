/**
 * Binding writes: ordering, and what survives a failure half-way.
 *
 * The claims here are all about partial application — the state left behind
 * when the second of two writes fails — so every test drives a store that
 * fails a named agent rather than asserting call order on a mock.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  AgentBindingDetachError,
  removeAgentBindings,
  renameAgentBindings,
  setSoleAgentBinding,
} from '../agent-binding-writer.js';

function createStore(initial: Record<string, string[]>, failOn?: string) {
  const records: Record<string, Record<string, unknown>> = {};
  for (const [slug, skills] of Object.entries(initial)) {
    records[slug] = { name: slug, prompt: 'p', skills: [...skills] };
  }
  return {
    records,
    listAgents: async () => Object.keys(records).map((slug) => ({ slug })),
    mutateAgent: vi.fn(
      async (
        slug: string,
        updater: (
          current: Record<string, unknown>,
        ) => Record<string, unknown> | null,
      ) => {
        if (slug === failOn) throw new Error(`refused: ${slug}`);
        const next = updater(structuredClone(records[slug]));
        if (next === null) return null;
        records[slug] = next;
        return next;
      },
    ),
  };
}

const skills = (store: ReturnType<typeof createStore>, slug: string) =>
  store.records[slug].skills;

describe('setSoleAgentBinding', () => {
  test('attaches where asked and detaches everywhere else', async () => {
    const store = createStore({ writer: ['deploy'], coder: ['other'] });
    await setSoleAgentBinding(store as never, 'deploy', 'coder');
    expect(skills(store, 'coder')).toEqual(['other', 'deploy']);
    expect(skills(store, 'writer')).toEqual([]);
  });

  test('a failure attaching leaves the previous binding intact', async () => {
    // Add-then-remove: the attach is first, so if it fails nothing has been
    // detached and the user still has the binding they had.
    const store = createStore({ writer: ['deploy'], coder: [] }, 'coder');
    await expect(
      setSoleAgentBinding(store as never, 'deploy', 'coder'),
    ).rejects.toThrow('refused: coder');
    expect(skills(store, 'writer')).toEqual(['deploy']);
  });

  test('a failure detaching leaves a superset, and says so', async () => {
    // The reverse order LOST the binding outright here: detached from writer,
    // never attached to coder, request failed, binding simply gone. A superset
    // is visible and fixable; a deletion is not.
    const store = createStore({ writer: ['deploy'], coder: [] }, 'writer');
    const error = await setSoleAgentBinding(
      store as never,
      'deploy',
      'coder',
    ).catch((e) => e);
    expect(error).toBeInstanceOf(AgentBindingDetachError);
    expect(error.message).toContain("attached to 'coder'");
    expect(error.message).toContain("'writer'");
    expect(skills(store, 'coder')).toEqual(['deploy']);
    expect(skills(store, 'writer')).toEqual(['deploy']);
  });

  test('re-binding to the agent that already has it writes nothing', async () => {
    const store = createStore({ coder: ['deploy'] });
    await setSoleAgentBinding(store as never, 'deploy', 'coder');
    expect(store.mutateAgent).toHaveBeenCalledTimes(1);
    expect(await store.mutateAgent.mock.results[0].value).toBeNull();
  });
});

describe('renameAgentBindings', () => {
  test('every agent bound to the old name follows the rename', async () => {
    const store = createStore({
      writer: ['release-check', 'other'],
      coder: ['unrelated'],
    });
    const rebound = await renameAgentBindings(
      store as never,
      'release-check',
      'release-gate',
    );
    expect(rebound).toEqual({ changed: ['writer'], failed: [] });
    expect(skills(store, 'writer')).toEqual(['other', 'release-gate']);
    expect(skills(store, 'coder')).toEqual(['unrelated']);
  });

  test('an agent already holding the new name does not gain a duplicate', async () => {
    const store = createStore({ writer: ['release-check', 'release-gate'] });
    await renameAgentBindings(store as never, 'release-check', 'release-gate');
    expect(skills(store, 'writer')).toEqual(['release-gate']);
  });

  test('a rename to the same name is not a write', async () => {
    const store = createStore({ writer: ['deploy'] });
    await renameAgentBindings(store as never, 'deploy', 'deploy');
    expect(store.mutateAgent).not.toHaveBeenCalled();
  });
});

describe('fan-out failures are collected, never fatal', () => {
  test('rename continues past a failure and reports every agent it could not reach', async () => {
    // Stopping on the first error left the remaining agents holding a name
    // that no longer exists, with no record of which ones — and the caller had
    // no identifier left to retry through.
    const store = createStore(
      { alpha: ['old'], writer: ['old'], zulu: ['old'] },
      'writer',
    );
    const result = await renameAgentBindings(store as never, 'old', 'new');
    expect(result.changed).toEqual(['alpha', 'zulu']);
    expect(result.failed).toEqual([
      { slug: 'writer', reason: 'refused: writer' },
    ]);
    // Every reachable agent was still attempted.
    expect(skills(store, 'zulu')).toEqual(['new']);
  });

  test('remove continues past a failure and reports it', async () => {
    const store = createStore(
      { alpha: ['deploy'], writer: ['deploy'], zulu: ['deploy'] },
      'writer',
    );
    const result = await removeAgentBindings(store as never, 'deploy');
    expect(result.changed).toEqual(['alpha', 'zulu']);
    expect(result.failed).toEqual([
      { slug: 'writer', reason: 'refused: writer' },
    ]);
    expect(skills(store, 'zulu')).toEqual([]);
  });
});

describe('removeAgentBindings', () => {
  test('a deleted skill is dropped from every agent that bound it', async () => {
    const store = createStore({ writer: ['deploy'], coder: ['deploy', 'x'] });
    const unbound = await removeAgentBindings(store as never, 'deploy');
    expect(unbound).toEqual({ changed: ['writer', 'coder'], failed: [] });
    expect(skills(store, 'writer')).toEqual([]);
    expect(skills(store, 'coder')).toEqual(['x']);
  });

  test('agents that never bound it are not rewritten', async () => {
    const store = createStore({ writer: ['other'] });
    expect(await removeAgentBindings(store as never, 'deploy')).toEqual({
      changed: [],
      failed: [],
    });
    expect(await store.mutateAgent.mock.results[0].value).toBeNull();
  });
});
