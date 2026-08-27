import { describe, expect, it } from 'vitest';
import {
  assertUIBlockProvenanceAccepted,
  deriveUIBlockAttestationState,
  isUIBlockDataBearing,
  normalizeUIBlockSourceRefs,
  parseUIBlockSourceRefs,
  UIBlockProvenanceRefusedError,
  type UICardBlock,
  type UICodeBlock,
  type UIFormBlock,
  type UITableBlock,
} from '../ui-block.js';

describe('UI block provenance — the decorative/claiming boundary', () => {
  it('is claiming (data-bearing) when a card carries label/value fields', () => {
    const card: UICardBlock = {
      type: 'card',
      body: 'All checks passed',
      fields: [{ label: 'Coverage', value: '98%' }],
    };
    expect(isUIBlockDataBearing(card)).toBe(true);
  });

  it('is decorative when a card has prose only, no fields', () => {
    const card: UICardBlock = { type: 'card', body: 'All checks passed' };
    expect(isUIBlockDataBearing(card)).toBe(false);
    expect(deriveUIBlockAttestationState(card)).toBe('decorative');
  });

  it('is claiming (data-bearing) when a table has rows', () => {
    const table: UITableBlock = {
      type: 'table',
      columns: ['Name', 'Status'],
      rows: [['report.md', 'generated']],
    };
    expect(isUIBlockDataBearing(table)).toBe(true);
  });

  it('is decorative when a table has columns but zero rows', () => {
    const table: UITableBlock = {
      type: 'table',
      columns: ['Name', 'Status'],
      rows: [],
    };
    expect(isUIBlockDataBearing(table)).toBe(false);
  });

  it('a code block is always decorative — inert text, not structured data', () => {
    const code: UICodeBlock = {
      type: 'code',
      code: 'npm run verify:static',
    };
    expect(isUIBlockDataBearing(code)).toBe(false);
    expect(deriveUIBlockAttestationState(code)).toBe('decorative');
  });

  it('a form block is always decorative — requests input, does not claim it', () => {
    const form: UIFormBlock = {
      type: 'form',
      fields: [{ name: 'reviewer', label: 'Reviewer', type: 'text' }],
    };
    expect(isUIBlockDataBearing(form)).toBe(false);
    expect(deriveUIBlockAttestationState(form)).toBe('decorative');
  });
});

describe('deriveUIBlockAttestationState — all three cases', () => {
  it('derives decorative for a block with no data claims', () => {
    const card: UICardBlock = { type: 'card', body: 'hello' };
    expect(deriveUIBlockAttestationState(card)).toBe('decorative');
  });

  it('derives unattested for a claiming block with no derivedFrom', () => {
    const card: UICardBlock = {
      type: 'card',
      body: 'hello',
      fields: [{ label: 'Coverage', value: '98%' }],
    };
    expect(deriveUIBlockAttestationState(card)).toBe('unattested');
  });

  it('derives attested for a claiming block with derivedFrom present', () => {
    const card: UICardBlock = {
      type: 'card',
      body: 'hello',
      fields: [{ label: 'Coverage', value: '98%' }],
      derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
    };
    expect(deriveUIBlockAttestationState(card)).toBe('attested');
  });

  it('never trusts a pre-existing attestationState on the input — always recomputes', () => {
    const lyingCard = {
      type: 'card',
      body: 'hello',
      fields: [{ label: 'Coverage', value: '98%' }],
      attestationState: 'attested',
    } as UICardBlock;
    // No derivedFrom despite the (fabricated) claimed attestationState.
    expect(deriveUIBlockAttestationState(lyingCard)).toBe('unattested');
  });
});

describe('assertUIBlockProvenanceAccepted — the refusal gate', () => {
  it('accepts a decorative block regardless of derivedFrom/declaration', () => {
    const card: UICardBlock = { type: 'card', body: 'hello' };
    expect(() =>
      assertUIBlockProvenanceAccepted(card, undefined),
    ).not.toThrow();
  });

  it('refuses a fabricated-value-no-source claiming block', () => {
    const card: UICardBlock = {
      type: 'card',
      body: 'hello',
      fields: [{ label: 'Coverage', value: '98%' }],
    };
    expect(() => assertUIBlockProvenanceAccepted(card, undefined)).toThrow(
      UIBlockProvenanceRefusedError,
    );
    expect(() => assertUIBlockProvenanceAccepted(card, undefined)).toThrow(
      /requires 'derivedFrom' source references/,
    );
  });

  it('refuses a self-declared decorative flag on a data-bearing block, even with derivedFrom present', () => {
    const table: UITableBlock = {
      type: 'table',
      columns: ['Name'],
      rows: [['report.md']],
      derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
    };
    expect(() => assertUIBlockProvenanceAccepted(table, 'decorative')).toThrow(
      UIBlockProvenanceRefusedError,
    );
    expect(() => assertUIBlockProvenanceAccepted(table, 'decorative')).toThrow(
      /cannot declare itself 'decorative'/,
    );
  });

  it('accepts a claiming block with derivedFrom and no self-declaration', () => {
    const table: UITableBlock = {
      type: 'table',
      columns: ['Name'],
      rows: [['report.md']],
      derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
    };
    expect(() =>
      assertUIBlockProvenanceAccepted(table, undefined),
    ).not.toThrow();
  });
});

describe('normalizeUIBlockSourceRefs', () => {
  it('is stable under source-order permutation', () => {
    const a = { kind: 'toolCallId', toolCallId: 'call_1' } as const;
    const b = { kind: 'messageId', messageId: 'msg_1' } as const;
    const c = { kind: 'fileDigest', path: 'README.md', digest: 'abc' } as const;

    expect(normalizeUIBlockSourceRefs([a, b, c])).toEqual(
      normalizeUIBlockSourceRefs([c, b, a]),
    );
  });

  it('dedupes an identical repeated ref', () => {
    const a = { kind: 'toolCallId', toolCallId: 'call_1' } as const;
    expect(normalizeUIBlockSourceRefs([a, { ...a }])).toHaveLength(1);
  });

  it('keeps distinct refs of the same kind', () => {
    const a = { kind: 'toolCallId', toolCallId: 'call_1' } as const;
    const b = { kind: 'toolCallId', toolCallId: 'call_2' } as const;
    expect(normalizeUIBlockSourceRefs([a, b])).toHaveLength(2);
  });

  // station#1399 fix round, H3 (independent review): the OLD sort key was
  // `` `fileDigest ${path} ${digest}` `` — a hand-joined string whose
  // delimiter (a space) can also appear INSIDE a field value. These two
  // refs joined to the IDENTICAL string "fileDigest a b c" under that
  // scheme, so normalizing [refA, refB] silently dropped one as a
  // "duplicate" (reproduced: the array reduced from 2 entries to 1).
  it('does not collide two structurally different refs across a field boundary (delimiter-injection pair)', () => {
    const refA = { kind: 'fileDigest', path: 'a', digest: 'b c' } as const;
    const refB = { kind: 'fileDigest', path: 'a b', digest: 'c' } as const;

    const normalized = normalizeUIBlockSourceRefs([refA, refB]);

    expect(normalized).toHaveLength(2);
    expect(normalized).toEqual(expect.arrayContaining([refA, refB]));
  });

  it('is stable under source-order permutation even for the ambiguous ref pair', () => {
    const refA = { kind: 'fileDigest', path: 'a', digest: 'b c' } as const;
    const refB = { kind: 'fileDigest', path: 'a b', digest: 'c' } as const;
    const refC = { kind: 'toolCallId', toolCallId: 'call_1' } as const;

    expect(normalizeUIBlockSourceRefs([refA, refB, refC])).toEqual(
      normalizeUIBlockSourceRefs([refC, refB, refA]),
    );
    expect(normalizeUIBlockSourceRefs([refA, refB, refC])).toEqual(
      normalizeUIBlockSourceRefs([refB, refC, refA]),
    );
  });
});

describe('parseUIBlockSourceRefs — semantic validation (station#1399 fix round, M5)', () => {
  it('drops an empty (or whitespace-only) toolCallId', () => {
    expect(
      parseUIBlockSourceRefs([{ kind: 'toolCallId', toolCallId: '' }]),
    ).toEqual([]);
    expect(
      parseUIBlockSourceRefs([{ kind: 'toolCallId', toolCallId: '   ' }]),
    ).toEqual([]);
  });

  it('drops an empty messageId', () => {
    expect(
      parseUIBlockSourceRefs([{ kind: 'messageId', messageId: '' }]),
    ).toEqual([]);
  });

  it('drops a fileDigest with an empty path', () => {
    expect(
      parseUIBlockSourceRefs([
        { kind: 'fileDigest', path: '', digest: 'a'.repeat(64) },
      ]),
    ).toEqual([]);
  });

  it('drops a fileDigest whose digest is not 64-char lowercase hex', () => {
    expect(
      parseUIBlockSourceRefs([
        { kind: 'fileDigest', path: 'README.md', digest: 'not-a-digest' },
      ]),
    ).toEqual([]);
    expect(
      parseUIBlockSourceRefs([
        // uppercase hex — the host only ever emits lowercase.
        { kind: 'fileDigest', path: 'README.md', digest: 'A'.repeat(64) },
      ]),
    ).toEqual([]);
    expect(
      parseUIBlockSourceRefs([
        // one char short of a real SHA-256 hex digest.
        { kind: 'fileDigest', path: 'README.md', digest: 'a'.repeat(63) },
      ]),
    ).toEqual([]);
  });

  it('accepts a fileDigest with a genuine 64-char lowercase hex digest', () => {
    expect(
      parseUIBlockSourceRefs([
        { kind: 'fileDigest', path: 'README.md', digest: 'a'.repeat(64) },
      ]),
    ).toEqual([
      { kind: 'fileDigest', path: 'README.md', digest: 'a'.repeat(64) },
    ]);
  });

  it('drops a binding with a negative revision', () => {
    expect(
      parseUIBlockSourceRefs([
        { kind: 'binding', bindingId: 'widget-1', revision: -1 },
      ]),
    ).toEqual([]);
  });

  it('drops a binding with a non-integer revision', () => {
    expect(
      parseUIBlockSourceRefs([
        { kind: 'binding', bindingId: 'widget-1', revision: 1.5 },
      ]),
    ).toEqual([]);
  });

  it('accepts a binding with revision 0 (non-negative integer boundary)', () => {
    expect(
      parseUIBlockSourceRefs([
        { kind: 'binding', bindingId: 'widget-1', revision: 0 },
      ]),
    ).toEqual([{ kind: 'binding', bindingId: 'widget-1', revision: 0 }]);
  });

  it('a semantically-invalid-only source list leaves a data-bearing block unattested, not attested', () => {
    const card: UICardBlock = {
      type: 'card',
      body: 'hello',
      fields: [{ label: 'Coverage', value: '98%' }],
      derivedFrom: parseUIBlockSourceRefs([
        { kind: 'toolCallId', toolCallId: '' },
        { kind: 'binding', bindingId: 'x', revision: -1 },
      ]),
    };
    expect(deriveUIBlockAttestationState(card)).toBe('unattested');
  });
});
