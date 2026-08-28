import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AttachedSessionSource } from '../../../providers/sessions/attached-session-source.js';
import {
  type AttachedProjectRoot,
  AttachedSessionFollowService,
  resolveAttachedProjectRoot,
  resolveAttachedProjectRoots,
  resolveAttachedSessionPollInterval,
} from '../attached-session-follow-service.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import type { SessionAnswerabilityObservation } from '../open-requests.js';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';

/**
 * The process-local half of the answerability decoration
 * (archive#1778). These tests are about the builder's MERGE behaviour, so
 * every call states the observation explicitly rather than hiding it behind
 * a shim — the required option is the enforcement mechanism, and a test
 * helper that supplied it implicitly would be the first place it stopped
 * being enforced.
 */
const OBSERVATION: SessionAnswerabilityObservation = {
  threadAttachment: 'detached',
  providerRegistered: true,
  observedBy: 'test-instance#0',
  observedAt: '2026-08-03T00:00:00.000Z',
};

// `ProjectConfig.workingDirectory` is stored with a LITERAL `~`
// (`project-service.ts` normalises nothing on create; `terminal-service.ts`'s
// comment says so outright), so the tilde path is the repo's norm rather than
// an edge case. Pointing `homedir()` at the per-test temp directory is what
// lets a tilde-stored project be exercised against real files.
const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home.dir || actual.homedir() };
});

const metrics = vi.hoisted(() => ({
  orchestrationEventsPersisted: { add: vi.fn() },
  orchestrationEventPersistDuration: { record: vi.fn() },
  attachedSessionDiscovery: { add: vi.fn() },
  attachedSessionScanDuration: { record: vi.fn() },
  attachedSessionEventsImported: { add: vi.fn() },
  attachedSessionProjectAttribution: { add: vi.fn() },
}));

vi.mock('../../../telemetry/metrics.js', () => metrics);

let session = {
  provider: 'claude',
  sessionId: 'session-1',
  threadId: 'external:claude:hashed-session-1',
  cwd: '',
  createdAt: '2026-07-22T00:00:00.000Z',
  sourceHandle: 'opaque-source-handle',
};

/**
 * Whether the volume the tests run on folds case, decided by observation
 * rather than by `process.platform` — darwin's default APFS volume folds
 * case, an ext4 volume does not, and either can be mounted the other way.
 * On a case-sensitive volume two spellings are genuinely two directories, so
 * the case-variant tie has nothing to assert.
 */
function caseInsensitiveVolume(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'station-case-probe-'));
  try {
    mkdirSync(join(probe, 'repository'));
    return (
      realpathSync.native(join(probe, 'REPOSITORY')) ===
      realpathSync.native(join(probe, 'repository'))
    );
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

function event(id: string, delta = 'hello') {
  return {
    eventId: id,
    provider: 'claude' as const,
    threadId: session.threadId,
    createdAt: '2026-07-22T00:00:01.000Z',
    method: 'content.text-delta' as const,
    itemId: 'item-1',
    delta,
  };
}

describe('AttachedSessionFollowService', () => {
  let dir: string;
  let store: EventStore;
  let eventBus: EventBus;

  beforeEach(() => {
    dir = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'station-attached-follow-')),
    );
    home.dir = dir;
    mkdirSync(join(dir, 'repository', 'app'), { recursive: true });
    session = { ...session, cwd: join(dir, 'repository', 'app') };
    store = new EventStore(join(dir, 'orchestration.sqlite'));
    eventBus = new EventBus();
    vi.clearAllMocks();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('uses the documented default and bounds an invalid poll override', () => {
    expect(resolveAttachedSessionPollInterval(undefined)).toBe(2_000);
    expect(resolveAttachedSessionPollInterval('not-a-number')).toBe(2_000);
    expect(resolveAttachedSessionPollInterval('1')).toBe(250);
    expect(resolveAttachedSessionPollInterval('120000')).toBe(60_000);
  });

  test('resolves symlinked nested cwd to the canonical configured root and rejects stale roots', () => {
    const root = join(dir, 'canonical-project');
    const nested = join(root, 'packages', 'app');
    const link = join(dir, 'project-link');
    mkdirSync(nested, { recursive: true });
    symlinkSync(root, link, 'dir');

    expect(
      resolveAttachedProjectRoot(join(link, 'packages', 'app'), [
        { slug: 'project', workingDirectory: root },
      ]),
    ).toEqual({
      state: 'attributed',
      slug: 'project',
      cwd: realpathSync(nested),
      workingDirectory: realpathSync(root),
    });
    expect(
      resolveAttachedProjectRoot(nested, [
        { slug: 'stale', workingDirectory: join(dir, 'missing') },
      ]),
    ).toEqual({ state: 'unattributed' });
  });

  // archive#1462. The old tie-break was `root.length > match.length`, so two
  // projects on one directory resolved to whichever `listProjects()` happened
  // to yield first — a `readdir`-ordered winner, stamped into a
  // content-addressed event id that never re-derives.
  describe('project attribution is deterministic and honest (station#1462)', () => {
    test('two projects on one directory resolve to a named ambiguity, in either input order', () => {
      const root = join(dir, 'repository');
      const nested = join(dir, 'repository', 'app');
      const beta = { slug: 'beta', workingDirectory: nested };
      const alpha = { slug: 'alpha', workingDirectory: nested };

      const forward = resolveAttachedProjectRoot(nested, [alpha, beta]);
      const reversed = resolveAttachedProjectRoot(nested, [beta, alpha]);

      expect(forward).toEqual({
        state: 'ambiguous',
        cwd: realpathSync(nested),
        workingDirectory: realpathSync(nested),
        candidates: ['alpha', 'beta'],
      });
      expect(reversed).toEqual(forward);
      // The outer project still loses to the longer root; ambiguity is about
      // the tie, not about "more than one project matched at all".
      expect(
        resolveAttachedProjectRoot(nested, [
          { slug: 'outer', workingDirectory: root },
          alpha,
          beta,
        ]),
      ).toEqual(forward);
    });

    test('an exact-path match wins over a shorter containing project', () => {
      const root = join(dir, 'repository');
      const nested = join(dir, 'repository', 'app');

      expect(
        resolveAttachedProjectRoot(nested, [
          { slug: 'inner', workingDirectory: nested },
          { slug: 'outer', workingDirectory: root },
        ]),
      ).toEqual({
        state: 'attributed',
        slug: 'inner',
        cwd: realpathSync(nested),
        workingDirectory: realpathSync(nested),
      });
    });

    test('a nested cwd still resolves to the longest containing project', () => {
      const root = join(dir, 'repository');
      const nested = join(dir, 'repository', 'app');
      const deep = join(nested, 'src');
      mkdirSync(deep, { recursive: true });

      expect(
        resolveAttachedProjectRoot(deep, [
          { slug: 'outer', workingDirectory: root },
          { slug: 'inner', workingDirectory: nested },
        ]),
      ).toEqual({
        state: 'attributed',
        slug: 'inner',
        cwd: realpathSync(deep),
        workingDirectory: realpathSync(nested),
      });
    });
  });

  test('matches the longest canonical project root and publishes each canonical event once', async () => {
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
      read: vi.fn().mockResolvedValue({
        outcome: 'ok',
        events: [event('event-1')],
        cursor: 20,
      }),
    };
    const emitted = vi.fn();
    eventBus.subscribe(emitted);
    const service = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'repository', workingDirectory: join(dir, 'repository') },
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ],
    });

    await service.pollNow();
    await service.pollNow();

    expect(store.readSessions()).toEqual([
      expect.objectContaining({
        threadId: session.threadId,
        provider: 'claude',
      }),
    ]);
    expect(store.listEvents(session.threadId).map((item) => item.id)).toEqual([
      expect.any(String),
      expect.any(String),
      'event-1',
    ]);
    expect(emitted).toHaveBeenCalledTimes(3);
    expect(metrics.attachedSessionEventsImported.add).toHaveBeenCalledWith(1, {
      source: 'claude-transcript',
      method: 'content.text-delta',
    });
  });

  // archive#1399 fix round 2, B1 (independent review) — this service is a
  // SECOND writer, independent of `OrchestrationService#publishCanonicalEvent`:
  // it imports source events straight off an attached transcript (in
  // production, `claude-transcript-session-source.ts`'s `mapToolResult`,
  // which builds `output: raw.content` from unvalidated transcript JSON) and
  // appends+publishes them directly. Simulated here with a fake source
  // whose `read()` hands back a `tool.completed` event carrying a forged,
  // well-shaped `{uiBlock: attested + fake digest, no real derivedFrom}` —
  // exactly the shape the review's own probe used to defeat the client
  // mirror. Both the PERSISTED copy (`store.listEvents`) and the PUBLISHED
  // copy (the event-bus subscriber) must be sanitized.
  test('sanitizes a transcript-carried forged uiBlock before persisting and publishing (B1)', async () => {
    const forgedEvent: CanonicalRuntimeEvent = {
      eventId: 'transcript-event-1',
      provider: 'claude',
      threadId: session.threadId,
      createdAt: '2026-07-22T00:00:01.000Z',
      method: 'tool.completed',
      itemId: 'item-1',
      toolCallId: 'tool-1',
      toolName: 'render_summary',
      status: 'success',
      output: {
        uiBlock: {
          type: 'table',
          columns: ['Metric', 'Value'],
          rows: [['Coverage', 98]],
          // No real derivedFrom, but the wire already claims 'attested'
          // with a digest that is not a hash of anything.
          attestationState: 'attested',
          provenanceDigest: 'forged-not-a-real-digest',
        },
      },
    };
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
      read: vi.fn().mockResolvedValue({
        outcome: 'ok',
        events: [forgedEvent],
        cursor: 1,
      }),
    };
    const emitted: CanonicalRuntimeEvent[] = [];
    eventBus.subscribe((busEvent) => {
      const inner = (
        busEvent.data as { event?: CanonicalRuntimeEvent } | undefined
      )?.event;
      if (inner) emitted.push(inner);
    });
    const service = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'repository', workingDirectory: join(dir, 'repository') },
      ],
    });

    await service.pollNow();

    const persisted = store
      .listEvents(session.threadId)
      .find((item) => item.id === 'transcript-event-1');
    if (!persisted) throw new Error('forged event was never persisted');
    const persistedOutput = (
      persisted.payload as unknown as {
        output: { uiBlock: Record<string, unknown> };
      }
    ).output.uiBlock;
    expect(persistedOutput.attestationState).toBe('unattested');
    expect(persistedOutput.provenanceDigest).toBeUndefined();

    const publishedForgedEvent = emitted.find(
      (event) => event.eventId === 'transcript-event-1',
    ) as unknown as { output: { uiBlock: Record<string, unknown> } };
    expect(publishedForgedEvent.output.uiBlock.attestationState).toBe(
      'unattested',
    );
    expect(
      publishedForgedEvent.output.uiBlock.provenanceDigest,
    ).toBeUndefined();
  });

  // archive#1462. Two things are asserted together on purpose: the session is
  // still followed (an ambiguous workspace must not make a live external
  // session vanish), and neither published envelope claims a project slug.
  test('follows an ambiguous workspace without stamping a project slug', async () => {
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
      read: vi.fn().mockResolvedValue({
        outcome: 'ok',
        events: [event('event-1')],
        cursor: 20,
      }),
    };
    const service = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'beta', workingDirectory: join(dir, 'repository', 'app') },
        { slug: 'alpha', workingDirectory: join(dir, 'repository', 'app') },
      ],
    });

    await service.pollNow();

    expect(store.readSessions()).toEqual([
      expect.objectContaining({ threadId: session.threadId }),
    ]);
    const envelope = store
      .listEvents(session.threadId)
      .filter((item) => item.id !== 'event-1')
      .map(
        (item) =>
          item.payload as unknown as {
            method: string;
            metadata: Record<string, unknown>;
          },
      );
    expect(envelope.map((item) => item.method)).toEqual([
      'session.started',
      'session.configured',
    ]);
    for (const item of envelope) {
      expect(item.metadata.projectSlug).toBeUndefined();
      expect(item.metadata.projectAttribution).toBe('ambiguous');
      expect(item.metadata.projectCandidates).toEqual(['alpha', 'beta']);
    }
    expect(metrics.attachedSessionProjectAttribution.add).toHaveBeenCalledWith(
      1,
      { source: 'claude-transcript', state: 'ambiguous' },
    );
  });

  // archive#1462 FIX ROUND. The suite above only ever built a FRESH store or
  // hand-assembled events, which is exactly why the defect survived it: the
  // whole harm lives in the transition from one persisted attribution to
  // another. `envelopeEventId` hashed only `sessionId + kind`, and
  // `appendEventIfAbsent` is `INSERT OR IGNORE`, so the first attribution
  // written was the last one that could ever be written; the read side then
  // scanned backwards for the newest event WITH A SLUG, so even a landed
  // ambiguity marker lost to an older slug. Both halves are proven here, in
  // both directions, across a restart.
  describe('a corrected attribution replaces a stale one (station#1462)', () => {
    function followService(projects: () => AttachedProjectRoot[]) {
      return new AttachedSessionFollowService({
        sources: [
          {
            provider: 'claude',
            discover: vi
              .fn()
              .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
            read: vi
              .fn()
              .mockResolvedValue({ outcome: 'ok', events: [], cursor: 1 }),
          } satisfies AttachedSessionSource,
        ],
        eventStore: store,
        eventBus,
        listProjects: projects,
      });
    }

    /** What the list view and the detail panel actually read. */
    function summarize() {
      const persisted = store
        .readSessions()
        .find((item) => item.threadId === session.threadId);
      if (!persisted) throw new Error('session was never persisted');
      return buildOrchestrationSessionSummary({
        answerability: OBSERVATION,
        persisted,
        events: store
          .listEvents(session.threadId)
          .map((item) => item.payload as unknown as CanonicalRuntimeEvent),
      });
    }

    const app = () => join(dir, 'repository', 'app');

    test('adding a second project on the same directory clears the stamped slug, and survives a restart', async () => {
      let projects: AttachedProjectRoot[] = [
        { slug: 'beta', workingDirectory: app() },
      ];
      await followService(() => projects).pollNow();

      expect(summarize().projectSlug).toBe('beta');
      expect(summarize().projectAttribution).toBeUndefined();

      // The operator configures a second project on the same directory. The
      // resolver and the metric both say ambiguous from this moment on; the
      // question the defect answered wrongly is what the STORE says.
      projects = [
        { slug: 'beta', workingDirectory: app() },
        { slug: 'alpha', workingDirectory: app() },
      ];
      await followService(() => projects).pollNow();

      const corrected = summarize();
      expect(corrected.projectSlug).toBeUndefined();
      expect(corrected.projectAttribution).toEqual({
        state: 'ambiguous',
        candidates: ['alpha', 'beta'],
      });

      // Restart: a brand-new service over the SAME store, so the in-memory
      // `seen` cache is empty and every envelope is offered to persistence
      // again. The correction must hold, and must not be re-overwritten by a
      // replay of the original.
      await followService(() => projects).pollNow();
      expect(summarize().projectSlug).toBeUndefined();
      expect(summarize().projectAttribution).toEqual({
        state: 'ambiguous',
        candidates: ['alpha', 'beta'],
      });
    });

    test('removing the duplicate project restores a confident slug (the remediation the error message prescribes)', async () => {
      let projects: AttachedProjectRoot[] = [
        { slug: 'beta', workingDirectory: app() },
        { slug: 'alpha', workingDirectory: app() },
      ];
      await followService(() => projects).pollNow();
      expect(summarize().projectAttribution).toEqual({
        state: 'ambiguous',
        candidates: ['alpha', 'beta'],
      });

      projects = [{ slug: 'beta', workingDirectory: app() }];
      await followService(() => projects).pollNow();

      const repaired = summarize();
      expect(repaired.projectSlug).toBe('beta');
      expect(repaired.projectAttribution).toBeUndefined();
    });

    // FIX-ROUND SELF-REVIEW. Making the envelope id depend on the attribution
    // means every session followed BEFORE this branch has a stored id that
    // predates the fingerprint, so a naive implementation re-stamps all of
    // them on the first poll after upgrade. The extra pair is harmless in the
    // lifecycle fold (archive#1073 attach facts are transition-neutral) but it is
    // NOT harmless in the read model: it becomes `events.at(-1)`, and the
    // envelope is dated at SESSION CREATION, so `lastEventAt` — which the
    // home list reads as last activity — jumps backwards for every attached
    // session at once. Both halves are pinned here.
    test('a session already carrying the current attribution is not re-stamped', async () => {
      // Seed the store the way a PRE-BRANCH Station left it: the envelope id
      // was `sha256(sessionId \0 kind)`, with no attribution in it. A
      // fingerprinted id therefore does not collide with it, so
      // `appendEventIfAbsent`'s INSERT OR IGNORE does NOT protect this case —
      // without the suppression every already-correct session in the store
      // gets re-stamped on the first poll after upgrade.
      for (const kind of ['started', 'configured'] as const) {
        store.appendEvent({
          eventId: `attached:session:${createHash('sha256')
            .update(`${session.sessionId}\u0000${kind}`)
            .digest('hex')}`,
          provider: 'claude',
          threadId: session.threadId,
          createdAt: session.createdAt,
          method: kind === 'started' ? 'session.started' : 'session.configured',
          sessionId: session.threadId,
          ...(kind === 'started' ? { initialState: 'created' } : {}),
          metadata: {
            controlMode: 'read-only-attached',
            projectSlug: 'beta',
            attachedProvider: 'claude',
          },
        } as never);
      }
      const seeded = store.listEvents(session.threadId).length;

      await followService(() => [
        { slug: 'beta', workingDirectory: app() },
      ]).pollNow();

      // The stored log already says exactly this. Nothing to correct.
      expect(store.listEvents(session.threadId)).toHaveLength(seeded);
      expect(summarize().projectSlug).toBe('beta');
    });

    test('a correction never dates itself earlier than the events already on the thread', async () => {
      const transcript = {
        eventId: 'transcript-late',
        provider: 'claude' as const,
        threadId: session.threadId,
        // Deliberately much later than `session.createdAt`, which is what the
        // envelope is dated with: a real session whose transcript moved on.
        createdAt: '2026-07-30T12:00:00.000Z',
        method: 'content.text-delta' as const,
        itemId: 'item-late',
        delta: 'later work',
      };
      const withTranscript = (projects: () => AttachedProjectRoot[]) =>
        new AttachedSessionFollowService({
          sources: [
            {
              provider: 'claude',
              discover: vi
                .fn()
                .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
              read: vi.fn().mockResolvedValue({
                outcome: 'ok',
                events: [transcript],
                cursor: 1,
              }),
            } satisfies AttachedSessionSource,
          ],
          eventStore: store,
          eventBus,
          listProjects: projects,
        });

      // ONE service across both phases: the re-attribution happens in the
      // same process that imported the transcript, so the thread's newest
      // event is only known from the in-loop update — the cold-path read ran
      // when the log was still empty. A fresh service per phase would hide
      // that (it re-reads the log and gets the answer for free).
      let projects: AttachedProjectRoot[] = [
        { slug: 'beta', workingDirectory: app() },
      ];
      const service = withTranscript(() => projects);

      await service.pollNow();
      expect(summarize().lastEventAt).toBe(transcript.createdAt);

      projects = [
        { slug: 'beta', workingDirectory: app() },
        { slug: 'alpha', workingDirectory: app() },
      ];
      await service.pollNow();

      // The correction landed...
      expect(summarize().projectAttribution).toEqual({
        state: 'ambiguous',
        candidates: ['alpha', 'beta'],
      });
      // ...without rewriting when this session was last active. `now` would
      // be just as wrong in the other direction: re-deriving an attribution
      // is not session activity.
      expect(summarize().lastEventAt).toBe(transcript.createdAt);
      // The method DOES flip, and that is intended: the correction really is
      // the newest row. Pinned so the pairing stays a decision rather than an
      // accident (delta review, INFO).
      expect(summarize().lastEventMethod).toBe('session.configured');
    });

    // DELTA-REVIEW H3. The envelope id was content-addressed on the
    // attribution VALUE, so re-entering a value that had ever been stamped
    // before hashed back to an existing row and `INSERT OR IGNORE` dropped
    // it — leaving the newest-wins read on the intermediate state forever.
    // Every earlier transition test walked a MONOTONE path (each destination
    // a first-time write), which is exactly why a whole green suite could not
    // see it. These re-enter.
    test('a previously-stamped attribution can be re-entered (beta -> ambiguous -> beta)', async () => {
      let projects: AttachedProjectRoot[] = [
        { slug: 'beta', workingDirectory: app() },
      ];
      const service = followService(() => projects);

      await service.pollNow();
      expect(summarize().projectSlug).toBe('beta');

      projects = [
        { slug: 'beta', workingDirectory: app() },
        { slug: 'alpha', workingDirectory: app() },
      ];
      await service.pollNow();
      expect(summarize().projectAttribution).toEqual({
        state: 'ambiguous',
        candidates: ['alpha', 'beta'],
      });

      // The remediation archive#1462's own error message prescribes, applied to the
      // realistic starting state: a session already attributed BEFORE the
      // duplicate appeared.
      projects = [{ slug: 'beta', workingDirectory: app() }];
      await service.pollNow();

      expect(summarize().projectSlug).toBe('beta');
      expect(summarize().projectAttribution).toBeUndefined();
    });

    test('re-entry survives a restart rather than reverting to the intermediate state', async () => {
      let projects: AttachedProjectRoot[] = [
        { slug: 'beta', workingDirectory: app() },
      ];
      await followService(() => projects).pollNow();
      projects = [
        { slug: 'beta', workingDirectory: app() },
        { slug: 'alpha', workingDirectory: app() },
      ];
      await followService(() => projects).pollNow();
      projects = [{ slug: 'beta', workingDirectory: app() }];
      await followService(() => projects).pollNow();

      // A fresh service re-reads the log, so if the correction never landed
      // it recomputes a differing fingerprint, retries, and hits the same
      // existing id again — permanently stuck.
      await followService(() => projects).pollNow();

      expect(summarize().projectSlug).toBe('beta');
      expect(summarize().projectAttribution).toBeUndefined();
    });

    // archive#3495 CHANGED THIS TEST'S GUARANTEE, deliberately — it used to
    // assert that a REPEATED transition re-stamps.
    //
    // The envelope id used to carry a `generation` counter: how many
    // attributions the thread's log held, incremented by the very write that
    // read it. Every lap of a cycle therefore produced a brand-new id, so
    // `appendEventIfAbsent`'s INSERT OR IGNORE could never suppress anything
    // and the docblock's "row growth stays bounded" was a claim nothing
    // derived. The live store falsified it: ONE thread accumulated 259,286
    // `session.started` rows across 4 distinct `created_at` values while 4
    // `cwd` values cycled onto it, the table reached 694 MB, and reading that
    // thread is what took the backend to 2.7 GB and 677 restarts in a day.
    //
    // The id now addresses the TRANSITION (`from -> to`), a finite set. The
    // cost, asserted here rather than left to be discovered: a transition
    // this thread has already made re-derives its existing id and is dropped,
    // so the read keeps showing the previous destination. Every FIRST-TIME
    // transition still lands — the H3 and three-state tests above walk only
    // distinct transitions and are unaffected.
    test('a repeated transition does not re-stamp, which is what bounds the log', async () => {
      const both = [
        { slug: 'beta', workingDirectory: app() },
        { slug: 'alpha', workingDirectory: app() },
      ];
      const alphaOnly = [{ slug: 'alpha', workingDirectory: app() }];
      // Each poll is a fresh service, so every step re-derives the
      // predecessor from the persisted log rather than an in-memory counter.
      for (const projects of [
        [{ slug: 'beta', workingDirectory: app() }],
        both,
        alphaOnly,
        both,
      ]) {
        await followService(() => projects).pollNow();
      }
      expect(summarize().projectAttribution?.candidates).toEqual([
        'alpha',
        'beta',
      ]);
      const beforeRepeat = store.listEvents(session.threadId).length;

      // `ambiguous[alpha,beta] -> alpha` already happened two steps ago.
      await followService(() => alphaOnly).pollNow();

      expect(store.listEvents(session.threadId)).toHaveLength(beforeRepeat);
      expect(summarize().projectAttribution?.candidates).toEqual([
        'alpha',
        'beta',
      ]);
    });

    // The regression test for the outage itself: the log must stop growing.
    test('a cycle of attributions saturates instead of growing without bound', async () => {
      const both = [
        { slug: 'beta', workingDirectory: app() },
        { slug: 'alpha', workingDirectory: app() },
      ];
      const alphaOnly = [{ slug: 'alpha', workingDirectory: app() }];
      const betaOnly = [{ slug: 'beta', workingDirectory: app() }];
      const lap = async () => {
        for (const projects of [betaOnly, both, alphaOnly]) {
          // A fresh service per step: the in-memory `seen` set must not be
          // what bounds this, because a restart empties it and the live
          // service is long-lived across many more attributions than it
          // remembers.
          await followService(() => projects).pollNow();
        }
      };

      // A suppressed write leaves the log's newest attribution where it was,
      // so the next step's PREDECESSOR changes and the walk explores more of
      // the transition space before it closes. Over 3 attributions that space
      // is the 6 ordered pairs plus the initial `nothing -> beta`: 7 pairs,
      // 14 events, and there is nowhere else for it to go.
      for (let index = 0; index < 8; index += 1) await lap();
      const saturated = store.listEvents(session.threadId).length;
      // `toBe`, not `toBeLessThanOrEqual`: the docblock states 14 as a
      // measured fact, and a regression that DROPPED a transition would
      // saturate lower while keeping a `<=` bound green — leaving the
      // docblock's number false with nothing red.
      expect(saturated).toBe(14);

      // AND WHAT SATURATION COSTS — derived here rather than asserted in a
      // comment, because `envelopeEventId`'s docblock names this trade and a
      // trade nobody measures is a label. Every lap ENDS on `alphaOnly`, so
      // the live source says `alpha`; the newest-wins read says `beta`, the
      // destination of the last transition that was allowed to land.
      expect(summarize().projectSlug).toBe('beta');

      for (let index = 0; index < 30; index += 1) await lap();

      // Thirty more laps — ninety more attribution changes — and the log is
      // exactly the same size. Under the `generation` id this reads 180 rows
      // higher and keeps climbing for as long as the source flaps.
      expect(store.listEvents(session.threadId)).toHaveLength(saturated);

      // The wrong read is PERMANENT, not a lag: thirty further laps do not
      // move it, because every transition the cycle can make has already been
      // made and every write is now a suppressed repeat. This is the
      // assertion that fails if anyone later describes the trade as
      // temporary — "until the attribution moves somewhere it has not been
      // from here before" is true only while unvisited transitions remain,
      // and a bounded flapping set exhausts them in seconds. (A bounded AND
      // newest-correct shape does exist — the mutable `attribution`
      // projection fact — and is deliberately not built here; see
      // `envelopeEventId`.)
      expect(summarize().projectSlug).toBe('beta');
    }, 30_000);

    test('a three-state cycle re-enters an AMBIGUOUS attribution too', async () => {
      // Also the coverage the delta review asked for around
      // `metadataAttributionFingerprint`'s ambiguous branch: once re-entry
      // works, that branch stops being unobservable.
      const both = [
        { slug: 'beta', workingDirectory: app() },
        { slug: 'alpha', workingDirectory: app() },
      ];
      let projects: AttachedProjectRoot[] = both;
      const service = followService(() => projects);

      await service.pollNow();
      expect(summarize().projectAttribution?.candidates).toEqual([
        'alpha',
        'beta',
      ]);

      projects = [{ slug: 'alpha', workingDirectory: app() }];
      await service.pollNow();
      expect(summarize().projectSlug).toBe('alpha');

      projects = both;
      await service.pollNow();
      expect(summarize().projectSlug).toBeUndefined();
      expect(summarize().projectAttribution).toEqual({
        state: 'ambiguous',
        candidates: ['alpha', 'beta'],
      });

      projects = [{ slug: 'beta', workingDirectory: app() }];
      await service.pollNow();
      expect(summarize().projectSlug).toBe('beta');
    });

    test('an unchanged attribution appends nothing on a repeat poll', async () => {
      const projects = () => [{ slug: 'beta', workingDirectory: app() }];
      await followService(projects).pollNow();
      const first = store.listEvents(session.threadId).length;
      // The first follow of an unattributed session writes exactly the
      // envelope pair and nothing else.
      expect(first).toBe(2);

      await followService(projects).pollNow();

      // The fingerprint must be STABLE, not merely different-when-changed:
      // an id that varied per poll would grow the log without bound and make
      // the "newest wins" read meaningless.
      expect(store.listEvents(session.threadId)).toHaveLength(first);

      // ...and it must stay stable across many polls and many restarts, not
      // just the second one (archive#3495: the live regression only became
      // visible over hours).
      for (let index = 0; index < 10; index += 1) {
        await followService(projects).pollNow();
      }
      expect(store.listEvents(session.threadId)).toHaveLength(first);
    });

    test('a genuine attribution change appends exactly one envelope pair', async () => {
      let projects: AttachedProjectRoot[] = [
        { slug: 'beta', workingDirectory: app() },
      ];
      await followService(() => projects).pollNow();
      const beforeChange = store.listEvents(session.threadId).length;

      projects = [{ slug: 'alpha', workingDirectory: app() }];
      await followService(() => projects).pollNow();

      const appended = store
        .listEvents(session.threadId)
        .slice(beforeChange)
        .map((item) => item.payload as unknown as CanonicalRuntimeEvent);
      // One pair: the correction really is a new newest event, and it is the
      // ONLY thing the change costs.
      expect(appended.map((item) => item.method)).toEqual([
        'session.started',
        'session.configured',
      ]);
      expect(summarize().projectSlug).toBe('alpha');
    });
  });

  // archive#1462 FIX ROUND. Canonicalisation dropping a configured project is
  // not a cosmetic miss: a dropped candidate removes one side of a tie, so
  // genuine ambiguity renders as a confident, wrong `attributed`.
  describe('canonicalisation never silently drops a project (station#1462)', () => {
    test('a project whose working directory is stored with a literal ~ still joins the tie', () => {
      // The pre-fix `realpathSync('~/repository/app')` throws ENOENT, so this
      // project vanished before the tie could form and the resolver returned
      // a confident `attributed: beta`.
      expect(
        resolveAttachedProjectRoot(join(dir, 'repository', 'app'), [
          { slug: 'alpha', workingDirectory: '~/repository/app' },
          { slug: 'beta', workingDirectory: join(dir, 'repository', 'app') },
        ]),
      ).toMatchObject({ state: 'ambiguous', candidates: ['alpha', 'beta'] });
    });

    test('a lone tilde-stored project is attributed rather than reported as containing nothing', () => {
      // The other half of the same defect: the session was not followed at
      // all, while the metric claimed "no configured project contains this
      // cwd" — false.
      expect(
        resolveAttachedProjectRoot(join(dir, 'repository', 'app'), [
          { slug: 'alpha', workingDirectory: '~/repository/app' },
        ]),
      ).toMatchObject({ state: 'attributed', slug: 'alpha' });
    });

    test('a project root that no longer resolves still joins the tie', () => {
      // An unmounted volume or a deleted checkout. Both the cwd and the roots
      // are unresolvable here, so this also covers the cwd fallback.
      const vanished = join(dir, 'vanished', 'app');
      expect(
        resolveAttachedProjectRoot(vanished, [
          { slug: 'alpha', workingDirectory: vanished },
          { slug: 'beta', workingDirectory: vanished },
        ]),
      ).toMatchObject({ state: 'ambiguous', candidates: ['alpha', 'beta'] });
      expect(
        resolveAttachedProjectRoot(vanished, [
          { slug: 'alpha', workingDirectory: vanished },
        ]),
      ).toMatchObject({ state: 'attributed', slug: 'alpha' });
    });

    // The case-variant test below can only run where the volume folds case,
    // so on a Linux runner nothing would notice `realpathSync.native` being
    // swapped back to the case-PRESERVING `realpathSync`. Assert the call
    // itself, which is platform-independent: `.native` is a property on the
    // very function object the service imported, so spying on it observes
    // the real call site.
    test('canonicalisation calls the case-normalising realpath, on every platform', () => {
      const native = vi.spyOn(realpathSync, 'native');

      resolveAttachedProjectRoot(join(dir, 'repository', 'app'), [
        { slug: 'alpha', workingDirectory: join(dir, 'repository', 'app') },
      ]);

      expect(native).toHaveBeenCalled();
      native.mockRestore();
    });

    test.skipIf(!caseInsensitiveVolume())(
      'case-variant spellings of one directory are one root, not two',
      () => {
        // Plain `realpathSync` echoes the case the operator typed, so
        // `<dir>/REPOSITORY/app` and `<dir>/repository/app` stayed two
        // distinct strings of EQUAL length: neither longer, neither equal, so
        // the second was discarded by the tie-break and the resolver reported
        // a confident `attributed`. Skipped on case-sensitive volumes, where
        // the two spellings genuinely are different directories.
        expect(
          resolveAttachedProjectRoot(join(dir, 'repository', 'app'), [
            {
              slug: 'alpha',
              workingDirectory: join(dir, 'REPOSITORY', 'app'),
            },
            { slug: 'beta', workingDirectory: join(dir, 'repository', 'app') },
          ]),
        ).toMatchObject({ state: 'ambiguous', candidates: ['alpha', 'beta'] });
      },
    );
  });

  test('deduplicates a replay after restart and follows appended events without a reload', async () => {
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
      read: vi
        .fn()
        .mockResolvedValueOnce({
          outcome: 'ok',
          events: [event('event-1')],
          cursor: 20,
        })
        .mockResolvedValueOnce({
          outcome: 'ok',
          events: [event('event-1'), event('event-2', 'later')],
          cursor: 40,
        }),
    };
    const first = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ],
    });
    await first.pollNow();
    const appendIfAbsent = vi.spyOn(store, 'appendEventIfAbsent');
    const restarted = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ],
    });

    await restarted.pollNow();

    expect(source.read).toHaveBeenNthCalledWith(1, session, undefined);
    expect(source.read).toHaveBeenNthCalledWith(2, session, 20);
    // The old event is discarded by one indexed batch lookup. It never
    // enters the SQLite savepoint/sequence path again; only the genuinely new
    // event reaches the idempotent insert boundary.
    expect(appendIfAbsent).toHaveBeenCalledTimes(1);
    expect(appendIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-2' }),
    );
    expect(store.listEvents(session.threadId).map((item) => item.id)).toEqual([
      expect.any(String),
      expect.any(String),
      'event-1',
      'event-2',
    ]);
  });

  test('rejects a durable transcript cursor when the opaque source handle changes', async () => {
    const firstSource: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
      read: vi.fn().mockResolvedValue({
        outcome: 'ok',
        events: [],
        cursor: { offset: 40, turnId: 'turn-1' },
      }),
    };
    const options = {
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ],
    };
    await new AttachedSessionFollowService({
      ...options,
      sources: [firstSource],
    }).pollNow();

    const moved = { ...session, sourceHandle: 'replacement-source-handle' };
    const replacementSource: AttachedSessionSource = {
      provider: 'claude',
      discover: vi.fn().mockResolvedValue({ outcome: 'ok', sessions: [moved] }),
      read: vi.fn().mockResolvedValue({ outcome: 'ok', events: [], cursor: 8 }),
    };
    await new AttachedSessionFollowService({
      ...options,
      sources: [replacementSource],
    }).pollNow();

    expect(replacementSource.read).toHaveBeenCalledWith(moved, undefined);
    expect(
      store.readSessions().find((item) => item.threadId === session.threadId)
        ?.resumeCursor,
    ).toEqual(
      expect.objectContaining({
        kind: 'station.attached-session-cursor/v1',
        sourceHandle: 'replacement-source-handle',
        cursor: 8,
      }),
    );
  });

  test.each([
    [
      'disagreeing accumulator turn id',
      {
        offset: 40,
        turnId: 'turn-1',
        usage: { turnId: 'turn-2', promptTokens: 2 },
      },
    ],
    [
      'fractional usage tokens',
      {
        offset: 40,
        turnId: 'turn-1',
        usage: { turnId: 'turn-1', promptTokens: 1.5 },
      },
    ],
    [
      'unsafe-integer usage tokens',
      {
        offset: 40,
        turnId: 'turn-1',
        usage: { turnId: 'turn-1', promptTokens: 9_007_199_254_740_992 },
      },
    ],
  ])('rejects a durable transcript cursor with %s', async (_reason, cursor) => {
    store.upsertSession({
      provider: 'claude',
      threadId: session.threadId,
      status: 'ready',
      cwd: session.cwd,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: session.sessionId,
      },
      resumeCursor: {
        kind: 'station.attached-session-cursor/v1',
        provider: 'claude',
        sourceHandle: session.sourceHandle,
        cursor,
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
      read: vi.fn().mockResolvedValue({ outcome: 'ok', events: [], cursor: 8 }),
    };

    await new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ],
    }).pollNow();

    expect(source.read).toHaveBeenCalledWith(session, undefined);
  });

  // Cold path must NOT materialize full thread payloads via listEvents
  // (dogfood hang: 10k–20k-event Claude-import threads starved identity), and
  // since archive#3495 must not materialize an unbounded slice of them
  // either: the newest configured events plus MAX(created_at) are enough.
  test('does not call listEvents on cold start or steady-state polls', async () => {
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
      read: vi.fn().mockResolvedValue({
        outcome: 'ok',
        events: [event('event-1')],
        cursor: 20,
      }),
    };
    const listEvents = vi.spyOn(store, 'listEvents');
    const listOwnership = vi.spyOn(store, 'listRecentConfiguredEventsByThread');
    const service = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ],
    });

    await service.pollNow();
    const afterColdStart = listEvents.mock.calls.length;
    const ownershipAfterCold = listOwnership.mock.calls.length;
    await service.pollNow();
    await service.pollNow();

    expect(afterColdStart).toBe(0);
    expect(listEvents.mock.calls.length).toBe(0);
    // One ownership read on cold path for this thread; cached follow state
    // avoids re-reading on later polls.
    expect(ownershipAfterCold).toBe(1);
    expect(listOwnership.mock.calls.length).toBe(ownershipAfterCold);
    // ...and that one read is BOUNDED. Without an explicit limit the read is
    // "every ownership-shaped row on the thread", which on the live store was
    // 517,718 rows and ~1.2 GB of parsed payloads per followed thread.
    for (const call of listOwnership.mock.calls) {
      expect(typeof call[1]).toBe('number');
      expect(call[1]).toBeLessThanOrEqual(64);
    }
  });

  test('yields to the macrotask queue while rehydrating many persisted sessions (#1997)', async () => {
    const sessions = Array.from({ length: 64 }, (_, index) => ({
      ...session,
      sessionId: `session-${index}`,
      threadId: `external:claude:rehydrate-${index}`,
      sourceHandle: `opaque-source-handle-${index}`,
    }));
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi.fn().mockResolvedValue({ outcome: 'ok', sessions }),
      // An immediately fulfilled source promise is the dangerous shape: each
      // continuation runs as a microtask and calls synchronous SQLite through
      // follow().
      read: vi.fn().mockResolvedValue({ outcome: 'ok', events: [], cursor: 1 }),
    };
    const service = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ],
    });

    let completed = false;
    const poll = service.pollNow().then(() => {
      completed = true;
    });
    const immediateRanBeforePollCompleted = await new Promise<boolean>(
      (resolve) => setImmediate(() => resolve(!completed)),
    );
    await poll;

    expect(immediateRanBeforePollCompleted).toBe(true);
    expect(source.read).toHaveBeenCalledTimes(64);
  });

  test('ignores an old replay after restart beyond the bounded seen cache', async () => {
    for (let index = 0; index < 10; index += 1) {
      store.appendEvent(event(`event-${index}`, String(index)));
    }
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
      read: vi.fn().mockResolvedValue({
        outcome: 'ok',
        events: [event('event-0', '0')],
        cursor: 20,
      }),
    };
    const service = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ],
      maxSeenEventIds: 8,
    });

    await expect(service.pollNow()).resolves.toBeUndefined();

    expect(store.listEvents(session.threadId)).toHaveLength(12);
  });

  test('replaces a provider cursor when the same session moves to a new source handle', async () => {
    const firstSession = { ...session, sourceHandle: 'source-one' };
    const secondSession = { ...session, sourceHandle: 'source-two' };
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'ok', sessions: [firstSession] })
        .mockResolvedValueOnce({ outcome: 'ok', sessions: [secondSession] }),
      read: vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'ok', events: [], cursor: 20 })
        .mockResolvedValueOnce({ outcome: 'ok', events: [], cursor: 40 }),
    };
    const service = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ],
    });

    await service.pollNow();
    await service.pollNow();

    expect(source.read).toHaveBeenNthCalledWith(1, firstSession, undefined);
    expect(source.read).toHaveBeenNthCalledWith(2, secondSession, undefined);
  });

  test('refuses to convert a colliding Station-owned session', async () => {
    store.upsertSession({
      provider: 'claude',
      threadId: session.threadId,
      status: 'ready',
      controlMode: 'station-owned',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    });
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
      read: vi.fn().mockResolvedValue({ outcome: 'ok', events: [], cursor: 0 }),
    };
    const service = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ],
    });

    await service.pollNow();

    expect(store.readSessions()).toEqual([
      expect.objectContaining({
        threadId: session.threadId,
        controlMode: 'station-owned',
      }),
    ]);
    expect(store.listEvents(session.threadId)).toEqual([]);
    expect(source.read).not.toHaveBeenCalled();
  });

  test('does not rediscover a Station-owned fork by its persisted provider cursor', async () => {
    store.upsertSession({
      provider: 'claude',
      threadId: 'station-child',
      status: 'ready',
      cwd: session.cwd,
      resumeCursor: session.sessionId,
      controlMode: 'station-owned',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
      read: vi.fn().mockResolvedValue({ outcome: 'ok', events: [], cursor: 0 }),
    };
    const service = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ],
    });

    await service.pollNow();

    expect(store.readSessions()).toEqual([
      expect.objectContaining({
        threadId: 'station-child',
        controlMode: 'station-owned',
      }),
    ]);
    expect(source.read).not.toHaveBeenCalled();
  });

  test('tombstones an attached alias when a Station fork wins after the follower cached it', async () => {
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
      read: vi.fn().mockResolvedValue({ outcome: 'ok', events: [], cursor: 0 }),
    };
    const service = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ],
    });
    await service.pollNow();
    expect(store.readSessions()).toContainEqual(
      expect.objectContaining({ threadId: session.threadId }),
    );
    store.upsertSession({
      provider: 'claude',
      threadId: 'station-child',
      status: 'ready',
      cwd: session.cwd,
      resumeCursor: session.sessionId,
      controlMode: 'station-owned',
      createdAt: '2026-07-22T00:00:02.000Z',
      updatedAt: '2026-07-22T00:00:02.000Z',
    });

    await service.pollNow();

    expect(store.readSessions()).toEqual([
      expect.objectContaining({ threadId: 'station-child' }),
    ]);
    expect(source.read).toHaveBeenCalledOnce();
  });

  test('does not rediscover a provider child retained as a rollback tombstone', async () => {
    const ledger = store.createAdoptionLedger();
    const reservation = ledger.reserve({
      sourceThreadId: 'external:claude:source',
      targetThreadId: 'station-child',
      ownerId: 'cleanup-owner',
      ownerPid: -1,
      provider: 'claude',
      sourceSessionId: 'vendor-source',
      sourceKind: 'claude-transcript',
      cwd: session.cwd,
      projectRoot: join(dir, 'repository'),
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    expect(reservation.kind).toBe('owner');
    if (reservation.kind === 'owner') {
      reservation.adoption.recordFlowRun('cleanup-flow', false);
      reservation.adoption.markForking();
      reservation.adoption.recordProviderCursor(session.sessionId);
      reservation.adoption.markRollbackPending();
    }
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
      read: vi.fn().mockResolvedValue({ outcome: 'ok', events: [], cursor: 1 }),
    };
    const service = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'repository', workingDirectory: join(dir, 'repository') },
      ],
    });

    await service.pollNow();

    expect(source.read).not.toHaveBeenCalled();
    expect(
      store.readSessions().some((item) => item.threadId === session.threadId),
    ).toBe(false);
  });

  test('tombstones a raced attached alias after the follower restarts', async () => {
    store.upsertSession({
      provider: 'claude',
      threadId: session.threadId,
      status: 'ready',
      cwd: session.cwd,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: session.sessionId,
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:01.000Z',
    });
    store.upsertSession({
      provider: 'claude',
      threadId: 'station-child',
      status: 'ready',
      cwd: session.cwd,
      resumeCursor: session.sessionId,
      controlMode: 'station-owned',
      createdAt: '2026-07-22T00:00:02.000Z',
      updatedAt: '2026-07-22T00:00:02.000Z',
    });
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
      read: vi.fn().mockResolvedValue({ outcome: 'ok', events: [], cursor: 0 }),
    };
    const restarted = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ],
    });

    await restarted.pollNow();

    expect(store.readSessions()).toEqual([
      expect.objectContaining({ threadId: 'station-child' }),
    ]);
    expect(source.read).not.toHaveBeenCalled();
  });

  test('does not import an unmatched transcript and preserves prior transcript state when a source disappears', async () => {
    const source: AttachedSessionSource = {
      provider: 'claude',
      discover: vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'ok', sessions: [session] })
        .mockResolvedValueOnce({ outcome: 'missing_root', sessions: [] })
        .mockResolvedValueOnce({ outcome: 'ok', sessions: [session] }),
      read: vi.fn().mockResolvedValue({
        outcome: 'ok',
        events: [event('event-1')],
        cursor: 20,
      }),
    };
    const matched = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ],
    });
    await matched.pollNow();
    await matched.pollNow();
    expect(store.listEvents(session.threadId)).toHaveLength(3);

    const unmatched = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus,
      listProjects: () => [{ slug: 'other', workingDirectory: '/other' }],
    });
    await unmatched.pollNow();

    expect(store.listEvents(session.threadId)).toHaveLength(3);
    expect(metrics.attachedSessionDiscovery.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ source: 'claude-transcript', outcome: 'ok' }),
    );
  });

  /**
   * archive#1501, seam S5
   * (`docs/design/portable-project-identity.md` §2.2.1). What migrates is
   * where the roots COME FROM; the archive#1462 tie-break is untouched.
   */
  describe('project roots resolve through resolveProjectResource (station#1501)', () => {
    function pollingSource(): AttachedSessionSource {
      return {
        provider: 'claude',
        discover: vi
          .fn()
          .mockResolvedValue({ outcome: 'ok', sessions: [session] }),
        read: vi
          .fn()
          .mockResolvedValue({ outcome: 'ok', events: [], cursor: 1 }),
      };
    }

    test('a wired resolveProjectRoots supplies the candidates, and listProjects is not consulted', async () => {
      const listProjects = vi.fn(() => []);
      const service = new AttachedSessionFollowService({
        sources: [pollingSource()],
        eventStore: store,
        eventBus,
        listProjects,
        resolveProjectRoots: async () => [
          { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
        ],
      });

      await service.pollNow();

      expect(listProjects).not.toHaveBeenCalled();
      expect(store.readSessions()).toEqual([
        expect.objectContaining({ threadId: session.threadId }),
      ]);
    });

    test('an UNWIRED host falls back to listProjects, unchanged', async () => {
      const listProjects = vi.fn(() => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ]);
      const service = new AttachedSessionFollowService({
        sources: [pollingSource()],
        eventStore: store,
        eventBus,
        listProjects,
      });

      await service.pollNow();

      expect(listProjects).toHaveBeenCalled();
      expect(store.readSessions()).toEqual([
        expect.objectContaining({ threadId: session.threadId }),
      ]);
    });

    test('roots resolve ONCE per poll, not once per discovered session', async () => {
      const second = {
        ...session,
        sessionId: 'session-2',
        threadId: 'external:claude:hashed-session-2',
      };
      const resolveProjectRoots = vi.fn(async () => [
        { slug: 'app', workingDirectory: join(dir, 'repository', 'app') },
      ]);
      const service = new AttachedSessionFollowService({
        sources: [
          {
            provider: 'claude',
            discover: vi.fn().mockResolvedValue({
              outcome: 'ok',
              sessions: [session, second],
            }),
            read: vi
              .fn()
              .mockResolvedValue({ outcome: 'ok', events: [], cursor: 1 }),
          } satisfies AttachedSessionSource,
        ],
        eventStore: store,
        eventBus,
        listProjects: () => [],
        resolveProjectRoots,
      });

      await service.pollNow();
      expect(resolveProjectRoots).toHaveBeenCalledTimes(1);
      expect(store.readSessions()).toHaveLength(2);

      await service.pollNow();
      expect(resolveProjectRoots).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * The projection `runtime-initialize.ts` wires. Its whole content is the
   * never-drop-a-candidate rule, which is why it is a named function rather
   * than an inline `.map` at the wiring site.
   */
  describe('resolveAttachedProjectRoots (station#1501 seam S5)', () => {
    test('a resolver that can vouch for the project UPGRADES its root', async () => {
      const canonical = join(dir, 'repository', 'app');
      expect(
        await resolveAttachedProjectRoots(
          [{ slug: 'app', workingDirectory: '~/repository/app' }],
          async () => canonical,
        ),
      ).toEqual([{ slug: 'app', workingDirectory: canonical }]);
    });

    test('a resolver that CANNOT vouch keeps the raw root — a dropped candidate would manufacture a confident wrong attribution (station#1462)', async () => {
      const nested = join(dir, 'repository', 'app');
      const projects: AttachedProjectRoot[] = [
        { slug: 'alpha', workingDirectory: nested },
        // `beta` shares the directory but sits on a volume the resolver
        // cannot verify right now. Dropping it leaves `alpha` as the sole
        // candidate and the reverse map reports a confident `attributed`.
        { slug: 'beta', workingDirectory: nested },
      ];
      const roots = await resolveAttachedProjectRoots(projects, (slug) =>
        slug === 'alpha' ? nested : undefined,
      );

      expect(roots).toEqual(projects);
      expect(resolveAttachedProjectRoot(nested, roots)).toEqual({
        state: 'ambiguous',
        cwd: realpathSync(nested),
        workingDirectory: realpathSync(nested),
        candidates: ['alpha', 'beta'],
      });
    });

    test('a project with no stored directory and no resolution stays a member of the list with no directory', async () => {
      expect(
        await resolveAttachedProjectRoots(
          [{ slug: 'scope-only' }],
          async () => undefined,
        ),
      ).toEqual([{ slug: 'scope-only', workingDirectory: undefined }]);
    });

    /**
     * archive#1501 review, FIX 3. Each resolution can spawn a `git`
     * subprocess and this runs on a two-second poll, so the fan-out is
     * bounded. Without the pool the `Promise.all` starts every project at
     * once and `maxInFlight` below is the project count.
     */
    test('resolution fan-out is BOUNDED, not one subprocess per project at once', async () => {
      const projects = Array.from({ length: 12 }, (_, index) => ({
        slug: `p${index}`,
        workingDirectory: `/tmp/p${index}`,
      }));
      let inFlight = 0;
      let maxInFlight = 0;
      const roots = await resolveAttachedProjectRoots(
        projects,
        async (slug) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          // Yield the microtask queue so a concurrent starter would be
          // observed here rather than serialized by accident.
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return `/resolved/${slug}`;
        },
        3,
      );

      expect(maxInFlight).toBe(3);
      expect(maxInFlight).toBeLessThan(projects.length);
      // Bounding must not lose, reorder, or duplicate a candidate.
      expect(roots).toEqual(
        projects.map((project) => ({
          slug: project.slug,
          workingDirectory: `/resolved/${project.slug}`,
        })),
      );
    });

    test('the default bound is applied when no concurrency is supplied', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      await resolveAttachedProjectRoots(
        Array.from({ length: 20 }, (_, index) => ({ slug: `p${index}` })),
        async (slug) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return `/resolved/${slug}`;
        },
      );
      expect(maxInFlight).toBeGreaterThan(0);
      expect(maxInFlight).toBeLessThan(20);
    });

    test('fewer projects than the bound still resolves every one', async () => {
      expect(
        await resolveAttachedProjectRoots(
          [{ slug: 'only' }],
          async () => '/resolved/only',
          8,
        ),
      ).toEqual([{ slug: 'only', workingDirectory: '/resolved/only' }]);
      expect(
        await resolveAttachedProjectRoots([], async () => '/never', 8),
      ).toEqual([]);
    });
  });
});
