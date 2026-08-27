/**
 * THE ENFORCEMENT MECHANISM ITSELF (station#1778, ADR 0012 AC1).
 *
 * `answerability` is a REQUIRED member of `OrchestrationSessionSummary` and
 * of the two sibling wire shapes that re-declare the same lifecycle fields.
 * That is not a nicety: the consumer sweep recorded on station#1745 found
 * SIX independent emission routes for this shape and no natural choke point,
 * so nothing in the codebase can enumerate them — except the compiler.
 * "The sixteenth consumer is a compile error" is the property, and this file
 * is where it is pinned.
 *
 * These assertions run at TYPECHECK time, not at runtime: each
 * `@ts-expect-error` FAILS THE BUILD if the construction below starts
 * compiling — i.e. if someone makes the member optional, gives it a default,
 * or widens the negative arm so a claim can be made without saying whose
 * process observed it and when. `npm run typecheck:contracts` is the gate;
 * the runtime bodies exist so the file is a real, discoverable test rather
 * than a comment.
 */
import { describe, expect, test } from 'vitest';
import type {
  AgentRunSummary,
  ConversationListItem,
  OrchestrationSessionSummary,
  RequestAnswerability,
  SessionBoardItem,
} from '../orchestration.js';
import {
  normalizeRequestAnswerability,
  unanswerableRequestNotice,
  unknownAnswerabilityNotice,
} from '../orchestration.js';

const baseSummary = {
  provider: 'claude',
  threadId: 'thread-1',
  status: 'ready',
  controlMode: 'station-owned',
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:01.000Z',
  isLoaded: true,
  isPersisted: true,
  eventCount: 0,
} as const;

describe('answerability is a required member of every session wire shape', () => {
  test('an undecorated session summary does not compile', () => {
    // @ts-expect-error station#1778 AC1: omitting `answerability` is the
    // sixteenth consumer, and it must be a compile error rather than a
    // summary that silently carries the pre-decoration answer.
    const undecorated: OrchestrationSessionSummary = { ...baseSummary };
    const decorated: OrchestrationSessionSummary = {
      ...baseSummary,
      answerability: { answerable: true },
    };
    // Runtime half: the shapes are otherwise identical, so the ONLY thing
    // the type error above is reacting to is the missing member.
    expect(Object.keys(decorated)).toEqual([
      ...Object.keys(undecorated),
      'answerability',
    ]);
  });

  test('an undecorated session-board item does not compile', () => {
    const item = {
      sessionId: 'thread-1',
      provider: 'claude',
      controlMode: 'station-owned',
      runtimeKind: 'claude',
      agentType: 'station',
      lifecycleState: 'running',
      pendingReview: false,
      projectSlug: 'demo',
      status: 'ready',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:01.000Z',
      isLoaded: true,
      isPersisted: true,
      eventCount: 0,
      retryEligible: false,
      openHref: '/projects/demo?chat=thread-1',
    } as const;
    // @ts-expect-error The board is one of at least three projections layered
    // over `listSessionReadModel`; an undecorated one would re-open exactly
    // the divergence ADR 0012 closes.
    const undecorated: SessionBoardItem = { ...item };
    expect(undecorated.sessionId).toBe('thread-1');
  });

  test('an undecorated agent-run summary does not compile', () => {
    const run = {
      runId: 'thread-1',
      sessionId: 'thread-1',
      providerId: 'claude',
      source: 'orchestration',
      engineExecution: 'station',
      status: 'waiting_for_approval',
      startedAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:01.000Z',
      retryEligible: false,
      attempt: 1,
      eventCount: 0,
    } as const;
    // @ts-expect-error The third sibling shape ADR 0012 names. Its `status`
    // folds `waiting_for_approval` from the same raw open-request evidence,
    // so an undecorated run is a consumer with no way to know nothing can
    // answer it. Its absence from this file is what let the member be made
    // optional with every suite still green (delta-review fix round, F1).
    const undecorated: AgentRunSummary = { ...run };
    expect(undecorated.runId).toBe('thread-1');
  });

  test('an undecorated conversation-inventory item does not compile', () => {
    const item = {
      id: 'thread-1',
      source: 'runtime',
      agentSlug: 'station',
      title: 'chat',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:01.000Z',
      messageCount: 1,
      mutable: false,
    } as const;
    // @ts-expect-error `useConversationInventoryQuery`'s consumers fold the
    // same lifecycle fields; an undecorated item exempts them all.
    const undecorated: ConversationListItem = { ...item };
    expect(undecorated.id).toBe('thread-1');
  });
});

describe('the unanswerable arm cannot be claimed without its basis', () => {
  test('a bare `answerable: false` does not compile', () => {
    // @ts-expect-error A boolean alone is a LABEL: timeless and universal,
    // where the truth is "the serving process held no adapter for it at T".
    const bare: RequestAnswerability = { answerable: false };
    expect(bare.answerable).toBe(false);
  });

  test('a qualification without whose-process-and-when does not compile', () => {
    // @ts-expect-error Naming the arm is not enough; two Station instances
    // sharing `~/.station` must be distinguishable in their own answers.
    const unattributed: RequestAnswerability = {
      answerable: false,
      qualification: 'provider_absent',
    };
    expect(unattributed.answerable).toBe(false);
  });

  test('a qualification outside the producer vocabulary does not compile', () => {
    // The vocabulary is fixed by the arms `projectRequestAnswerability`
    // actually computes. A term no arm produces is a claim nothing derives.
    const minted: RequestAnswerability = {
      answerable: false,
      // @ts-expect-error `provider_crashed` is not a qualification anything
      // in this codebase derives.
      qualification: 'provider_crashed',
      observedBy: 'station-a#1',
      observedAt: '2026-08-03T00:00:00.000Z',
    };
    expect(minted.answerable).toBe(false);
  });

  test('the fully-stated negative arm does compile, and carries the basis', () => {
    const stated: RequestAnswerability = {
      answerable: false,
      qualification: 'provider_absent',
      observedBy: 'station-a#1',
      observedAt: '2026-08-03T00:04:03.000Z',
    };
    // The positive control for every `@ts-expect-error` above: if the type
    // were simply broken, this would fail to compile too and the negatives
    // would be proving nothing.
    expect(stated).toEqual({
      answerable: false,
      qualification: 'provider_absent',
      observedBy: 'station-a#1',
      observedAt: '2026-08-03T00:04:03.000Z',
    });
  });
});

/**
 * The wire boundary the required member cannot reach (delta review, HIGH).
 *
 * `(await response.json()) as { data?: <Shape>[] }` is an assertion, so every
 * cross-version boundary — the published SDK's fetch helpers, the server's
 * remote-session reader — can hand a consumer a required member that is
 * `undefined` at runtime. One shared normalizer closes it; these pin what it
 * decides, because the FIRST version of it (in the server, before it was
 * shared) guarded on truthiness and forwarded an unattributed negative claim.
 */
describe('normalizeRequestAnswerability', () => {
  const stated = {
    answerable: false,
    qualification: 'provider_absent',
    observedBy: 'remote-station#99',
    observedAt: '2026-08-03T12:04:03.000Z',
  } as const;

  test('a fully-stated negative arm passes through untouched, observer included', () => {
    // The remote's answer is the remote's; overwriting it here would replace a
    // real observation with a local guess.
    expect(normalizeRequestAnswerability(stated)).toEqual(stated);
  });

  test('absence is not a claim of unanswerability', () => {
    for (const absent of [undefined, null, 'nonsense', 42]) {
      expect(normalizeRequestAnswerability(absent)).toEqual({
        answerable: true,
      });
    }
  });

  test('a negative arm missing its basis is downgraded, not forwarded', () => {
    // This is the L-C defect stated as a test: `{ answerable: false }` with no
    // observer is exactly the timeless, unattributed label the required basis
    // exists to prevent. Forwarding it would let a peer launder a label
    // through a type that promises a derivation.
    for (const unattributed of [
      { answerable: false },
      { answerable: false, qualification: 'provider_absent' },
      { ...stated, observedBy: '' },
      { ...stated, observedAt: '' },
      { ...stated, observedBy: 7 },
    ]) {
      expect(normalizeRequestAnswerability(unattributed)).toEqual({
        answerable: true,
      });
    }
  });

  test('a qualification no arm computes is downgraded', () => {
    expect(
      normalizeRequestAnswerability({
        ...stated,
        qualification: 'provider_crashed',
      }),
    ).toEqual({ answerable: true });
  });

  test('an affirmative arm normalizes to the canonical shape', () => {
    expect(
      normalizeRequestAnswerability({ answerable: true, stray: 'field' }),
    ).toEqual({ answerable: true });
  });
});

/**
 * THE COPY CONTRACT (station#1780/#1781/#1782/#1783).
 *
 * Four surfaces render this observation — the notification popover, the
 * notifications page, the delegated-task card and session-detail card, the
 * CLI approvals list and the operate TUI — and every one of them calls the
 * function pinned here. That is the point: four hand-written sentences would
 * be four chances to drop the basis and leave a timeless label behind, which
 * is the exact defect ADR 0012's negative arm carries `observedBy`/
 * `observedAt` to prevent.
 */
describe('unanswerableRequestNotice', () => {
  const providerAbsent = {
    answerable: false,
    qualification: 'provider_absent',
    observedBy: 'station-7f3a',
    observedAt: '2026-08-03T12:04:03.000Z',
  } as const satisfies RequestAnswerability;

  test('the positive arm has nothing to annotate and says so with null', () => {
    // Not an empty string: a surface doing `if (notice)` must not have to
    // guess, and the positive arm deliberately carries no basis to render.
    expect(unanswerableRequestNotice({ answerable: true })).toBeNull();
  });

  test('the negative arm names WHICH arm, WHO observed it, and WHEN', () => {
    const notice = unanswerableRequestNotice(providerAbsent, {
      provider: 'acme',
    });
    expect(notice).toContain("no adapter for provider 'acme'");
    expect(notice).toContain('station-7f3a');
    expect(notice).toContain('2026-08-03T12:04:03.000Z');
    expect(notice).toContain('Unanswerable by the serving Station');
  });

  test('observedAt is rendered verbatim, not localised', () => {
    // It is the OBSERVING process's clock, not the reader's. Reformatting a
    // cross-process claim into the reader's timezone silently reattributes
    // it, and a locale-dependent string could not be pinned by any test.
    expect(unanswerableRequestNotice(providerAbsent)).toContain(
      providerAbsent.observedAt,
    );
  });

  test('an unnamed provider renders an honest gap, never an invented id', () => {
    const notice = unanswerableRequestNotice(providerAbsent);
    expect(notice).toContain('no adapter for that provider');
    expect(notice).not.toContain("provider ''");
    expect(notice).not.toContain('undefined');
  });

  test('past_resume is distinguishable from provider_absent in the copy', () => {
    // A spike in one arm is the shape a broken plugin load makes and the
    // other is a session that ended; collapsing them into one sentence would
    // discard the field that makes a misfiring arm diagnosable.
    const pastResume = unanswerableRequestNotice({
      ...providerAbsent,
      qualification: 'past_resume',
    });
    expect(pastResume).toContain('cannot resume');
    expect(pastResume).not.toContain('adapter');
    expect(pastResume).toContain('2026-08-03T12:04:03.000Z');
  });
});

describe('unknownAnswerabilityNotice', () => {
  test('names the gap explicitly rather than implying an answer', () => {
    const notice = unknownAnswerabilityNotice('session thread-9');
    expect(notice).toContain('Answerability unknown');
    expect(notice).toContain('thread-9');
    // "could not look" must never read as either observed answer.
    expect(notice).not.toContain('Unanswerable by');
  });

  test('stays honest with no subject to name', () => {
    expect(unknownAnswerabilityNotice()).toContain('Answerability unknown');
  });
});
