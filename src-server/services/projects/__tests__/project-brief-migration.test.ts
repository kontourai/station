import { PROJECT_INSTRUCTIONS_MAX_CHARS } from '@kontourai/station-contracts/project-session-context';
import { describe, expect, test, vi } from 'vitest';
import {
  migrateProjectRulesToBrief,
  type ProjectBriefMigrationDeps,
} from '../project-brief-migration.js';

type SaveBrief = ProjectBriefMigrationDeps['saveBrief'];

function deps(
  documents: Record<string, string>,
  saved: SaveBrief = vi.fn<SaveBrief>(),
): ProjectBriefMigrationDeps {
  return {
    listRulesDocuments: async () =>
      Object.keys(documents).map((filename, index) => ({
        id: `d${index}`,
        filename,
        createdAt: `2026-01-0${index + 1}`,
      })),
    readRulesDocument: async (_slug, id) =>
      Object.values(documents)[Number(id.slice(1))]!,
    saveBrief: saved,
    now: () => new Date('2026-11-17T00:00:00.000Z'),
  };
}

describe('#5062: legacy rules move into the brief once, losslessly', () => {
  test('appends project-rules.md unchanged after existing instructions', async () => {
    const saved = vi.fn<SaveBrief>();
    expect(
      await migrateProjectRulesToBrief(
        { slug: 'p', instructions: 'Existing.' },
        deps(
          { 'other.md': 'Second.', 'project-rules.md': '  Rules text.\n' },
          saved,
        ),
      ),
    ).toBe('migrated');
    expect(saved).toHaveBeenCalledWith('p', {
      instructions: 'Existing.\n\nRules text.\n\nSecond.',
      instructionsMigratedAt: '2026-11-17T00:00:00.000Z',
    });
  });

  test('runs once', async () => {
    const saved = vi.fn<SaveBrief>();
    expect(
      await migrateProjectRulesToBrief(
        { slug: 'p', instructionsMigratedAt: '2026-11-01T00:00:00.000Z' },
        deps({ 'project-rules.md': 'Rules.' }, saved),
      ),
    ).toBe('already-migrated');
    expect(saved).not.toHaveBeenCalled();
  });

  test('never truncates: rules past the limit stay rules', async () => {
    const saved = vi.fn<SaveBrief>();
    expect(
      await migrateProjectRulesToBrief(
        { slug: 'p' },
        deps(
          {
            'project-rules.md': 'x'.repeat(PROJECT_INSTRUCTIONS_MAX_CHARS + 1),
          },
          saved,
        ),
      ),
    ).toBe('too-long');
    expect(saved).not.toHaveBeenCalled();
  });

  test('a Project without rules is marked so it is not read again', async () => {
    const saved = vi.fn<SaveBrief>();
    expect(
      await migrateProjectRulesToBrief({ slug: 'p' }, deps({}, saved)),
    ).toBe('no-rules');
    expect(saved).toHaveBeenCalledWith('p', {
      instructionsMigratedAt: '2026-11-17T00:00:00.000Z',
    });
  });

  test('a failed read changes nothing and does not throw', async () => {
    const saved = vi.fn<SaveBrief>();
    const failing = {
      ...deps({ 'project-rules.md': 'x' }, saved),
      readRulesDocument: async () => {
        throw new Error('disk');
      },
    };
    expect(await migrateProjectRulesToBrief({ slug: 'p' }, failing)).toBe(
      'failed',
    );
    expect(saved).not.toHaveBeenCalled();
  });
});
