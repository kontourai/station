import { describe, expect, test } from 'vitest';
import {
  EMPTY_PANE_RELATIONS,
  keptPaneForTarget,
  PANE_RELATIONS_LIMIT,
  type PaneRelation,
  paneTargetKey,
  parsePaneRelations,
  prunePaneRelations,
  serializePaneRelations,
  sourceHiddenPanes,
  transientPaneForOpener,
  withKeptPane,
  withPaneRelation,
} from '../pane-relations';

const STATION = 'station-a';
const opener = {
  occurrenceId: 'chat',
  selection: 'thread:security-review',
  label: 'Security review',
};

function relation(
  id: string,
  overrides: Partial<PaneRelation> = {},
): PaneRelation {
  return {
    instanceId: id,
    stateKey: id,
    stationId: STATION,
    generation: 'builtin',
    opener,
    target: {
      kind: 'file',
      projectId: 'project-uuid',
      projectSlug: 'station',
      path: `src/${id}.ts`,
      thread: null,
    },
    kept: false,
    openedAt: 1,
    ...overrides,
  };
}

function stored(entries: unknown[], version: unknown = 1): string {
  return JSON.stringify({ version, entries });
}

describe('reading the pane relations side record', () => {
  test('round-trips the entries it wrote, field for field', () => {
    const record = withPaneRelation(
      withPaneRelation(EMPTY_PANE_RELATIONS, relation('file-preview:a')),
      relation('file-preview:b', { kept: true, openedAt: 2 }),
    );
    const read = parsePaneRelations(serializePaneRelations(record));
    expect(read.status).toBe('ok');
    expect(read.record.entries).toEqual(record.entries);
  });

  test('keeps only the fields this version defines', () => {
    const read = parsePaneRelations(
      stored([
        {
          ...relation('file-preview:a'),
          grant: 'fs:read',
          opener: { ...opener, route: '/elsewhere' },
          target: { ...relation('file-preview:a').target, boundContext: {} },
        },
      ]),
    );
    const [entry] = read.record.entries;
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      [
        'generation',
        'instanceId',
        'kept',
        'openedAt',
        'opener',
        'stateKey',
        'stationId',
        'target',
      ].sort(),
    );
    expect(entry?.opener).toEqual(opener);
    expect(Object.keys(entry?.target ?? {}).sort()).toEqual(
      ['kind', 'path', 'projectId', 'projectSlug', 'thread'].sort(),
    );
  });

  test('a newer version is unsupported, never applied; garbage is empty', () => {
    expect(parsePaneRelations(stored([relation('x')], 2))).toEqual({
      status: 'unsupported',
      record: EMPTY_PANE_RELATIONS,
    });
    for (const raw of [
      null,
      '',
      '{',
      '[]',
      stored([], 0),
      JSON.stringify({ version: 1 }),
      'x'.repeat(96 * 1024 + 1),
    ])
      expect(parsePaneRelations(raw).status).toBe('empty');
  });

  test('drops invalid, duplicate, self-opened and cyclic entries one by one', () => {
    const read = parsePaneRelations(
      stored([
        relation('file-preview:good'),
        relation('file-preview:good', { stateKey: 'other' }),
        relation('file-preview:dup-key', { stateKey: 'file-preview:good' }),
        { ...relation('file-preview:bad'), kept: 'yes' },
        relation('file-preview:self', {
          opener: { ...opener, occurrenceId: 'file-preview:self' },
        }),
        relation('loop-a', { opener: { ...opener, occurrenceId: 'loop-b' } }),
        relation('loop-b', { opener: { ...opener, occurrenceId: 'loop-a' } }),
        relation('file-preview:control\u0007', {}),
        relation('child', {
          opener: { ...opener, occurrenceId: 'file-preview:good' },
        }),
      ]),
    );
    expect(read.record.entries.map((entry) => entry.instanceId)).toEqual([
      'file-preview:good',
      'child',
    ]);
  });

  test('holds the bound, keeping kept work and the newest previews', () => {
    const entries = Array.from({ length: PANE_RELATIONS_LIMIT + 5 }, (_, i) =>
      relation(`p${i}`, { openedAt: i, kept: i === 0 }),
    );
    const read = parsePaneRelations(stored(entries));
    expect(read.record.entries).toHaveLength(PANE_RELATIONS_LIMIT);
    const ids = read.record.entries.map((entry) => entry.instanceId);
    // The oldest entry survives because it is kept; the next oldest go.
    expect(ids).toContain('p0');
    expect(ids).not.toContain('p1');
    expect(ids).toContain(`p${PANE_RELATIONS_LIMIT + 4}`);
  });
});

describe('matching related panes', () => {
  const placed = () => true;

  test('target identity includes the Station, the Project and the thread', () => {
    const target = {
      kind: 'file' as const,
      projectId: 'project-uuid',
      projectSlug: 'station',
      path: 'src/a.ts',
      thread: null,
    };
    expect(paneTargetKey('station-a', target)).not.toBe(
      paneTargetKey('station-b', target),
    );
    expect(
      paneTargetKey('station-a', { ...target, thread: 'session-1' }),
    ).not.toBe(paneTargetKey('station-a', target));
    expect(
      paneTargetKey('station-a', { ...target, projectId: 'other-project' }),
    ).not.toBe(paneTargetKey('station-a', target));
  });

  test('a kept target is found only on its own Station and only while placed', () => {
    const record = withPaneRelation(
      EMPTY_PANE_RELATIONS,
      relation('kept', { kept: true }),
    );
    const target = relation('kept').target;
    expect(keptPaneForTarget(record, STATION, target, placed)?.instanceId).toBe(
      'kept',
    );
    expect(keptPaneForTarget(record, 'station-b', target, placed)).toBe(
      undefined,
    );
    expect(keptPaneForTarget(record, STATION, target, () => false)).toBe(
      undefined,
    );
  });

  test('the transient preview belongs to one exact opener selection', () => {
    const record = withPaneRelation(EMPTY_PANE_RELATIONS, relation('t'));
    expect(
      transientPaneForOpener(record, STATION, opener, placed)?.instanceId,
    ).toBe('t');
    expect(
      transientPaneForOpener(
        record,
        STATION,
        { ...opener, selection: 'thread:documentation-review' },
        placed,
      ),
    ).toBe(undefined);
    expect(
      transientPaneForOpener(
        withKeptPane(record, 't'),
        STATION,
        opener,
        placed,
      ),
    ).toBe(undefined);
  });

  test('source changes hide transient previews only', () => {
    const record = withPaneRelation(
      withPaneRelation(EMPTY_PANE_RELATIONS, relation('transient')),
      relation('kept', { kept: true }),
    );
    const otherSession = new Map([['chat', 'thread:documentation-review']]);
    expect(
      sourceHiddenPanes(record, STATION, otherSession, () => false),
    ).toEqual(['transient']);
    // Same selection, no published selection, another Station, protected
    // work: nothing hides.
    expect(
      sourceHiddenPanes(
        record,
        STATION,
        new Map([['chat', opener.selection]]),
        () => false,
      ),
    ).toEqual([]);
    expect(sourceHiddenPanes(record, STATION, new Map(), () => false)).toEqual(
      [],
    );
    expect(
      sourceHiddenPanes(record, 'station-b', otherSession, () => false),
    ).toEqual([]);
    expect(
      sourceHiddenPanes(record, STATION, otherSession, () => true),
    ).toEqual([]);
    expect(sourceHiddenPanes(record, null, otherSession, () => false)).toEqual(
      [],
    );
  });

  test('pruning drops only occurrences the arrangement no longer holds', () => {
    const record = withPaneRelation(
      withPaneRelation(EMPTY_PANE_RELATIONS, relation('open')),
      relation('closed'),
    );
    const pruned = prunePaneRelations(record, (id) => id === 'open');
    expect(pruned.entries.map((entry) => entry.instanceId)).toEqual(['open']);
    expect(prunePaneRelations(pruned, () => true)).toBe(pruned);
  });
});
