import { describe, expect, it, vi } from 'vitest';
import {
  isGeneratedDeployLedgerCommit,
  main,
  normalizeDeployLedgerHead,
} from '../normalize-deploy-ledger-head.mjs';

const C_SHA = 'c'.repeat(40);
const L_SHA = 'd'.repeat(40);
const L2_SHA = 'e'.repeat(40);
const D_SHA = 'f'.repeat(40);
const LEDGER_PATHS = [
  'docs/reference/deploy-ledger.json',
  'docs/reference/deploy-ledger.md',
];

function generatedLedgerCommit(parent: string, overrides = {}) {
  return {
    parents: [parent],
    subject:
      'docs(ledger): record nightly-android 0.1.2-nightly.2432 from run 123',
    changedPaths: LEDGER_PATHS,
    ...overrides,
  };
}

function graph(entries: Record<string, unknown>) {
  return (sha: string) =>
    entries[sha] ?? { parents: [], subject: 'source', changedPaths: [] };
}

describe('deploy-ledger head normalization', () => {
  it.each(['Android', 'desktop'])(
    'reduces the %s workflow candidate from source C through ledger L',
    () => {
      // C ships and the rolling tag points to it. The record commit L then
      // advances main, so both nightly jobs must compare the normalized C.
      expect(
        normalizeDeployLedgerHead(
          L_SHA,
          graph({ [L_SHA]: generatedLedgerCommit(C_SHA) }),
        ),
      ).toBe(C_SHA);
    },
  );

  it('peels consecutive generated ledger commits along their direct parent chain', () => {
    expect(
      normalizeDeployLedgerHead(
        L2_SHA,
        graph({
          [L2_SHA]: generatedLedgerCommit(L_SHA, {
            subject:
              'docs(ledger): record nightly-desktop 0.1.2-nightly.2432 from run 124',
          }),
          [L_SHA]: generatedLedgerCommit(C_SHA),
        }),
      ),
    ).toBe(C_SHA);
  });

  it('stops the Android manual-rebuild comparison at a ledger-shaped rolling tag', () => {
    // A manual rebuild may tag L1 before a later ledger record L2 advances
    // main. The tag is authoritative, so L2 must normalize to L1, not C.
    expect(
      normalizeDeployLedgerHead(
        L2_SHA,
        graph({
          [L2_SHA]: generatedLedgerCommit(L_SHA),
          [L_SHA]: generatedLedgerCommit(C_SHA),
        }),
        L_SHA,
      ),
    ).toBe(L_SHA);
  });

  it('keeps a desktop bootstrap marker empty after peeling ledger commits', () => {
    // Empty is the explicit bootstrap marker, never a SHA to stop at. The
    // caller compares C to empty and builds, rather than skipping bootstrap.
    expect(
      normalizeDeployLedgerHead(
        L_SHA,
        graph({ [L_SHA]: generatedLedgerCommit(C_SHA) }),
        '',
      ),
    ).toBe(C_SHA);
  });

  it('does not suppress an arbitrary docs-only commit', () => {
    expect(
      normalizeDeployLedgerHead(
        D_SHA,
        graph({
          [D_SHA]: generatedLedgerCommit(C_SHA, {
            subject: 'docs: explain the deployment ledger',
          }),
        }),
      ),
    ).toBe(D_SHA);
  });

  it('does not traverse through a non-ledger commit to reach the rolling tag', () => {
    expect(
      normalizeDeployLedgerHead(
        D_SHA,
        graph({
          [D_SHA]: generatedLedgerCommit(L_SHA, {
            subject: 'docs: explain the deployment ledger',
          }),
          [L_SHA]: generatedLedgerCommit(C_SHA),
        }),
        C_SHA,
      ),
    ).toBe(D_SHA);
  });

  it.each([
    [
      'an extra changed path',
      { changedPaths: [...LEDGER_PATHS, 'docs/guide.md'] },
    ],
    ['one missing ledger path', { changedPaths: [LEDGER_PATHS[0]] }],
    ['a merge commit', { parents: [C_SHA, D_SHA] }],
    [
      'an unrecognized generated-looking subject',
      { subject: 'docs(ledger): record nightly-ios 1 from run 123' },
    ],
  ])('fails closed for %s', (_name, overrides) => {
    expect(
      isGeneratedDeployLedgerCommit(generatedLedgerCommit(C_SHA, overrides)),
    ).toBe(false);
    expect(
      normalizeDeployLedgerHead(
        L_SHA,
        graph({ [L_SHA]: generatedLedgerCommit(C_SHA, overrides) }),
      ),
    ).toBe(L_SHA);
  });

  it.each(['not-a-sha', 'A'.repeat(40)])(
    'fails closed for malformed stop SHA %s',
    (stopSha) => {
      expect(() =>
        normalizeDeployLedgerHead(
          L_SHA,
          graph({ [L_SHA]: generatedLedgerCommit(C_SHA) }),
          stopSha,
        ),
      ).toThrow(/stop SHA must be a 40-character lowercase hexadecimal SHA/);
    },
  );

  it('returns a nonzero CLI status for a malformed stop SHA', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        main(['--head-sha', L_SHA, '--stop-sha', 'not-a-sha'], {
          inspectCommit: graph({ [L_SHA]: generatedLedgerCommit(C_SHA) }),
        }),
      ).toBe(1);
    } finally {
      error.mockRestore();
    }
  });
});
