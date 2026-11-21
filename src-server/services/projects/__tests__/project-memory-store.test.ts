import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_MEMORY_MAX_NOTES } from '@kontourai/station-contracts/project-session-context';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  ProjectMemoryLimitError,
  ProjectMemoryStore,
  parseProjectMemoryNoteFile,
} from '../project-memory-store.js';
import { createProjectSessionContextSource } from '../project-session-context-source.js';

const person = { kind: 'person' as const, label: 'Project owner' };

describe('ProjectMemoryStore', () => {
  const makeTempDir = trackTempDirs();

  test('notes live in the Project data directory with a readable index', async () => {
    const home = makeTempDir('project-memory-');
    const store = new ProjectMemoryStore(home);
    const note = await store.createNote(
      'p',
      { title: 'Use Friday', body: 'The release moved.' },
      person,
    );
    const file = join(
      home,
      'projects',
      'p',
      'memory',
      'notes',
      `${note.id}.md`,
    );
    expect(
      parseProjectMemoryNoteFile(note.id, await readFile(file, 'utf8')),
    ).toEqual(note);
    expect(
      await readFile(
        join(home, 'projects', 'p', 'memory', 'MEMORY.md'),
        'utf8',
      ),
    ).toContain(`[Use Friday](notes/${note.id}.md)`);
    expect(await store.listSummaries('other')).toEqual([]);
  });

  test('every read goes to disk: a note removed behind the store is gone from the next briefing', async () => {
    const home = makeTempDir('project-memory-');
    const store = new ProjectMemoryStore(home);
    const source = createProjectSessionContextSource({
      getProject: () => ({
        id: 'p-id',
        slug: 'p',
        name: 'P',
        createdAt: '',
        updatedAt: '',
      }),
      memory: store,
    });
    const stale = await store.createNote(
      'p',
      { title: 'Stale', body: '' },
      person,
    );
    expect((await source.resolve('p'))!.text).toContain('Stale');
    // Removed by something other than this store instance: a cache of the
    // earlier read would still list it.
    await rm(join(home, 'projects', 'p', 'memory', 'notes', `${stale.id}.md`));
    expect(await source.resolve('p')).toBeUndefined();
  });

  test('update keeps the creator and records who changed it; delete is final', async () => {
    const home = makeTempDir('project-memory-');
    const store = new ProjectMemoryStore(home);
    const agent = { kind: 'agent' as const, label: 'coder', sessionId: 's1' };
    const note = await store.createNote('p', { title: 'A', body: 'x' }, agent);
    const updated = await store.updateNote(
      'p',
      note.id,
      { title: 'B', body: 'y' },
      person,
    );
    expect(updated).toMatchObject({
      title: 'B',
      createdBy: agent,
      updatedBy: person,
    });
    expect(await store.deleteNote('p', note.id)).toBe(true);
    expect(await store.deleteNote('p', note.id)).toBe(false);
    expect(await store.getNote('p', note.id)).toBeUndefined();
    expect(await store.getNote('p', '../escape')).toBeUndefined();
  });

  test('refuses past the note limit', async () => {
    const home = makeTempDir('project-memory-');
    const store = new ProjectMemoryStore(home);
    await Promise.all(
      Array.from({ length: PROJECT_MEMORY_MAX_NOTES }, (_, index) =>
        store.createNote('p', { title: `n${index}`, body: '' }, person),
      ),
    );
    await expect(
      store.createNote('p', { title: 'one more', body: '' }, person),
    ).rejects.toBeInstanceOf(ProjectMemoryLimitError);
    expect(await store.listSummaries('p')).toHaveLength(
      PROJECT_MEMORY_MAX_NOTES,
    );
  });
});
