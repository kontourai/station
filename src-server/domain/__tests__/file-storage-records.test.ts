import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  buildLayoutAgentReferences,
  deleteStoredRecord,
  listSortedConversations,
  saveStoredRecord,
} from '../file-storage-records.js';

describe('file-storage-records', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'storage-records-'));
    filePath = join(tempDir, 'records.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('saveStoredRecord upserts by id and deleteStoredRecord removes existing entries', async () => {
    await saveStoredRecord(filePath, { id: 'one', value: 1 });
    await saveStoredRecord(filePath, { id: 'one', value: 2 });

    expect(await deleteStoredRecord(filePath, 'one')).toBe(true);
    expect(await deleteStoredRecord(filePath, 'missing')).toBe(false);
  });

  test('listSortedConversations sorts newest-first and applies pagination', async () => {
    await saveStoredRecord(filePath, {
      id: 'one',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await saveStoredRecord(filePath, {
      id: 'two',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    await saveStoredRecord(filePath, {
      id: 'three',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });

    expect(listSortedConversations(filePath, { offset: 1, limit: 1 })).toEqual([
      expect.objectContaining({ id: 'two' }),
    ]);
  });

  // One case per arm, each asking about an agent ONLY that arm names. The
  // previous single case put the tab reference on `agent-a` and then asked
  // about `agent-c` (the defaultAgent), so the tab arm could have been deleted
  // outright and the test would still have passed — which is how the
  // `tabs[].prompts` -> `tabs[].skills` rename went unnoticed here (review H2).
  test.each([
    [
      'a tab skill',
      { tabs: [{ skills: [{ agent: 'tab-skill-agent' }] }] },
      'tab-skill-agent',
    ],
    [
      'a tab action',
      { tabs: [{ actions: [{ agent: 'tab-action-agent' }] }] },
      'tab-action-agent',
    ],
    [
      'a global skill',
      { globalSkills: [{ agent: 'global-agent' }] },
      'global-agent',
    ],
    [
      'a layout action',
      { actions: [{ agent: 'action-agent' }] },
      'action-agent',
    ],
    ['the default agent', { defaultAgent: 'default-agent' }, 'default-agent'],
    [
      'an available agent',
      { availableAgents: ['available-agent'] },
      'available-agent',
    ],
  ])(
    'buildLayoutAgentReferences sees an agent named only by %s',
    (_label, config, agentSlug) => {
      expect(
        buildLayoutAgentReferences(
          [{ slug: 'project-a' }],
          () => [{ slug: 'layout-1' }],
          () => ({ config }),
          agentSlug,
        ),
      ).toEqual([{ projectSlug: 'project-a', layoutSlug: 'layout-1' }]);
    },
  );

  test('buildLayoutAgentReferences ignores a layout that names no such agent', () => {
    expect(
      buildLayoutAgentReferences(
        [{ slug: 'project-a' }],
        () => [{ slug: 'layout-1' }],
        () => ({
          config: { tabs: [{ skills: [{ agent: 'someone-else' }] }] },
        }),
        'agent-c',
      ),
    ).toEqual([]);
  });

  // The retired key must not keep working by accident: a stored layout still
  // on `tabs[].prompts` is not a tab-skill reference any more.
  test('buildLayoutAgentReferences does not read the retired tabs[].prompts key', () => {
    expect(
      buildLayoutAgentReferences(
        [{ slug: 'project-a' }],
        () => [{ slug: 'layout-1' }],
        () => ({
          config: { tabs: [{ prompts: [{ agent: 'agent-a' }] }] },
        }),
        'agent-a',
      ),
    ).toEqual([]);
  });
});
