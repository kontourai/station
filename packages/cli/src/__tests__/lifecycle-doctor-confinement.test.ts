/**
 * #4774: `station doctor` reports the selected Station's confinement
 * preflight, through the real reader and the real report, with only the
 * Station's HTTP answer (and target/credential selection) injected. A
 * preflight that was not obtained is a `warn` "Not checked" row, never
 * `pass`.
 */
import type { ConfinementPreflight } from '@kontourai/station-contracts/execution-confinement';
import { describe, expect, test, vi } from 'vitest';
import {
  CONFINEMENT_PREFLIGHT_PATH,
  type ConfinementPreflightReaderDeps,
  readStationConfinementPreflight,
} from '../commands/doctor-confinement-reader.js';
import {
  collectDoctorReport,
  type DoctorDeps,
  doctorJson,
} from '../commands/lifecycle-doctor.js';

const SECRET = 'sk-ant-fixture-secret-0123456789abcdef';
const HOST_PATH = '/Users/someone/.station/confined-homes/claude';

function stubDeps(overrides: Partial<DoctorDeps> = {}): Partial<DoctorDeps> {
  return {
    exec: vi.fn(() => null),
    checkOllama: vi.fn(async () => false),
    readJson: <T>(_path: string, fallback: T) => fallback,
    exists: vi.fn(() => false),
    env: {},
    projectHome: '/nonexistent/project-home',
    repoRoot: '/nonexistent/repo-root',
    inspectKontourDependencies: vi.fn(() => ({
      exactPins: [],
      mismatches: [],
    })),
    inspectSupervisorWedges: vi.fn(async () => []),
    inspectShellHosts: vi.fn(() => []),
    probeTerminalPty: vi.fn(() => ({ state: 'available' as const })),
    loadManagedPolicy: vi.fn(() => null),
    ...overrides,
  };
}

const SCOPE = 'starts-without-own-credential-profile';
const SCOPE_TEXT =
  "This covers starts that name no credential profile of their own (the claude connection's active credential profile or app-home setting applies); an Agent with its own credential profile, or a credential-recovery restart, is decided at start.";

const DECIDED_AT_START = [
  'workspace-too-broad',
  'config-root-pinned',
  'resume-bound-elsewhere',
];

const CODEX = {
  engine: 'codex',
  mechanism: 'codex-sandbox',
  level: 'os-profile',
  mechanismState: 'engine-reported',
  mechanismReason:
    "Codex applies its own sandbox; Station reads it back from Codex's thread response",
  confinedAuthentication: {
    state: 'not-applicable',
    reason: 'No confined-credential check applies to codex starts.',
  },
};

function preflight(claude: Record<string, unknown>): ConfinementPreflight {
  return {
    engines: [
      CODEX,
      {
        engine: 'claude',
        mechanism: 'seatbelt',
        level: 'os-profile',
        ...claude,
      },
    ],
    decidedAtStart: DECIDED_AT_START,
  } as ConfinementPreflight;
}

const MECHANISM_UNAVAILABLE = preflight({
  mechanismState: 'unavailable',
  mechanismReason: 'Seatbelt is macOS-only; this host is linux',
  confinedAuthentication: {
    state: 'available',
    source: 'environment',
    appliesTo: SCOPE,
  },
});
const BOTH_AVAILABLE = preflight({
  mechanismState: 'available',
  mechanismReason: 'the Seatbelt profile applies on this host',
  confinedAuthentication: {
    state: 'available',
    source: 'config-dir',
    appliesTo: SCOPE,
  },
});
const CREDENTIAL_UNAVAILABLE = preflight({
  mechanismState: 'available',
  mechanismReason: 'the Seatbelt profile applies on this host',
  confinedAuthentication: {
    state: 'unavailable',
    fallback: 'confined-credential-unavailable',
    remedy: 'Set ANTHROPIC_API_KEY in the Claude connection environment.',
    appliesTo: SCOPE,
  },
});

function readerDeps(
  answer: () => Promise<Response>,
  overrides: Omit<
    Partial<ConfinementPreflightReaderDeps>,
    'fetchPreflight'
  > = {},
) {
  const fetchPreflight = vi.fn(
    (_url: string, _signal: AbortSignal): Promise<Response> => answer(),
  );
  return {
    resolveTarget: () => ({
      apiBase: 'http://127.0.0.1:43141',
      source: 'default-station' as const,
      station: 'laptop',
    }),
    hasCredential: () => true,
    configureCredential: () => true,
    ...overrides,
    fetchPreflight,
  };
}

function answering(body: unknown, status = 200) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

async function reportFor(deps: Partial<ConfinementPreflightReaderDeps>) {
  return collectDoctorReport(
    stubDeps({
      inspectConfinement: () => readStationConfinementPreflight([], deps),
    }),
  );
}

function confinementRows(
  report: Awaited<ReturnType<typeof collectDoctorReport>>,
) {
  return report.checks.filter((check) =>
    /^(Confinement|Confined credential)/.test(check.label),
  );
}

describe('#4774: station doctor reports the Station confinement preflight', () => {
  test("mechanism unavailable: a warn row naming the Station's host; the credential row says it is moot there", async () => {
    const deps = readerDeps(answering(MECHANISM_UNAVAILABLE));
    const report = await reportFor(deps);
    expect(deps.fetchPreflight).toHaveBeenCalledWith(
      `http://127.0.0.1:43141${CONFINEMENT_PREFLIGHT_PATH}`,
      expect.any(AbortSignal),
    );
    expect(confinementRows(report)).toEqual([
      {
        label: 'Confinement mechanism (codex: codex-sandbox)',
        status: 'warn',
        detail: expect.stringMatching(/^Decided by the engine at start/),
      },
      {
        label: 'Confinement mechanism (claude: seatbelt)',
        status: 'warn',
        detail:
          'Unavailable on the host of Station "laptop": Seatbelt is macOS-only; this host is linux. A claude start that requires os-profile confinement is refused there.',
      },
      {
        label: 'Confined credential (claude)',
        status: 'warn',
        detail: `Moot on the host of Station "laptop": seatbelt is unavailable there, so a claude start that requires os-profile confinement is refused before any credential is checked. The credential check itself finds one. ${SCOPE_TEXT}`,
      },
    ]);
    expect(confinementRows(report)[2].detail).not.toContain('runs at Auto');
    expect(report.confinement).toEqual({
      checked: true,
      target: { station: 'laptop', source: 'default-station' },
      preflight: MECHANISM_UNAVAILABLE,
    });
  });

  test('mechanism and credential available: both Claude rows pass', async () => {
    const report = await reportFor(readerDeps(answering(BOTH_AVAILABLE)));
    const rows = confinementRows(report).filter((row) =>
      row.label.includes('claude'),
    );
    expect(rows.map((row) => row.status)).toEqual(['pass', 'pass']);
    expect(rows[0].detail).toBe(
      'Available on the host of Station "laptop": the Seatbelt profile applies on this host.',
    );
    expect(rows[1].detail).toBe(
      `A credential a confined start can use is enrolled in Station's confined configuration. ${SCOPE_TEXT}`,
    );
  });

  test('credential unavailable: a warn row naming the fallback and the remedy', async () => {
    const report = await reportFor(
      readerDeps(answering(CREDENTIAL_UNAVAILABLE)),
    );
    expect(
      confinementRows(report).find(
        (row) => row.label === 'Confined credential (claude)',
      ),
    ).toEqual({
      label: 'Confined credential (claude)',
      status: 'warn',
      detail: `None a confined start can use (confined-credential-unavailable): a start that asks for confinement runs at Auto with nothing engaged. Set ANTHROPIC_API_KEY in the Claude connection environment. ${SCOPE_TEXT}`,
    });
    // Warn-level only: confinement does not change readiness or exit.
    expect(
      confinementRows(report).some((check) => check.status === 'fail'),
    ).toBe(false);
  });

  test('no Station server answering: one warn "Not checked" row and nothing passes', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    const report = await reportFor(
      readerDeps(async () => {
        throw refused;
      }),
    );
    expect(confinementRows(report)).toEqual([
      {
        label: 'Confinement preflight',
        status: 'warn',
        detail: expect.stringMatching(
          /^Not checked: Station "laptop": no Station server answered \(ECONNREFUSED\)/,
        ),
      },
    ]);
    expect(report.confinement).toMatchObject({ checked: false });
  });

  test.each([
    [404, /does not report a confinement preflight \(HTTP 404\); update it/],
    [500, /could not answer \(HTTP 500\)/],
    [403, /refused this CLI's credential \(HTTP 403\)/],
  ])(
    'HTTP %i from the Station: not checked, with the reason',
    async (status, reason) => {
      const report = await reportFor(
        readerDeps(answering({ error: 'nope' }, status)),
      );
      const rows = confinementRows(report);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('warn');
      expect(rows[0].detail).toMatch(/^Not checked: /);
      expect(rows[0].detail).toMatch(reason);
    },
  );

  test('an answer that is not a preflight: not checked', async () => {
    const report = await reportFor(
      readerDeps(
        answering({ engines: [{ engine: 'claude', mechanismState: 'great' }] }),
      ),
    );
    expect(confinementRows(report)).toEqual([
      expect.objectContaining({
        status: 'warn',
        detail: expect.stringContaining('other than a confinement preflight'),
      }),
    ]);
  });

  test('no credential held: not checked, and the Station is never asked', async () => {
    const deps = readerDeps(answering(BOTH_AVAILABLE), {
      hasCredential: () => false,
    });
    const report = await reportFor(deps);
    expect(deps.fetchPreflight).not.toHaveBeenCalled();
    expect(confinementRows(report)).toEqual([
      expect.objectContaining({
        status: 'warn',
        detail: expect.stringContaining(
          'holds no credential for Station "laptop"',
        ),
      }),
    ]);
  });

  test('a credential that cannot be used (an empty --credential): not checked, not a crash', async () => {
    const deps = readerDeps(answering(BOTH_AVAILABLE), {
      configureCredential: () => {
        throw new Error('--credential requires a non-empty value.');
      },
    });
    const report = await reportFor(deps);
    expect(deps.fetchPreflight).not.toHaveBeenCalled();
    expect(confinementRows(report)).toEqual([
      expect.objectContaining({
        status: 'warn',
        detail:
          'Not checked: the credential for Station "laptop" cannot be used: --credential requires a non-empty value.',
      }),
    ]);
  });

  test('the real target and credential selection: an empty --credential is not checked', async () => {
    const result = await readStationConfinementPreflight([
      '--api-base=http://127.0.0.1:9',
      '--credential=',
    ]);
    expect(result).toMatchObject({
      checked: false,
      reason: expect.stringContaining(
        '--credential requires a non-empty value',
      ),
    });
  });

  test('a Station that cannot be selected: not checked, not a crash', async () => {
    const report = await reportFor(
      readerDeps(answering(BOTH_AVAILABLE), {
        resolveTarget: () => {
          throw new Error('No Station named "nope".');
        },
      }),
    );
    expect(confinementRows(report)).toEqual([
      expect.objectContaining({
        status: 'warn',
        detail:
          'Not checked: no Station could be selected: No Station named "nope".',
      }),
    ]);
  });

  test('without an inspector (the server diagnostics callers) the report has no confinement rows or field', async () => {
    const report = await collectDoctorReport(stubDeps());
    expect(confinementRows(report)).toEqual([]);
    expect('confinement' in report).toBe(false);
  });

  test('--json carries the preflight fields, with no credential content or host path', async () => {
    const leaky = preflight({
      mechanismState: 'unavailable',
      mechanismReason: `the Seatbelt profile could not be probed (EACCES '${HOST_PATH}') ${SECRET}`,
      confinedAuthentication: {
        state: 'unverified',
        reason: `profile at ${HOST_PATH} failed with ${SECRET}`,
        appliesTo: SCOPE,
      },
    });
    const write = vi.fn();
    await doctorJson(
      { write, setExitCode: vi.fn(), now: () => new Date(0) },
      stubDeps({
        inspectConfinement: () =>
          readStationConfinementPreflight([], readerDeps(answering(leaky))),
      }),
    );
    const text = write.mock.calls[0][0] as string;
    const document = JSON.parse(text);
    expect(document.report.confinement).toMatchObject({
      checked: true,
      preflight: {
        decidedAtStart: DECIDED_AT_START,
        engines: [
          { engine: 'codex', mechanismState: 'engine-reported' },
          {
            engine: 'claude',
            mechanism: 'seatbelt',
            mechanismState: 'unavailable',
            confinedAuthentication: { state: 'unverified', appliesTo: SCOPE },
          },
        ],
      },
    });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(HOST_PATH);
    expect(text).not.toContain('/Users/someone');
  });

  describe('a hostile or older Station', () => {
    const ESCAPES = '\u001b[2J\u001b[31m';

    async function rowsFor(body: unknown) {
      const report = await reportFor(readerDeps(answering(body)));
      return { report, rows: confinementRows(report) };
    }

    function expectNotChecked(
      result: Awaited<ReturnType<typeof rowsFor>>,
    ): void {
      expect(result.rows).toEqual([
        {
          label: 'Confinement preflight',
          status: 'warn',
          detail:
            'Not checked: Station "laptop" answered with something other than a confinement preflight.',
        },
      ]);
      expect(result.report.confinement).toMatchObject({ checked: false });
    }

    test('an engine id carrying a path and terminal escapes: not checked, never a row label', async () => {
      const engine = `/Users/jane/.station/x ${ESCAPES}FAKE PASS`;
      const result = await rowsFor({
        ...BOTH_AVAILABLE,
        engines: [{ ...BOTH_AVAILABLE.engines[1], engine }],
      });
      expectNotChecked(result);
      expect(JSON.stringify(result.report)).not.toContain('FAKE PASS');
    });

    test('a flood of decided-at-start entries: not checked', async () => {
      expectNotChecked(
        await rowsFor({
          ...BOTH_AVAILABLE,
          decidedAtStart: Array.from(
            { length: 100_000 },
            () => 'workspace-too-broad',
          ),
        }),
      );
    });

    test('a repeated decided-at-start entry: not checked', async () => {
      expectNotChecked(
        await rowsFor({
          ...BOTH_AVAILABLE,
          decidedAtStart: ['workspace-too-broad', 'workspace-too-broad'],
        }),
      );
    });

    test('a checked credential without its scope (an older answer): not checked', async () => {
      expectNotChecked(
        await rowsFor(
          preflight({
            mechanismState: 'available',
            mechanismReason: 'ok',
            confinedAuthentication: {
              state: 'available',
              source: 'config-dir',
            },
          }),
        ),
      );
    });

    test('control characters and escapes in reason text are removed from rows and --json', async () => {
      const hostile = preflight({
        mechanismState: 'unavailable',
        mechanismReason: `probe ${ESCAPES}failed\u0007\u001b]0;title\u0007 here\u202e`,
        confinedAuthentication: {
          state: 'unverified',
          reason: `could not ${ESCAPES}read\u0000 it`,
          appliesTo: SCOPE,
        },
      });
      const deps = readerDeps(answering(hostile), {
        resolveTarget: () => ({
          apiBase: 'http://127.0.0.1:43141',
          source: 'default-station' as const,
          station: `lap${ESCAPES}top`,
        }),
      });
      const report = await reportFor(deps);
      const rows = confinementRows(report).filter((row) =>
        row.label.includes('claude'),
      );
      expect(rows[0].detail).toBe(
        'Unavailable on the host of Station "laptop": probe failed here. A claude start that requires os-profile confinement is refused there.',
      );
      expect(rows[1].detail).toContain(
        'The credential check itself could not be completed.',
      );
      const write = vi.fn();
      await doctorJson(
        { write, setExitCode: vi.fn(), now: () => new Date(0) },
        stubDeps({
          inspectConfinement: () => readStationConfinementPreflight([], deps),
        }),
      );
      const text = write.mock.calls[0][0] as string;
      const document = JSON.parse(text);
      expect(document.report.confinement.target.station).toBe('laptop');
      expect(document.report.confinement.preflight.engines[1]).toMatchObject({
        mechanismReason: 'probe failed here',
        confinedAuthentication: { reason: 'could not read it' },
      });
      // Nothing of the sequences reaches either output.
      for (const output of [JSON.stringify(report.checks), text]) {
        expect(output).not.toMatch(/\\u001b|\\u0007|\\u0000|\\u202e/);
        expect(output).not.toContain('[2J');
        expect(output).not.toContain('title');
      }
    });
  });
});
