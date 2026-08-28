import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { describe, expect, test } from 'vitest';
import type { OrchestrationEvent } from '../hooks/orchestration/types';
import { mutableSessionTitle } from '../hooks/useMutableSessionDetailState';
import {
  engineLabelForProvider,
  sessionProjectLabel,
  sessionTitle,
} from '../utils/sessionDisplay';
import { buildOrchestrationItems } from '../views/home/home-view-model';

/**
 * archive#3227 A2/A3/A4 +.
 *
 * `sessionDisplay.ts` owns three derivations — the name a session is listed
 * under, the project it is attributed to, and the engine that ran it — and
 * every one of them had acquired private copies elsewhere that disagreed on
 * live shapes. This file pins the collapse: for each shape that used to
 * diverge, every surface that names it produces the canonical string.
 *
 * These are cross-surface assertions on purpose. A test that only exercised
 * `sessionTitle` would have stayed green through the whole defect — the
 * canonical helper was always right; what was wrong was that three other code
 * paths never called it.
 */

function session(
  overrides: Partial<OrchestrationSessionSummary>,
): OrchestrationSessionSummary {
  return {
    provider: 'claude',
    threadId: 'thread-1',
    status: 'ready',
    controlMode: 'station-owned',
    isLoaded: true,
    isPersisted: true,
    eventCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    answerability: { answerable: true },
    ...overrides,
  } satisfies OrchestrationSessionSummary as OrchestrationSessionSummary;
}

/** Home's row for one session, through the real producer. */
function homeRow(s: OrchestrationSessionSummary) {
  return buildOrchestrationItems([s], [])[0];
}

/**
 * The archive#3139 shape, exactly: an attached external session the server never
 * titled, whose thread id is a content-derived digest. `humanizeId` is a
 * NO-OP on it — it strips a leading `task[:-]?` and swaps `[-_]` for spaces,
 * and this string has none of those — which is what made the raw digest
 * reach a screen.
 */
const ATTACHED_UNTITLED = session({
  threadId: 'external:claude:5dfa9c8e1b2d4f6a8c0e2f4a6b8d0c2e',
  provider: 'claude',
  controlMode: 'read-only-attached',
});

const DELEGATED_WITH_TASK_ID = session({
  threadId: 'thread-delegated',
  provider: 'codex',
  delegation: { taskId: 'task:delegated-review' },
});

describe('A2/C1-C3: one session, one name', () => {
  test('the untitled attached session (#3139) is named by its engine everywhere', () => {
    const canonical = sessionTitle(ATTACHED_UNTITLED);
    expect(canonical).toBe('Claude Code session');

    // Home built `${agentLabel} task` here -> "Claude Code task".
    expect(homeRow(ATTACHED_UNTITLED).title).toBe(canonical);
    // The detail header returned `humanizeId(threadId) || threadId` -> the
    // raw digest. This is the assertion archive#3139 never got.
    expect(mutableSessionTitle(ATTACHED_UNTITLED, [])).toBe(canonical);
  });

  test('a delegated task reads as its readable task id everywhere', () => {
    const canonical = sessionTitle(DELEGATED_WITH_TASK_ID);
    expect(canonical).toBe('Worker task · delegated review');

    // Home stripped the prefix with a different regex and Title-Cased the
    // remainder -> "Delegated Review", a string that looks like a
    // human-written title but is a machine id.
    expect(homeRow(DELEGATED_WITH_TASK_ID).title).toBe(canonical);
    expect(mutableSessionTitle(DELEGATED_WITH_TASK_ID, [])).toBe(canonical);
  });

  test("the server's own display title outranks both, on every surface", () => {
    const titled = session({
      ...ATTACHED_UNTITLED,
      displayTitle: 'Ship the Home history fix',
    });
    expect(sessionTitle(titled)).toBe('Ship the Home history fix');
    expect(homeRow(titled).title).toBe('Ship the Home history fix');
    // The detail header never read `displayTitle` at all, which is precisely
    // how a NAMED row opened onto a header showing a raw thread id.
    expect(mutableSessionTitle(titled, [])).toBe('Ship the Home history fix');
  });

  test('the live feed’s own first prompt still outranks the summary in the detail header', () => {
    // The one deliberate divergence, and it is a strict refinement: the
    // header has the event stream, which no helper over a summary can see.
    const events = [
      { method: 'turn.started', prompt: '  Fix the flaky lane  ' },
    ] as unknown as OrchestrationEvent[];
    expect(mutableSessionTitle(ATTACHED_UNTITLED, events)).toBe(
      'Fix the flaky lane',
    );
  });
});

/**
 * The strongest form of the contract `sessionTitle`'s docblock states: "no
 * branch may return a raw thread id". Asserted over every rendering path that
 * names a session, for a thread id shape that no humanizer can improve.
 *
 * Written as a sweep rather than one case per shape so that ADDING a session
 * shape does not silently escape it: a new branch that forwards the thread id
 * fails here without anyone remembering to write the test for it.
 */
describe('A2: no naming path can return a raw thread id', () => {
  const DIGEST = '5dfa9c8e1b2d4f6a8c0e2f4a6b8d0c2e';
  const shapes: Array<[string, OrchestrationSessionSummary]> = [
    ['attached, untitled', ATTACHED_UNTITLED],
    [
      'delegated, no task id',
      session({ threadId: `external:codex:${DIGEST}`, provider: 'codex' }),
    ],
    [
      'delegated with a task id',
      session({
        threadId: `external:claude:${DIGEST}`,
        delegation: { taskId: 'task:review' },
      }),
    ],
    [
      'an engine this build has no name for',
      session({
        threadId: `external:mystery:${DIGEST}`,
        provider: 'mystery-plugin',
      }),
    ],
    [
      'terminal, no events, nothing known',
      session({
        threadId: DIGEST,
        provider: 'ollama',
        lifecycleState: 'completed',
      }),
    ],
  ];

  for (const [name, subject] of shapes) {
    test(`${name}: neither the list, Home, nor the detail header shows the digest`, () => {
      const names = [
        sessionTitle(subject),
        homeRow(subject).title,
        mutableSessionTitle(subject, []),
      ];
      for (const rendered of names) {
        expect(rendered).not.toContain(DIGEST);
        expect(rendered).not.toBe(subject.threadId);
        expect(rendered.trim()).not.toBe('');
      }
      // And they are not merely all non-raw — they are the SAME string.
      expect(new Set(names).size).toBe(1);
    });
  }
});

describe('A3: Home attributes a project the way the contract requires', () => {
  test('an ambiguous session names its candidates instead of reading "No project"', () => {
    const ambiguous = session({
      controlMode: 'read-only-attached',
      projectAttribution: { state: 'ambiguous', candidates: ['alpha', 'beta'] },
    });
    // `packages/contracts/src/orchestration.ts` forbids exactly the string
    // Home used to render here: "no project" when the truth is "too many".
    expect(homeRow(ambiguous).projectLabel).toBe('ambiguous (alpha, beta)');
    expect(homeRow(ambiguous).projectLabel).toBe(
      sessionProjectLabel(ambiguous),
    );
  });

  test('a bounded candidate list still counts what it omitted on a Home row', () => {
    const truncated = session({
      controlMode: 'read-only-attached',
      projectAttribution: {
        state: 'ambiguous',
        candidates: ['alpha', 'beta'],
        omittedCandidates: 4,
      },
    });
    expect(homeRow(truncated).projectLabel).toBe(
      'ambiguous (alpha, beta, and 4 more)',
    );
  });

  test('a cross-machine slug join keeps its caveat on a Home row', () => {
    // NOTE the shape: the server sets a session's top-level `projectSlug`
    // FROM `delegation.projectSlug` when there is one, so both are present.
    // Home read only the top-level one, so it showed the slug but SILENTLY
    // DROPPED the caveat — the row asserted a verified binding that this
    // Station cannot prove, while the sessions list one click away said the
    // name match was unverified.
    const delegated = session({
      projectSlug: 'station',
      delegation: {
        taskId: 'task-1',
        projectSlug: 'station',
        projectSlugJoin: 'unverified-cross-machine',
      },
    });
    expect(homeRow(delegated).projectLabel).toBe(
      'station (unverified name match)',
    );
  });

  test('a settled local binding gains no caveat', () => {
    expect(homeRow(session({ projectSlug: 'station' })).projectLabel).toBe(
      'station',
    );
  });

  test('only a session with nothing known folds to Home’s own copy', () => {
    expect(sessionProjectLabel(session({}))).toBeNull();
    expect(homeRow(session({})).projectLabel).toBe('No project');
  });
});

/**
 * archive#3227 A3 + the `activity-bars.tsx` / `PulseHomeVariant.tsx` grouping
 * key. This is the part of the change that is NOT display-only, so it is
 * pinned as behaviour rather than as copy.
 *
 * THE RULE, stated so it can be argued with: a project bar groups sessions
 * this Station can prove belong to the same project, and nothing else.
 * Fragmenting is the correct outcome, not a side effect to be smoothed over —
 * merging an `unverified-cross-machine` row into the local project's bar
 * would assert an identity the caveat exists to deny (slugs are locally
 * generated, so a cross-machine name match is a coincidence), and filing an
 * ambiguous session under one bar picks a winner the contract forbids picking.
 * The label carries its own caveat, so a reader looking at two similar bars
 * can see why they are two.
 */
describe('A3: Home’s project grouping keys off what is proven', () => {
  const local = session({ threadId: 't-local', projectSlug: 'station' });
  const localSecond = session({
    threadId: 't-local-2',
    projectSlug: 'station',
  });
  const unverified = session({
    threadId: 't-unverified',
    projectSlug: 'station',
    delegation: {
      taskId: 'task-1',
      projectSlug: 'station',
      projectSlugJoin: 'unverified-cross-machine',
    },
  });
  const ambiguous = session({
    threadId: 't-ambiguous',
    controlMode: 'read-only-attached',
    projectAttribution: { state: 'ambiguous', candidates: ['station', 'beta'] },
  });
  const unknown = session({ threadId: 't-unknown' });

  const keys = buildOrchestrationItems(
    [local, localSecond, unverified, ambiguous, unknown],
    [],
  ).map((item) => item.projectLabel);

  test('two sessions with the same proven binding share one key', () => {
    expect(keys[0]).toBe(keys[1]);
  });

  test('an unverified name match does not join the proven project’s bar', () => {
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[2]).toBe('station (unverified name match)');
  });

  test('an ambiguous session is neither filed under a candidate nor under "No project"', () => {
    expect(keys[3]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe('No project');
    expect(keys[3]).toContain('station');
    expect(keys[3]).toContain('beta');
  });

  test('only a genuinely unattributed session lands in the "No project" bar', () => {
    expect(keys[4]).toBe('No project');
    expect(keys.filter((key) => key === 'No project')).toHaveLength(1);
  });

  test('a settled binding’s key is the bare slug, so it groups with itself across surfaces', () => {
    expect(keys[0]).toBe('station');
  });
});

describe('A4/C5: one provider table', () => {
  /**
   * The four the audit named plus the two that already agreed (so the
   * agreement is pinned rather than assumed) and one this build has no name
   * for. `agentLabel` is the field Home reached the private table through:
   * it falls back to the provider only when no agent name and no assigned
   * slug resolve — i.e. exactly the attached/external population.
   */
  const cases: Array<[string, string]> = [
    ['claude', 'Claude Code'],
    ['codex', 'Codex'],
    ['acp', 'Custom engine'],
    // The four that disagreed. `bedrock`/`ollama`/`station-agent` are all
    // Station's OWN engine — Bedrock and Ollama are Model connections it
    // executes through — so Home naming them after the connection put the
    // word "Bedrock" beside a Station engine icon.
    ['muse', 'Muse Code'],
    ['station-agent', 'Station'],
    ['bedrock', 'Station'],
    ['ollama', 'Station'],
  ];

  for (const [provider, expected] of cases) {
    test(`${provider} is named "${expected}" on a Home row, as everywhere else`, () => {
      const subject = session({ provider });
      expect(engineLabelForProvider(provider)).toBe(expected);
      expect(homeRow(subject).agentLabel).toBe(expected);
      // A4 compounds A2: the title's engine fallback reads the same table.
      expect(homeRow(subject).title).toBe(`${expected} session`);
    });
  }

  test('an id this build has no name for shows the id, not an invented name', () => {
    // NOT in the audit, and the worst of the set: the private table
    // Title-Cased any unrecognised provider into a plausible-looking product
    // name ("unknown-plugin" -> "Unknown Plugin") for an adapter that may not
    // be called that at all. `engineLabelForProvider` returns null precisely
    // so callers fall back to the identifier they actually observed, which is
    // what `sessionIconAgent` already did beside this very row.
    expect(engineLabelForProvider('unknown-plugin')).toBeNull();
    expect(homeRow(session({ provider: 'unknown-plugin' })).agentLabel).toBe(
      'unknown-plugin',
    );
  });

  test('a resolved agent still outranks the engine name', () => {
    expect(
      buildOrchestrationItems(
        [
          session({
            provider: 'bedrock',
            assignedAgentSlug: 'planner' as never,
          }),
        ],
        [{ slug: 'planner', name: 'Planner' }] as never,
      )[0].agentLabel,
    ).toBe('Planner');
  });

  test('no provider at all still discloses that, rather than naming an engine', () => {
    expect(
      buildOrchestrationItems(
        [session({ provider: '' as unknown as string })],
        [],
      )[0].agentLabel,
    ).toBe('Agent not reported');
  });
});
