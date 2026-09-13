import { describe, expect, it, vi } from 'vitest';
import {
  decideNativeCohort,
  NATIVE_COHORT_PLATFORMS,
  NO_COHORT_NEEDED,
} from '../lib/nightly-cohort-decision.mjs';
import { main, parseArgs } from '../nightly-cohort-decide.mjs';

/**
 * #1780: the native cohort decision derives "shipped" from the deploy
 * ledger, never from marker position alone. A marker at HEAD without a
 * ledger row for that platform is a served-but-unverified release and must
 * rebuild.
 */

const HEAD = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);

function row(channel: string, sha: string, overrides = {}) {
  return {
    timestampUtc: '2026-09-07T09:30:00Z',
    channel,
    version: '0.1.2-nightly.2441',
    sha,
    workflowRunUrl: 'https://github.com/kontourai/station/actions/runs/1',
    artifacts: ['x'],
    gateResult: 'native cohort final receipt complete',
    notes: [],
    ...overrides,
  };
}

function atHead(overrides: { android?: string; macos?: string } = {}) {
  return {
    android: {
      markerSha: overrides.android ?? HEAD,
      candidateSha: HEAD,
    },
    macos: { markerSha: overrides.macos ?? HEAD, candidateSha: HEAD },
  };
}

describe('decideNativeCohort', () => {
  it('binds each platform to its marker and ledger channel', () => {
    expect(NATIVE_COHORT_PLATFORMS).toEqual([
      {
        platform: 'android',
        marker: 'refs/tags/nightly',
        channel: 'nightly-android',
      },
      {
        platform: 'macos',
        marker: 'refs/tags/nightly-desktop',
        channel: 'nightly-desktop',
      },
    ]);
  });

  it('needs no cohort when both markers are at HEAD and both platforms have a ledger row', () => {
    expect(
      decideNativeCohort({
        headSha: HEAD,
        platforms: atHead(),
        ledgerEntries: [
          row('nightly-desktop', HEAD),
          row('nightly-android', HEAD),
          row('nightly-npm', HEAD),
        ],
      }),
    ).toEqual({ build: false, reasons: [] });
  });

  it('builds when both markers are at HEAD but only Android has a ledger row (#1780 live state)', () => {
    // Run 34247229018: macOS moved nightly-desktop, its claim failed, the
    // final receipt was partial, and record-native-completion wrote the
    // Android row only. Marker-only comparison read this as shipped.
    const decision = decideNativeCohort({
      headSha: HEAD,
      platforms: atHead(),
      ledgerEntries: [
        row('nightly-android', HEAD, {
          gateResult: 'native cohort final receipt partial',
        }),
      ],
    });
    expect(decision.build).toBe(true);
    expect(decision.reasons).toEqual([
      `macos: marker at HEAD without a ledger row for this source (no nightly-desktop entry at ${HEAD})`,
    ]);
  });

  it('builds when both markers are at HEAD and only macOS has a ledger row', () => {
    const decision = decideNativeCohort({
      headSha: HEAD,
      platforms: atHead(),
      ledgerEntries: [row('nightly-desktop', HEAD)],
    });
    expect(decision.build).toBe(true);
    expect(decision.reasons).toEqual([
      `android: marker at HEAD without a ledger row for this source (no nightly-android entry at ${HEAD})`,
    ]);
  });

  it('counts a row written during a partial night as shipped for that platform', () => {
    // A row exists only for a platform the receipt verified; the gate text
    // names the cohort's state, not this platform's. The row is the evidence.
    expect(
      decideNativeCohort({
        headSha: HEAD,
        platforms: atHead(),
        ledgerEntries: [
          row('nightly-android', HEAD, {
            gateResult: 'native cohort final receipt partial',
          }),
          row('nightly-desktop', HEAD, {
            gateResult: 'native cohort final receipt partial',
          }),
        ],
      }),
    ).toEqual({ build: false, reasons: [] });
  });

  it('builds on a fresh repository with no rows and no markers', () => {
    const decision = decideNativeCohort({
      headSha: HEAD,
      platforms: {
        android: { markerSha: '', candidateSha: HEAD },
        macos: { markerSha: '', candidateSha: HEAD },
      },
      ledgerEntries: [],
    });
    expect(decision.build).toBe(true);
    expect(decision.reasons).toEqual([
      'android: refs/tags/nightly does not exist yet (bootstrap)',
      'macos: refs/tags/nightly-desktop does not exist yet (bootstrap)',
    ]);
  });

  it('builds when both markers are at HEAD but the ledger is empty', () => {
    const decision = decideNativeCohort({
      headSha: HEAD,
      platforms: atHead(),
      ledgerEntries: [],
    });
    expect(decision.build).toBe(true);
    expect(decision.reasons).toHaveLength(2);
    expect(decision.reasons[0]).toMatch(/^android: marker at HEAD without/);
    expect(decision.reasons[1]).toMatch(/^macos: marker at HEAD without/);
  });

  it.each(['android', 'macos'] as const)(
    'builds when the %s marker is behind HEAD even with both rows at HEAD',
    (platform) => {
      const decision = decideNativeCohort({
        headSha: HEAD,
        platforms: atHead({ [platform]: OLDER }),
        ledgerEntries: [
          row('nightly-android', HEAD),
          row('nightly-desktop', HEAD),
          row('nightly-android', OLDER),
          row('nightly-desktop', OLDER),
        ],
      });
      expect(decision.build).toBe(true);
      expect(decision.reasons).toEqual([
        `${platform}: ${platform === 'android' ? 'refs/tags/nightly' : 'refs/tags/nightly-desktop'} is at ${OLDER}, behind source ${HEAD}`,
      ]);
    },
  );

  it('does not accept a row at a different SHA as evidence for a marker at HEAD', () => {
    const decision = decideNativeCohort({
      headSha: HEAD,
      platforms: atHead(),
      ledgerEntries: [
        row('nightly-android', HEAD),
        row('nightly-desktop', OLDER),
      ],
    });
    expect(decision.build).toBe(true);
    expect(decision.reasons).toEqual([
      `macos: marker at HEAD without a ledger row for this source (no nightly-desktop entry at ${HEAD})`,
    ]);
  });

  it('does not accept another channel at the same SHA as evidence', () => {
    const decision = decideNativeCohort({
      headSha: HEAD,
      platforms: atHead(),
      ledgerEntries: [row('nightly-android', HEAD), row('nightly-npm', HEAD)],
    });
    expect(decision.build).toBe(true);
    expect(decision.reasons[0]).toMatch(/^macos: marker at HEAD without/);
  });

  it('builds for an explicit rebuild index even when both rows exist', () => {
    const decision = decideNativeCohort({
      headSha: HEAD,
      platforms: atHead(),
      ledgerEntries: [
        row('nightly-android', HEAD),
        row('nightly-desktop', HEAD),
      ],
      rebuildIndex: '2',
    });
    expect(decision.build).toBe(true);
    expect(decision.reasons).toEqual([
      'manual rebuild requested (rebuild_index=2)',
    ]);
  });

  it.each([
    ['not an array', { entries: [] }],
    ['a non-object entry', ['nightly-android']],
    ['an unknown channel', [row('nightly-ios', HEAD)]],
    ['a malformed sha', [row('nightly-android', 'abc')]],
    ['an uppercase sha', [row('nightly-android', 'A'.repeat(40))]],
    ['a missing channel', [row('nightly-android', HEAD, { channel: 7 })]],
  ])('fails closed when the ledger has %s', (_name, ledgerEntries) => {
    expect(() =>
      decideNativeCohort({
        headSha: HEAD,
        platforms: atHead(),
        ledgerEntries,
      }),
    ).toThrow(/deploy ledger/);
  });

  it.each<[string, Record<string, unknown>]>([
    ['head SHA', { headSha: 'nope' }],
    [
      'android candidate SHA',
      {
        platforms: {
          android: { markerSha: HEAD, candidateSha: '' },
          macos: { markerSha: HEAD, candidateSha: HEAD },
        },
      },
    ],
    [
      'macos marker SHA',
      {
        platforms: {
          android: { markerSha: HEAD, candidateSha: HEAD },
          macos: { markerSha: 'HEAD', candidateSha: HEAD },
        },
      },
    ],
    ['rebuild index', { rebuildIndex: 2 }],
  ])('fails closed for a malformed %s', (_name, overrides) => {
    expect(() =>
      decideNativeCohort({
        headSha: HEAD,
        platforms: atHead(),
        ledgerEntries: [
          row('nightly-android', HEAD),
          row('nightly-desktop', HEAD),
        ],
        ...overrides,
      } as Parameters<typeof decideNativeCohort>[0]),
    ).toThrow();
  });

  it('requires both platforms', () => {
    expect(() =>
      decideNativeCohort({
        headSha: HEAD,
        platforms: { android: { markerSha: HEAD, candidateSha: HEAD } },
        ledgerEntries: [],
      } as never),
    ).toThrow(/platforms\.macos is required/);
  });
});

describe('nightly-cohort-decide CLI', () => {
  const argv = (extra: string[] = []) => [
    '--head-sha',
    HEAD,
    '--android-marker',
    HEAD,
    '--android-candidate',
    HEAD,
    '--desktop-marker',
    HEAD,
    '--desktop-candidate',
    HEAD,
    ...extra,
  ];

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

  it('defaults the ledger ref to origin/main and rejects an incomplete argv', () => {
    expect(parseArgs(argv())).toMatchObject({
      ledgerRef: 'origin/main',
      rebuildIndex: '',
    });
    expect(parseArgs(argv().slice(0, -2))).toBeNull();
    expect(parseArgs(argv(['--head-sha', HEAD]))).toBeNull();
    expect(parseArgs(argv(['--unknown', 'x']))).toBeNull();
  });

  it('reads the ledger from the requested ref and emits build=true with the macOS reason', () => {
    const readLedger = vi.fn(() => [row('nightly-android', HEAD)]);
    const io = capture();
    try {
      expect(
        main(argv(['--ledger-ref', 'origin/main', '--repo-root', '/repo']), {
          readLedger,
        }),
      ).toBe(0);
    } finally {
      io.restore();
    }
    expect(readLedger).toHaveBeenCalledWith('/repo', 'origin/main');
    const output = io.stdout.join('');
    expect(output).toContain('build=true\n');
    expect(output).toContain(
      'macos: marker at HEAD without a ledger row for this source',
    );
  });

  it('emits build=false with the no-op summary when both rows exist', () => {
    const io = capture();
    try {
      expect(
        main(argv(), {
          readLedger: () => [
            row('nightly-android', HEAD),
            row('nightly-desktop', HEAD),
          ],
        }),
      ).toBe(0);
    } finally {
      io.restore();
    }
    const output = io.stdout.join('');
    expect(output).toContain('build=false\n');
    expect(output).toContain(NO_COHORT_NEEDED);
  });

  it('forwards the rebuild index', () => {
    const io = capture();
    try {
      expect(
        main(argv(['--rebuild-index', '3']), {
          readLedger: () => [
            row('nightly-android', HEAD),
            row('nightly-desktop', HEAD),
          ],
        }),
      ).toBe(0);
    } finally {
      io.restore();
    }
    expect(io.stdout.join('')).toContain('build=true\n');
    expect(io.stdout.join('')).toContain('rebuild_index=3');
  });

  it('exits nonzero and writes no build= when the ledger cannot be read or is malformed', () => {
    for (const readLedger of [
      () => {
        throw new Error(
          'git show origin/main:docs/reference/deploy-ledger.json failed',
        );
      },
      () => ({ entries: [] }),
    ]) {
      const io = capture();
      try {
        expect(main(argv(), { readLedger })).toBe(1);
      } finally {
        io.restore();
      }
      expect(io.stdout.join('')).not.toContain('build=');
    }
  });
});
