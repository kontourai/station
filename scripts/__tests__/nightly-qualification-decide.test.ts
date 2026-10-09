import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  decideQualifiedNightly,
  MIN_PUBLICATION_INTERVAL_MS,
  main,
  parseReservationRefs,
} from '../nightly-qualification-decide.mjs';

/**
 * Main qualification publishes a Nightly from the commit it just qualified,
 * at most about once a day. These cases drive the decision with rows in the
 * deploy ledger's real shape (copied from docs/reference/deploy-ledger.json)
 * and reservation lines in `git ls-remote --refs` output shape.
 */

const SOURCE = '1'.repeat(40);
const PEELED = '2'.repeat(40);
const SHIPPED = 'e7fb9b31'.padEnd(40, '0');
const OTHER = '3'.repeat(40);
const SHIPPED_AT = '2026-10-02T15:39:03Z';
const HOUR = 60 * 60 * 1000;

/** A real `nightly-desktop` row from the ledger, re-pointed at `sha`. */
function row(
  channel: string,
  sha: string,
  timestampUtc = SHIPPED_AT,
): Record<string, unknown> {
  return {
    timestampUtc,
    channel,
    version: '0.1.11-nightly.2466.3',
    sha,
    artifactBuiltAt: '2026-10-02T14:55:33.962Z',
    workflowRunUrl:
      'https://github.com/kontourai/station/actions/runs/37021990417',
    artifacts: ['github-release:nightly-desktop (cohort-finalized)'],
    gateResult: 'native cohort final receipt complete',
    notes: ['ios: TestFlight delivery success (run 37021990417)'],
    changelog: {
      previousSha: null,
      groups: { feat: [], fix: [], ci: [], docs: [], other: [] },
      note: null,
      commitCount: 0,
    },
  };
}

const reservation = (sha: string, code = '246603') =>
  `${sha}\trefs/tags/nightly-version-code/${code}\n`;

function decide(
  overrides: Partial<Parameters<typeof decideQualifiedNightly>[0]> = {},
) {
  return decideQualifiedNightly({
    sourceSha: SOURCE,
    candidateSha: SOURCE,
    ledgerEntries: [
      row('nightly-desktop', SHIPPED),
      row('nightly-android', SHIPPED),
    ],
    reservationRefs: reservation(SHIPPED),
    now: new Date(Date.parse(SHIPPED_AT) + 21 * HOUR),
    ...overrides,
  });
}

describe('decideQualifiedNightly', () => {
  it('defaults to a six-hour publication interval', () => {
    expect(MIN_PUBLICATION_INTERVAL_MS).toBe(21_600_000);
  });

  it('publishes a new source once the newest native ship is six hours old', () => {
    expect(decide().publish).toBe(true);
    expect(
      decide({ now: new Date(Date.parse(SHIPPED_AT) + 6 * HOUR) }).publish,
    ).toBe(true);
  });

  it('skips while the newest native ship is younger than six hours', () => {
    const decision = decide({
      now: new Date(Date.parse(SHIPPED_AT) + 6 * HOUR - 1000),
    });
    expect(decision.publish).toBe(false);
    expect(decision.reason).toMatch(/^published recently: /);
    // A clock behind the ledger never reads as old enough.
    expect(
      decide({ now: new Date(Date.parse(SHIPPED_AT) - HOUR) }).publish,
    ).toBe(false);
  });

  it('measures recency from the NEWEST native row, whatever the ledger order', () => {
    const decision = decide({
      ledgerEntries: [
        row('nightly-android', OTHER, '2026-09-30T06:00:00Z'),
        row('nightly-desktop', SHIPPED, SHIPPED_AT),
      ],
      now: new Date(Date.parse(SHIPPED_AT) + 2 * HOUR),
    });
    expect(decision.publish).toBe(false);
  });

  it('ignores CLI-only rows: this entry point cannot publish the CLI', () => {
    const decision = decide({
      ledgerEntries: [
        row('nightly-npm', SOURCE, SHIPPED_AT),
        row('nightly-android', SHIPPED, '2026-09-30T06:00:00Z'),
      ],
      now: new Date(Date.parse(SHIPPED_AT) + HOUR),
    });
    expect(decision.publish).toBe(true);
  });

  it('skips a source the ledger already records, even after the interval', () => {
    const decision = decide({
      sourceSha: SHIPPED,
      candidateSha: SHIPPED,
      now: new Date(Date.parse(SHIPPED_AT) + 72 * HOUR),
    });
    expect(decision).toEqual({
      publish: false,
      reason: `already published: the deploy ledger records nightly-desktop 0.1.11-nightly.2466.3 at ${SHIPPED}`,
    });
  });

  it('skips a ledger-only commit-back whose peeled source already shipped', () => {
    const decision = decide({
      candidateSha: SHIPPED,
      now: new Date(Date.parse(SHIPPED_AT) + 72 * HOUR),
    });
    expect(decision.publish).toBe(false);
    expect(decision.reason).toMatch(/^already published: /);
  });

  it('skips a source a Nightly already reserved, so a failure is not retried every six hours', () => {
    for (const reserved of [SOURCE, PEELED]) {
      const decision = decide({
        candidateSha: PEELED,
        reservationRefs: reservation(SHIPPED) + reservation(reserved, '246604'),
      });
      expect(decision.publish, reserved).toBe(false);
      expect(decision.reason).toContain(
        `refs/tags/nightly-version-code/246604 reserves ${reserved}`,
      );
    }
  });

  it('publishes the first Nightly when nothing native was ever recorded', () => {
    expect(decide({ ledgerEntries: [], reservationRefs: '' })).toEqual({
      publish: true,
      reason: 'no native Nightly has been recorded',
    });
  });

  it.each([
    ['a ledger that is not an array', { ledgerEntries: { entries: [] } }],
    [
      'a native row without a timestamp',
      { ledgerEntries: [row('nightly-android', SHIPPED, '')] },
    ],
    [
      'a native row with a local timestamp',
      {
        ledgerEntries: [row('nightly-android', SHIPPED, '2026-10-02 15:39:03')],
      },
    ],
    ['a malformed source SHA', { sourceSha: 'HEAD' }],
    ['an invalid clock', { now: new Date(Number.NaN) }],
    [
      'an annotated-tag peel line',
      {
        reservationRefs: `${SHIPPED}\trefs/tags/nightly-version-code/246603^{}\n`,
      },
    ],
    [
      'a reservation outside the namespace',
      { reservationRefs: `${SHIPPED}\trefs/tags/nightly\n` },
    ],
  ])('fails closed on %s', (_name, overrides) => {
    expect(() => decide(overrides as never)).toThrow();
  });
});

describe('parseReservationRefs', () => {
  it('reads the shape git ls-remote prints, ignoring the trailing newline', () => {
    expect(
      parseReservationRefs(
        `${reservation(SHIPPED, '246602')}${reservation(OTHER, '246603')}`,
      ),
    ).toEqual([
      { sha: SHIPPED, code: '246602' },
      { sha: OTHER, code: '246603' },
    ]);
  });
});

describe('nightly-qualification-decide CLI entry', () => {
  function capture() {
    const stdout: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    return {
      stdout,
      restore: () => {
        write.mockRestore();
        error.mockRestore();
      },
    };
  }

  const reservationsFile = resolve(
    import.meta.dirname,
    'fixtures/nightly-reservation-refs.txt',
  );

  it('peels ledger commit-backs up to the newest native ship before deciding', async () => {
    const inspected: string[] = [];
    const io = capture();
    let status: number;
    try {
      status = await main(
        ['--source-sha', SOURCE, '--reservation-refs', reservationsFile],
        {
          readLedger: () => [
            row('nightly-android', SHIPPED),
            row('nightly-desktop', SHIPPED),
          ],
          // SOURCE is a generated ledger commit whose parent is SHIPPED.
          inspectCommit: (_root: string, sha: string) => {
            inspected.push(sha);
            return {
              parents: [SHIPPED],
              subject:
                'docs(ledger): record nightly-android 0.1.11-nightly.2466.3 from run 37021990417',
              changedPaths: [
                'docs/reference/deploy-ledger.json',
                'docs/reference/deploy-ledger.md',
              ],
            };
          },
          now: new Date(Date.parse(SHIPPED_AT) + 72 * HOUR),
        },
      );
    } finally {
      io.restore();
    }
    expect(status).toBe(0);
    expect(inspected).toEqual([SOURCE]);
    expect(io.stdout.join('')).toContain('publish=false\nalready published');
  });

  it('exits nonzero and writes no publish= when an input is malformed', async () => {
    const io = capture();
    let status: number;
    try {
      status = await main(
        ['--source-sha', SOURCE, '--reservation-refs', reservationsFile],
        { readLedger: () => ({ entries: [] }) },
      );
    } finally {
      io.restore();
    }
    expect(status).toBe(1);
    expect(io.stdout.join('')).not.toContain('publish=');
  });

  it('rejects an incomplete argv', async () => {
    const io = capture();
    try {
      expect(await main(['--source-sha', SOURCE])).toBe(1);
    } finally {
      io.restore();
    }
  });
});

it('keeps its fixture rows in the real ledger shape', () => {
  // Bind the fixture to the writer's output, not to a shape this test chose.
  const ledger = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../docs/reference/deploy-ledger.json'),
      'utf8',
    ),
  ) as Array<Record<string, unknown>>;
  const real = ledger.find((entry) => entry.channel === 'nightly-desktop');
  expect(real).toBeDefined();
  expect(Object.keys(row('nightly-desktop', SHIPPED)).sort()).toEqual(
    Object.keys(real ?? {}).sort(),
  );
});
