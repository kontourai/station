import { describe, expect, it } from 'vitest';
import {
  compareToBaseline,
  computeUpdatedBaseline,
  unguardedReads,
  unreviewedRows,
} from '../stored-path-expansion-guard.mjs';

describe('stored-path-expansion-guard: unguardedReads (detector)', () => {
  it('flags a raw read of a tilde field', () => {
    const hits = unguardedReads('const cwd = project.workingDirectory;\n');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      field: 'workingDirectory',
      text: 'const cwd = project.workingDirectory;',
    });
  });

  it('does not flag a read guarded by expandTilde on the same line', () => {
    const hits = unguardedReads(
      'const cwd = resolve(expandTilde(project.workingDirectory));\n',
    );
    expect(hits).toHaveLength(0);
  });

  // The four tests below each pin a defence whose source comment names a real
  // prior miss. Review deleted each defence in turn and BOTH original detector
  // tests stayed green, so the defences were unprotected: a single-line
  // fixture cannot exercise a multi-line window, and a fixture with no comment
  // cannot exercise comment stripping. Each mutation was confirmed reachable
  // before the fixture was written (review of station#3246).

  // The window is slice(index - 2, index + 3). A single-line fixture proves
  // nothing about it; collapsing the window to one line must red this.
  it('does not flag a read whose expandTilde is on a neighbouring line', () => {
    const hits = unguardedReads(
      [
        'const cwd = resolve(',
        '  expandTilde(',
        '    project.workingDirectory,',
        '  ),',
        ');',
        '',
      ].join('\n'),
    );
    expect(hits).toHaveLength(0);
  });

  // Comments are stripped before the expandTilde check, because otherwise the
  // word in a comment silences the guard for the code beside it -- the exact
  // station#3155 review finding.
  it('still flags a raw read whose line only MENTIONS expandTilde in a comment', () => {
    const hits = unguardedReads(
      'const cwd = project.workingDirectory; // no expandTilde needed here\n',
    );
    expect(hits).toHaveLength(1);
  });

  // `const { workingDirectory } = getProject(slug)` was silent until the
  // detector learned destructuring and bracket access.
  it('flags destructured and bracket-notation reads, not just dot access', () => {
    const destructured = unguardedReads(
      'const { workingDirectory } = getProject(slug);\n',
    );
    const bracket = unguardedReads("const d = config['storageDir'];\n");
    expect(destructured).toHaveLength(1);
    expect(bracket).toHaveLength(1);
  });

  // A field named inside a pure comment line is documentation, not a read.
  it('does not flag a field named only inside a comment line', () => {
    const hits = unguardedReads(
      '// workingDirectory is stored tilde-literal on purpose\n',
    );
    expect(hits).toHaveLength(0);
  });
});

describe('stored-path-expansion-guard: compareToBaseline', () => {
  const baselineRows = [
    {
      entry: 'a.ts :: workingDirectory :: known read',
      category: 1,
      reason: 'x',
    },
  ];

  it('reports no diff when found matches the baseline exactly', () => {
    const { added, removed } = compareToBaseline({
      found: ['a.ts :: workingDirectory :: known read'],
      baselineRows,
    });
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('reports a genuinely new entry as added — this is the fail-closed path', () => {
    const { added, removed } = compareToBaseline({
      found: [
        'a.ts :: workingDirectory :: known read',
        'b.ts :: workingDirectory :: brand new unguarded read',
      ],
      baselineRows,
    });
    expect(added).toEqual([
      'b.ts :: workingDirectory :: brand new unguarded read',
    ]);
    expect(removed).toEqual([]);
  });

  it('reports a baseline row that no longer appears as removed (fixed)', () => {
    const { added, removed } = compareToBaseline({
      found: [],
      baselineRows,
    });
    expect(added).toEqual([]);
    expect(removed).toEqual(baselineRows);
  });
});

describe('stored-path-expansion-guard: computeUpdatedBaseline', () => {
  const previousEntries = [
    {
      entry: 'a.ts :: workingDirectory :: known read',
      category: 1,
      reason: 'existence check',
    },
  ];

  it('carries forward the recorded category/reason for a persisting entry', () => {
    const result = computeUpdatedBaseline({
      found: ['a.ts :: workingDirectory :: known read'],
      previousEntries,
      seeding: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.unguardedReads).toEqual(previousEntries);
  });

  it('drops a row that no longer appears (fixed)', () => {
    const result = computeUpdatedBaseline({
      found: [],
      previousEntries,
      seeding: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.unguardedReads).toEqual([]);
  });

  it('refuses a new entry in an ALREADY-KNOWN file — closes the gap the flat baseline had', () => {
    // Same file as previousEntries ('a.ts'), a different statement. The old
    // guard only refused a whole new FILE, so this exact shape used to be
    // silently absorbed by --update.
    const result = computeUpdatedBaseline({
      found: [
        'a.ts :: workingDirectory :: known read',
        'a.ts :: workingDirectory :: a second, never-explained read',
      ],
      previousEntries,
      seeding: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.unexplained).toEqual([
      'a.ts :: workingDirectory :: a second, never-explained read',
    ]);
  });

  it('refuses a new entry in a brand-new file (the original station#3155 guard)', () => {
    const result = computeUpdatedBaseline({
      found: ['z.ts :: storageDir :: an unexplained read in a new file'],
      previousEntries,
      seeding: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.unexplained).toEqual([
      'z.ts :: storageDir :: an unexplained read in a new file',
    ]);
  });

  it('accepts anything when seeding (establishing the baseline for the first time)', () => {
    const result = computeUpdatedBaseline({
      found: ['z.ts :: storageDir :: brand new'],
      previousEntries: [],
      seeding: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.unguardedReads).toEqual([
      {
        entry: 'z.ts :: storageDir :: brand new',
        category: 0,
        reason: 'UNREVIEWED — seeded by --seed, needs a human triage pass.',
      },
    ]);
  });
});

describe('stored-path-expansion-guard: the recorded judgement is load-bearing', () => {
  // Five statements appear twice in the real baseline. Carry-forward used a
  // Map keyed on the statement, which keeps the LAST row and handed both
  // occurrences the same one -- so a no-op --update silently rewrote five
  // reasons to describe the wrong call site, while still reading as
  // authoritative (review of station#3246).
  it('keeps each duplicate occurrence its OWN reason through --update', () => {
    const entry = 'a.ts :: storageDir :: input.storageDir,';
    const previousEntries = [
      { entry, category: 2, reason: 'first site: mutateKnowledgeDocuments' },
      { entry, category: 2, reason: 'second site: readKnowledgeDocuments' },
    ];
    const result = computeUpdatedBaseline({
      found: [entry, entry],
      previousEntries,
      seeding: false,
    });
    expect(result.ok).toBe(true);
    expect(
      result.unguardedReads.map((row: { reason: string }) => row.reason),
    ).toEqual([
      'first site: mutateKnowledgeDocuments',
      'second site: readKnowledgeDocuments',
    ]);
  });

  // A SECOND copy of an already-baselined statement is a new unguarded read.
  // Set-membership could not see it: the loop just matched the same key twice.
  it('treats an extra occurrence of a known statement as unexplained', () => {
    const entry = 'a.ts :: storageDir :: input.storageDir,';
    const result = computeUpdatedBaseline({
      found: [entry, entry],
      previousEntries: [{ entry, category: 2, reason: 'the only known site' }],
      seeding: false,
    });
    expect(result.ok).toBe(false);
    expect(result.unexplained).toEqual([entry]);
  });

  // The laundering path: --update refuses an unexplained row, its error text
  // points at --seed, and --seed stamps category 0. If the gate does not read
  // the category, that row passes forever and the baseline only LOOKS reviewed.
  it('rejects a seeded placeholder row at the gate', () => {
    const seeded = computeUpdatedBaseline({
      found: ['new.ts :: workingDirectory :: readFileSync(p.workingDirectory)'],
      previousEntries: [],
      seeding: true,
    });
    expect(seeded.ok).toBe(true);
    expect(seeded.unguardedReads[0].category).toBe(0);

    const { added, unreviewed } = compareToBaseline({
      found: seeded.unguardedReads.map((row: { entry: string }) => row.entry),
      baselineRows: seeded.unguardedReads,
    });
    expect(added).toEqual([]);
    expect(unreviewed).toHaveLength(1);
  });

  it('rejects category 3 and an empty reason, and accepts 1, 2 and 4', () => {
    expect(
      unreviewedRows([
        { entry: 'a', category: 3, reason: 'a real bug, never a kept row' },
        { entry: 'b', category: 2, reason: '   ' },
        { entry: 'c', category: 1, reason: 'existence check' },
        { entry: 'd', category: 4, reason: 'deliberately raw' },
      ]).map((row: { entry: string }) => row.entry),
    ).toEqual(['a', 'b']);
  });
});
