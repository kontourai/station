/**
 * The serialized agent updater, against the race it exists to close.
 *
 * A binding change is a read-modify-write on a record an editor may be saving
 * at the same instant. `saveAgentConfig` locks only the write, so a caller that
 * loaded, derived and then saved republished a snapshot taken before the
 * editor's change and silently erased it (review delta HIGH). These tests run
 * against the REAL store on a real temp home, because the claim is about a
 * filesystem lock, not about a mock's call order.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { loadAgentConfig, mutateAgentConfig } from '../config-loader-agents.js';

let home: string;

function readWriter(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(home, 'agents', 'writer', 'agent.json'), 'utf-8'),
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agent-binding-concurrency-'));
  mkdirSync(join(home, 'agents', 'writer'), { recursive: true });
  writeFileSync(
    join(home, 'agents', 'writer', 'agent.json'),
    JSON.stringify({ name: 'Writer', prompt: 'v1', skills: ['existing'] }),
    'utf-8',
  );
});

describe('mutateAgentConfig', () => {
  test('two concurrent updaters both land — neither reads a stale snapshot', async () => {
    // The binding writer and an editor save, racing. Under the old
    // load-then-save shape the loser republished its pre-read copy and the
    // winner's field vanished.
    await Promise.all([
      mutateAgentConfig(home, 'writer', (current) => ({
        ...current,
        skills: [...((current as { skills?: string[] }).skills ?? []), 'added'],
      })),
      mutateAgentConfig(home, 'writer', (current) => ({
        ...current,
        prompt: 'v2-from-the-editor',
      })),
    ]);

    const stored = readWriter();
    expect(stored.skills).toEqual(['existing', 'added']);
    expect(stored.prompt).toBe('v2-from-the-editor');
  });

  test('the updater can DELETE a key, which a merge never could', async () => {
    writeFileSync(
      join(home, 'agents', 'writer', 'agent.json'),
      JSON.stringify({
        name: 'Writer',
        prompt: 'v1',
        description: 'optional description',
      }),
      'utf-8',
    );
    await mutateAgentConfig(home, 'writer', (current) => {
      const { description: _dropped, ...rest } = current as unknown as Record<
        string,
        unknown
      >;
      return { ...rest, skills: ['migrated'] } as never;
    });
    const stored = readWriter();
    expect(Object.hasOwn(stored, 'description')).toBe(false);
    expect(stored.skills).toEqual(['migrated']);
  });

  test('returning null writes nothing at all', async () => {
    const before = readFileSync(
      join(home, 'agents', 'writer', 'agent.json'),
      'utf-8',
    );
    const result = await mutateAgentConfig(home, 'writer', () => null);
    expect(result).toBeNull();
    expect(
      readFileSync(join(home, 'agents', 'writer', 'agent.json'), 'utf-8'),
    ).toBe(before);
  });

  test('the updater is handed a copy, so scribbling on it cannot reach disk', async () => {
    await mutateAgentConfig(home, 'writer', (current) => {
      (current as { skills: string[] }).skills.push('scribbled');
      return null;
    });
    expect(readWriter().skills).toEqual(['existing']);
    // And the loader still answers the stored value, not the mutated copy.
    expect((await loadAgentConfig(home, 'writer')).skills).toEqual([
      'existing',
    ]);
  });

  test('an updater that throws leaves the record untouched', async () => {
    await expect(
      mutateAgentConfig(home, 'writer', () => {
        throw new Error('derivation failed');
      }),
    ).rejects.toThrow('derivation failed');
    expect(readWriter()).toEqual({
      name: 'Writer',
      prompt: 'v1',
      skills: ['existing'],
    });
  });
});
