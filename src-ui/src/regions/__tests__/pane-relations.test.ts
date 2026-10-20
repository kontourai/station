import { describe, expect, test } from 'vitest';
import {
  type PaneFenceStorage,
  paneFenceAdmission,
  readPaneFence,
  removePaneFence,
  writePaneFence,
} from '../pane-fence';
import {
  EMPTY_PANE_RELATIONS,
  keptPaneForTarget,
  openerSelectionKey,
  PANE_RELATIONS_LIMIT,
  type PaneOpener,
  type PaneRelation,
  type PaneRelationsRecord,
  parsePaneRelations,
  prunePaneRelations,
  sameRelationTarget,
  serializePaneRelations,
  sourceHiddenPanes,
  transientPaneForOpener,
  withKeptPane,
  withPaneRelation,
} from '../pane-relations';

const STATION = 'station-a';
const SECURITY: PaneOpener = {
  occurrenceId: 'chat',
  label: 'Security review',
  source: {
    kind: 'conversation',
    conversationId: 'conversation-security',
    threadId: 'thread-security',
    projectSlug: 'station',
  },
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
    opener: SECURITY,
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

function add(record: PaneRelationsRecord, entry: PaneRelation) {
  const written = withPaneRelation(record, entry);
  if (!written.ok) throw new Error('unexpected capacity refusal');
  return written.record;
}

function stored(entries: unknown[], version: unknown = 1): string {
  return JSON.stringify({ version, entries });
}

function memoryStorage(): PaneFenceStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

describe('reading the pane relations side record', () => {
  test('round-trips the entries it wrote, field for field', () => {
    const record = add(
      add(EMPTY_PANE_RELATIONS, relation('a')),
      relation('b', {
        kept: true,
        openedAt: 2,
        opener: {
          occurrenceId: 'coding:file-browser',
          label: 'Files · Station',
          source: { kind: 'files', projectId: 'p1', projectSlug: 'station' },
        },
      }),
    );
    const read = parsePaneRelations(serializePaneRelations(record));
    expect(read.status).toBe('ok');
    expect(read.record.entries).toEqual(record.entries);
  });

  test('keeps only the fields this version defines', () => {
    const read = parsePaneRelations(
      stored([
        {
          ...relation('a'),
          grant: 'fs:read',
          opener: {
            ...SECURITY,
            route: '/elsewhere',
            source: { ...SECURITY.source, boundContext: {} },
          },
          target: { ...relation('a').target, boundContext: {} },
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
    expect(entry?.opener).toEqual(SECURITY);
    expect(Object.keys(entry?.target ?? {}).sort()).toEqual(
      ['kind', 'path', 'projectId', 'projectSlug', 'thread'].sort(),
    );
  });

  test('refuses opener sources it cannot navigate exactly', () => {
    const read = parsePaneRelations(
      stored([
        relation('no-conversation', {
          opener: {
            ...SECURITY,
            source: {
              kind: 'conversation',
              conversationId: null,
              threadId: null,
              projectSlug: null,
            },
          },
        }),
        relation('off-origin', {
          opener: {
            ...SECURITY,
            source: { kind: 'route', pathname: '//evil.test/x', search: '' },
          },
        }),
        relation('traversal', {
          opener: {
            ...SECURITY,
            source: { kind: 'route', pathname: '/a/../b', search: '' },
          },
        }),
        relation('fragment', {
          opener: {
            ...SECURITY,
            source: { kind: 'route', pathname: '/projects/a', search: '?x#y' },
          },
        }),
        relation('route', {
          opener: {
            ...SECURITY,
            source: {
              kind: 'route',
              pathname: '/projects/station',
              search: '?pane=x',
            },
          },
        }),
      ]),
    );
    expect(read.record.entries.map((entry) => entry.instanceId)).toEqual([
      'route',
    ]);
  });

  test('a newer version, or more entries than the bound, is unsupported, never cut', () => {
    expect(parsePaneRelations(stored([relation('x')], 2)).status).toBe(
      'unsupported',
    );
    const over = Array.from({ length: PANE_RELATIONS_LIMIT + 1 }, (_, i) =>
      relation(`p${i}`),
    );
    expect(parsePaneRelations(stored(over))).toEqual({
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
        relation('good'),
        relation('good', { stateKey: 'other' }),
        relation('dup-key', { stateKey: 'good' }),
        { ...relation('bad'), kept: 'yes' },
        relation('self', { opener: { ...SECURITY, occurrenceId: 'self' } }),
        relation('loop-a', { opener: { ...SECURITY, occurrenceId: 'loop-b' } }),
        relation('loop-b', { opener: { ...SECURITY, occurrenceId: 'loop-a' } }),
        relation('control\u0007'),
        relation('child', { opener: { ...SECURITY, occurrenceId: 'good' } }),
      ]),
    );
    expect(read.record.entries.map((entry) => entry.instanceId)).toEqual([
      'good',
      'child',
    ]);
  });
});

describe('writing within the bound', () => {
  test('at the bound a new entry is refused and nothing is evicted', () => {
    let record = EMPTY_PANE_RELATIONS;
    for (let i = 0; i < PANE_RELATIONS_LIMIT; i += 1)
      record = add(record, relation(`p${i}`, { kept: i % 2 === 0 }));
    expect(withPaneRelation(record, relation('one-more'))).toEqual({
      ok: false,
      reason: 'capacity',
    });
    // Replacing an entry is not growth: the replaced one makes the room.
    const replaced = withPaneRelation(record, relation('next'), 'p1');
    expect(replaced.ok).toBe(true);
    if (replaced.ok) {
      expect(replaced.record.entries).toHaveLength(PANE_RELATIONS_LIMIT);
      expect(replaced.record.entries.map((e) => e.instanceId)).not.toContain(
        'p1',
      );
    }
  });

  test('pruning asks durable existence only, never this tab’s placement', () => {
    const record = add(add(EMPTY_PANE_RELATIONS, relation('a')), relation('b'));
    const pruned = prunePaneRelations(record, (id) => id === 'a');
    expect(pruned.entries.map((entry) => entry.instanceId)).toEqual(['a']);
    expect(prunePaneRelations(pruned, () => true)).toBe(pruned);
  });
});

describe('matching related panes', () => {
  test('target identity includes the Station, the Project and the thread', () => {
    const target = {
      kind: 'file' as const,
      projectId: 'project-uuid',
      projectSlug: 'station',
      path: 'src/a.ts',
      thread: null,
    };
    expect(sameRelationTarget('station-a', target, target)).toBe(true);
    expect(
      sameRelationTarget('station-a', target, { ...target, thread: 's1' }),
    ).toBe(false);
    expect(
      sameRelationTarget('station-a', target, {
        ...target,
        projectId: 'other-project',
      }),
    ).toBe(false);
  });

  test('a kept target is found only on its own Station', () => {
    const record = add(EMPTY_PANE_RELATIONS, relation('kept', { kept: true }));
    const target = relation('kept').target;
    expect(keptPaneForTarget(record, STATION, target)?.instanceId).toBe('kept');
    expect(keptPaneForTarget(record, 'station-b', target)).toBe(undefined);
  });

  test('the transient preview belongs to one exact opener selection', () => {
    const record = add(EMPTY_PANE_RELATIONS, relation('t'));
    expect(transientPaneForOpener(record, STATION, SECURITY)?.instanceId).toBe(
      't',
    );
    expect(
      transientPaneForOpener(record, STATION, {
        ...SECURITY,
        source: { ...SECURITY.source, threadId: 'thread-docs' },
      } as PaneOpener),
    ).toBe(undefined);
    expect(
      transientPaneForOpener(withKeptPane(record, 't'), STATION, SECURITY),
    ).toBe(undefined);
  });

  test('the selection key is derived from the typed source', () => {
    expect(openerSelectionKey(SECURITY)).toBe('thread:thread-security');
    expect(
      openerSelectionKey({
        ...SECURITY,
        source: {
          kind: 'conversation',
          conversationId: 'c1',
          threadId: null,
          projectSlug: null,
        },
      }),
    ).toBe('conversation:c1');
    expect(
      openerSelectionKey({
        occurrenceId: 'coding:file-browser',
        label: 'Files',
        source: { kind: 'files', projectId: 'p1', projectSlug: 's' },
      }),
    ).toBe('files:p1');
  });

  test('source changes hide transient previews only', () => {
    const record = add(
      add(EMPTY_PANE_RELATIONS, relation('transient')),
      relation('kept', { kept: true }),
    );
    const otherSession = new Map([['chat', 'thread:thread-docs']]);
    expect(
      sourceHiddenPanes(record, STATION, otherSession, () => false),
    ).toEqual(['transient']);
    expect(
      sourceHiddenPanes(
        record,
        STATION,
        new Map([['chat', openerSelectionKey(SECURITY)]]),
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
});

describe('the per-occurrence Station fence', () => {
  test('is written once, read back exactly and never rewritten', () => {
    const storage = memoryStorage();
    expect(readPaneFence(storage, 'p')).toEqual({ status: 'none' });
    expect(writePaneFence(storage, 'p', 'station-a')).toBe(true);
    expect(readPaneFence(storage, 'p')).toEqual({
      status: 'fenced',
      stationId: 'station-a',
    });
    expect(writePaneFence(storage, 'p', 'station-b')).toBe(false);
    expect(readPaneFence(storage, 'p')).toEqual({
      status: 'fenced',
      stationId: 'station-a',
    });
    removePaneFence(storage, 'p');
    expect(readPaneFence(storage, 'p')).toEqual({ status: 'none' });
  });

  test('an unreadable or newer fence is closed, never legacy', () => {
    const storage = memoryStorage();
    storage.setItem('station:pane-fence:v1:p', '{"version":2,"stationId":"x"}');
    expect(readPaneFence(storage, 'p')).toEqual({ status: 'unknown' });
    storage.setItem('station:pane-fence:v1:p', '{');
    expect(readPaneFence(storage, 'p')).toEqual({ status: 'unknown' });
    expect(paneFenceAdmission({ status: 'unknown' }, 'station-a')).toBe(
      'unknown-fence',
    );
    const throwing: PaneFenceStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readPaneFence(throwing, 'p')).toEqual({ status: 'unknown' });
  });

  test('admits only the exact verified Station', () => {
    const fenced = { status: 'fenced', stationId: 'station-a' } as const;
    expect(paneFenceAdmission(fenced, 'station-a')).toBe('admitted');
    expect(paneFenceAdmission(fenced, 'station-b')).toBe('wrong-station');
    expect(paneFenceAdmission(fenced, null)).toBe('checking');
    expect(paneFenceAdmission({ status: 'none' }, null)).toBe('legacy');
  });
});
