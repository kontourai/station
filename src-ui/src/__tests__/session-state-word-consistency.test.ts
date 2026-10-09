import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { sessionLadderWord } from '@kontourai/station-contracts/session-attention';
import { describe, expect, test } from 'vitest';
import {
  HOME_LIFECYCLE_LABELS,
  type HomeLifecycleLabel,
} from '../utils/lifecycle-priority';
import { workStatus } from '../views/home/work-status';
import {
  partitionSessionLanes,
  type SessionLaneId,
  sessionWorkStatuses,
} from '../views/sessions/sessions-lane-model';

/**
 * archive#3227 A1 — THE INVARIANT, not four spot checks.
 *
 * A row's status word must never contradict the lane heading it sits under.
 * Rather than asserting one word per known-bad shape, this walks the whole
 * lane partition over a mixed fixture and checks every session in it, so a
 * change to the fold or to the ladder that reintroduces a contradiction
 * fails here regardless of which shape produced it.
 *
 * `LANE_VOCABULARY` is written out independently of the ladder's own word
 * table. Deriving it from `work-status.ts` would make this test agree with
 * the code by construction and prove nothing; stated here it is a claim
 * about what each heading is allowed to sit above, which the code has to
 * satisfy. It is also THE vocabulary (design round 2026-10, C1): one word
 * per state, the same word on every surface, and the synonym scan at the
 * bottom fails the build on a second one.
 */
const LANE_VOCABULARY: Record<SessionLaneId, ReadonlySet<string>> = {
  // Started in another app; this Station cannot answer in it.
  external: new Set(['Elsewhere']),
  // You owe this session something. Which thing you owe is the refinement;
  // "Waiting on you" is the generic rung when no kind was recorded. The
  // ladder's "Queued to send" is also a Needs-you word, but it comes from a
  // device-local chat fact (a send queued offline) that a session list never
  // carries, so this walk cannot produce it and the test below would refuse
  // it; `work-status.test.ts` pins its lane.
  needsYou: new Set([
    'Needs approval',
    'Needs answer',
    'Interrupted',
    'Blocked',
    'Waiting on you',
  ]),
  // In flight. The only words that may claim work is happening.
  running: new Set(['Running', 'No progress', '1 sub-agent']),
  // Idle or stranded — not finished, not in flight, not yours to discharge.
  // "Elsewhere" belongs to this lane by design (archive#1783: an
  // unanswerable session did not FINISH, it stopped being reachable, so it
  // is not filed under Just finished). "Running" is deliberately absent: an
  // idle lane whose row says Running is the owner's "Active with no
  // activity" complaint in the other direction.
  idle: new Set(['Idle', 'Elsewhere']),
  // Over. The refinement is which ending.
  recentlyFinished: new Set(['Done', 'Stopped', 'Failed']),
  // #2310: nothing has been sent. Not "Queued" or "Running" — the raw state
  // of a never-prompted session is a transport fact, and either word would
  // claim work exists.
  drafts: new Set(['Draft']),
  earlier: new Set(['Done', 'Stopped', 'Failed']),
};

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function session(
  overrides: Partial<OrchestrationSessionSummary> & { threadId: string },
): OrchestrationSessionSummary {
  return {
    provider: 'claude',
    status: 'ready',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 4,
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

const UNANSWERABLE = {
  answerable: false,
  qualification: 'provider_absent',
  observedBy: 'station-test',
  observedAt: '2026-08-18T11:00:00.000Z',
} as const;

/**
 * Every lifecycle state, every fold override, and the shapes that used to
 * disagree — in one list, so the walk below has something to catch. The four
 * A1 rows are first and named; the rest exist so no lane is accidentally
 * empty and no state is unrepresented.
 */
const MIXED_FIXTURE: OrchestrationSessionSummary[] = [
  // A1 shape 1 (#1069): lane Idle, row used to say "Running".
  session({
    threadId: 'a1-idle-running',
    lifecycleState: 'running',
    hasActiveTurn: false,
  }),
  // A1 shape 2: lane Needs you, row used to say "Running".
  session({
    threadId: 'a1-review-while-running',
    lifecycleState: 'running',
    hasActiveTurn: true,
    pendingReview: true,
  }),
  // A1 shape 3 (#1296): lane Recently finished, row used to say "Running".
  session({
    threadId: 'a1-closed-while-running',
    lifecycleState: 'running',
    hasActiveTurn: true,
    status: 'closed',
  }),
  // A1 shape 4 (#1783): lane Idle, row used to say "Waiting on you".
  session({
    threadId: 'a1-unanswerable',
    lifecycleState: 'needs_input',
    answerability: UNANSWERABLE,
  }),
  session({ threadId: 'needs-input', lifecycleState: 'needs_input' }),
  session({
    threadId: 'question',
    lifecycleState: 'needs_input',
    transitionReason: 'input_requested',
  }),
  session({
    threadId: 'interrupted',
    lifecycleState: 'needs_input',
    transitionReason: 'runtime_exit',
  }),
  session({
    threadId: 'review-pending',
    lifecycleState: 'review_pending',
    pendingReview: true,
  }),
  session({ threadId: 'blocked', lifecycleState: 'blocked' }),
  session({
    threadId: 'running',
    lifecycleState: 'running',
    hasActiveTurn: true,
  }),
  session({
    threadId: 'running-children',
    lifecycleState: 'running',
    hasActiveTurn: true,
    conversationActivity: {
      conversationId: 'running-children',
      currentThreadId: 'running-children',
      asOfSequence: 1,
      runningChildWork: { count: 1, producers: ['engine-subagent'] },
    },
  }),
  session({
    threadId: 'running-silent',
    lifecycleState: 'running',
    hasActiveTurn: true,
    turnProgress: {
      lastProgressEventAt: new Date(NOW - 60_000).toISOString(),
      progressSilence: {
        detectedAt: new Date(NOW).toISOString(),
        windowMs: 30_000,
        silentSinceEventAt: new Date(NOW - 60_000).toISOString(),
        provider: 'claude',
      },
    },
  }),
  session({ threadId: 'queued', lifecycleState: 'queued' }),
  session({
    threadId: 'turn-before-state',
    lifecycleState: 'queued',
    hasActiveTurn: true,
  }),
  // #2310: the server's lineage fold says nothing has ever been sent. The
  // two raw states a never-prompted session actually carries: `queued` once
  // the engine reports ready, `running` once `session.configured` attaches.
  session({
    threadId: 'draft-engine-ready',
    lifecycleState: 'queued',
    hasActiveTurn: false,
    draft: true,
  }),
  session({
    threadId: 'draft-attached',
    lifecycleState: 'running',
    hasActiveTurn: false,
    draft: true,
  }),
  session({ threadId: 'just-completed', lifecycleState: 'completed' }),
  session({ threadId: 'just-failed', lifecycleState: 'failed' }),
  session({ threadId: 'just-canceled', lifecycleState: 'canceled' }),
  session({ threadId: 'closed-undecorated', status: 'closed' }),
  session({
    threadId: 'attached',
    lifecycleState: 'running',
    controlMode: 'read-only-attached',
  }),
  // Old enough to fall out of Recently finished into Earlier.
  session({
    threadId: 'long-completed',
    lifecycleState: 'completed',
    updatedAt: new Date(NOW - 5 * 3_600_000).toISOString(),
  }),
  session({
    threadId: 'long-failed',
    lifecycleState: 'failed',
    updatedAt: new Date(NOW - 5 * 3_600_000).toISOString(),
  }),
];

describe('a row word can never contradict its lane heading', () => {
  const lanes = partitionSessionLanes({
    sessions: MIXED_FIXTURE,
    agents: [],
    now: NOW,
  });
  // The Activity list's words, from the one ladder read it makes.
  const words = sessionWorkStatuses(MIXED_FIXTURE, [], NOW);
  const wordOf = (threadId: string) => {
    const status = words.get(threadId);
    if (!status) throw new Error(`no status for ${threadId}`);
    return status.word;
  };

  test('the fixture reaches every lane, so the walk below has power', () => {
    // Without this, a fixture edit that emptied a lane would leave the walk
    // green while checking nothing — the "unreachable fixture" failure mode.
    expect(lanes.map((lane) => lane.id).sort()).toEqual([
      'drafts',
      'earlier',
      'external',
      'idle',
      'needsYou',
      'recentlyFinished',
      'running',
    ]);
    expect(lanes.reduce((total, lane) => total + lane.sessions.length, 0)).toBe(
      MIXED_FIXTURE.length,
    );
  });

  test('the word the server tools use (contracts) is the ladder’s own, for every session in the walk', () => {
    // `list_project_activity` words a session with `sessionLadderWord`, not a
    // copy: the two must agree on every shape here. The UI's Running rung
    // alone refines its word with UI facts (a sub-agent count, the no-progress
    // marker), which the server's summary-only read leaves as "Running".
    const refinements = /^(\d+ sub-agents?|No progress)$/;
    for (const entry of MIXED_FIXTURE) {
      const ui = wordOf(entry.threadId);
      expect([entry.threadId, sessionLadderWord(entry)]).toEqual([
        entry.threadId,
        refinements.test(ui) ? 'Running' : ui,
      ]);
    }
  });

  test('every session in every lane prints a word that lane permits', () => {
    const seen: string[] = [];
    for (const lane of lanes) {
      for (const entry of lane.sessions) {
        const word = wordOf(entry.threadId);
        seen.push(`${lane.id}/${entry.threadId}/${word}`);
        expect(
          LANE_VOCABULARY[lane.id].has(word),
          `${entry.threadId} sits under "${lane.heading}" but its row says "${word}"`,
        ).toBe(true);
      }
    }
    // Pinned so a silently-shrinking walk is visible in the diff rather than
    // passing quietly with fewer rows checked.
    expect(seen).toHaveLength(MIXED_FIXTURE.length);
  });

  test('every word in the vocabulary is actually produced by some fixture', () => {
    // The allowance above is only a claim if each word can be reached: an
    // entry nothing produces would let a retired word linger as "permitted".
    const produced = new Set(MIXED_FIXTURE.map((s) => wordOf(s.threadId)));
    for (const allowed of Object.values(LANE_VOCABULARY)) {
      for (const word of allowed) expect(produced).toContain(word);
    }
  });

  test('the four A1 shapes land where the audit said, with the corrected word', () => {
    const laneOf = (threadId: string) =>
      lanes.find((lane) =>
        lane.sessions.some((entry) => entry.threadId === threadId),
      )?.id;

    expect(laneOf('a1-idle-running')).toBe('idle');
    expect(wordOf('a1-idle-running')).toBe('Idle');

    expect(laneOf('a1-review-while-running')).toBe('needsYou');
    expect(wordOf('a1-review-while-running')).toBe('Needs approval');

    expect(laneOf('a1-closed-while-running')).toBe('recentlyFinished');
    expect(wordOf('a1-closed-while-running')).toBe('Done');

    expect(laneOf('a1-unanswerable')).toBe('idle');
    expect(wordOf('a1-unanswerable')).toBe('Elsewhere');
  });

  test('the lane headings are the shared names', () => {
    expect(lanes.map((lane) => lane.label)).toEqual([
      'Needs you',
      'Running',
      'Idle',
      'Drafts',
      'Just finished',
      'Earlier',
      'From other apps',
    ]);
  });
});

/**
 * The same invariant for the inbox row's status word (Home rows, the dock
 * inbox, the mobile switcher), read straight off the ladder (`workStatus`)
 * with no facts. The owner's report — "'Active' feels incorrect when
 * there's no activity" — held for these rows too: rows under the Running
 * lane read "Active". Lane and permitted words are written out here,
 * independently of the ladder, so it cannot agree with this table by
 * construction.
 */
describe('a row status word never contradicts its lane', () => {
  const WORD_LANE: Record<HomeLifecycleLabel, string> = {
    'Needs attention': 'needsYou',
    Running: 'running',
    Ready: 'idle',
    Recent: 'idle',
    Current: 'idle',
    Unanswerable: 'idle',
    Draft: 'drafts',
    Completed: 'finished',
    Failed: 'finished',
    Stopped: 'finished',
  };
  const WORD_VOCABULARY: Record<string, ReadonlySet<string>> = {
    needsYou: new Set(['Waiting on you']),
    running: new Set(['Running']),
    idle: new Set(['Idle', 'Elsewhere']),
    drafts: new Set(['Draft']),
    finished: new Set(['Done', 'Failed', 'Stopped']),
  };
  const statusOf = (lifecycleLabel: HomeLifecycleLabel) =>
    workStatus(
      {
        id: 'row',
        kind: 'orchestration',
        kindLabel: 'Session',
        title: 'Row',
        projectLabel: 'p',
        agentLabel: 'a',
        modelLabel: 'm',
        updatedAt: 0,
        lifecycleLabel,
      },
      0,
    );

  test.each([...HOME_LIFECYCLE_LABELS])(
    '%s reads a word its lane permits',
    (lifecycle) => {
      const { lane, word } = statusOf(lifecycle);
      expect(lane).toBe(WORD_LANE[lifecycle]);
      expect(
        WORD_VOCABULARY[lane].has(word),
        `${lifecycle} sits in ${lane} but its row says "${word}"`,
      ).toBe(true);
    },
  );

  test('a Running-lane row reads "Running", never "Active"', () => {
    expect(statusOf('Running').word).toBe('Running');
    for (const lifecycle of HOME_LIFECYCLE_LABELS) {
      expect(statusOf(lifecycle).word).not.toBe('Active');
    }
  });
});

/**
 * THE SYNONYM SCAN (design round 2026-10, C1/C2/C9/C10). The audit found the
 * same state named four ways ("Needs approval" on the row, "Review pending"
 * in Activity, "Awaiting approval" in the Plan panel, "Approval needed" in
 * the chat strip) and seven time formats. The ladder is now the only source
 * of status words and `relativeTime` the only time format on these
 * surfaces; this scan fails on a synonym, a retired lane name, a retired
 * noun or a sentence-form time written back into any of them.
 *
 * A structural scan is the right proof for a vocabulary rule: the rule IS
 * about which strings exist in the source. Comments are stripped first, so
 * a comment may still name a retired word to explain why it went.
 */
const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The surfaces the vocabulary governs. */
const SURFACE_ROOTS = [
  'components/home',
  // The start composer (Home and the dock's draft) and its dock host.
  'components/chat-start',
  'components/modals/NewChatModal.tsx',
  'components/inbox-row',
  'components/chat-dock',
  'components/project-sidebar',
  'components/session-detail',
  'components/status',
  'views/home',
  'views/activity',
  'views/sessions',
  'views/project-page',
  'views/SessionsView.tsx',
  'views/HomeView.tsx',
  'components/flow/WorkflowPlanPanel.tsx',
  'components/chat/PendingApprovalStrip.tsx',
  'components/chat/TurnActivityProgress.tsx',
  'components/chat/ChatEmptyState.tsx',
  // The transcript's approval marker sits beside the status pill (#3312).
  'components/chat/ToolCallDisplay.tsx',
  'components/chat/ToolCallBatch.tsx',
];

/**
 * Retired words, each paired with the one that replaced it, so the failure
 * says what to write. Matched case-blind against the source once comments
 * are gone.
 */
const RETIRED: ReadonlyArray<[retired: string, use: string]> = [
  ['Review pending', 'Needs approval'],
  ['Awaiting approval', 'Needs approval'],
  ['Approval required', 'Needs approval'],
  ['Approval needed', 'Needs approval'],
  ['approvals needed', 'Needs approval (n)'],
  ['Needs your answer', 'Needs answer'],
  ['Engine complete', 'Done'],
  ['Engine running', 'Running'],
  ['Tool activity running', 'Running · tool'],
  ["Can't answer here", 'Elsewhere'],
  ['sub-agents running', 'N sub-agents'],
  ['sub-agent running', 'N sub-agents'],
  ['Background work running', 'Running'],
  [
    'No progress for',
    'No progress · Nm (the banner: ProgressSilenceObservation)',
  ],
  ['No progress events', 'No progress · Nm'],
  ['No response from', 'No progress from <engine> for Ns'],
  ['Still waiting', 'No progress'],
  ['appears stalled', 'No progress for Nm'],
  ['last activity', 'nothing: the row corner carries the time'],
  ['nothing sent yet', 'Draft'],
  ['just now', 'now'],
  ['Recently finished', 'Just finished'],
  ['Conversation history', 'History'],
  ['Copy thread ID', 'Copy chat ID'],
  ['Expand chat list', 'Show inbox'],
  ['Collapse chat list', 'Hide inbox'],
  ['Session inventory', 'Chat inventory'],
  ['Open code layout', 'Open in Coding'],
  ['Model not reported', 'omit the model'],
  ['Loading conversation', 'Loading chat'],
  ['Opening conversation', 'Opening chat'],
  ['Catching up conversation', 'Catching up'],
  ['Start a conversation', 'Start a chat'],
  ['Conversation details', 'Chat details'],
  ['Close conversation history', 'Close history'],
  // The history lane is one flat list on every surface; the row's own time
  // says when. Dated sub-headings were a second set of names for one lane.
  ['Earlier today', 'Earlier (the lane; the row time says when)'],
  ['Yesterday', 'Earlier (the lane; the row time says when)'],
  ['This week', 'Earlier (the lane; the row time says when)'],
];

/** Where a retired string may still legitimately appear, and why. */
const RETIRED_ALLOWED: ReadonlyArray<[file: string, retired: string]> = [
  // The banner's one sentence form of the ladder's "No progress · Nm".
  ['components/home/ProgressSilenceObservation.tsx', 'No progress for'],
  // The literal the model resolver returns, filtered OUT here, never shown.
  ['components/chat-dock/ChatInboxHoverCard.tsx', 'Model not reported'],
  ['components/chat-start/StartComposer.tsx', 'Model not reported'],
  ['components/chat-dock/command-launcher-model.ts', 'Model not reported'],
  ['views/home/home-view-model.ts', 'Model not reported'],
];

/** Time helpers that are not the one format. */
const RETIRED_TIME_CALLS = [
  'relativeTimeAgo(',
  'toLocaleTimeString(',
  'toLocaleDateString(',
  'formatDistance',
];

function sourceFilesUnder(path: string, found: string[] = []): string[] {
  const full = join(SRC_ROOT, path);
  if (statSync(full).isFile()) {
    found.push(full);
    return found;
  }
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const child = join(full, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      sourceFilesUnder(relative(SRC_ROOT, child), found);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name))
      continue;
    found.push(child);
  }
  return found;
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\/[^\n]*\n/g, '{')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

describe('one vocabulary on the work surfaces', () => {
  const files = SURFACE_ROOTS.flatMap((root) => sourceFilesUnder(root));

  test('the scan reaches the surfaces it guards', () => {
    const names = files.map((file) =>
      relative(SRC_ROOT, file).replaceAll('\\', '/'),
    );
    for (const guarded of [
      'views/home/work-status.ts',
      'views/SessionsView.tsx',
      'components/chat-dock/ChatDockInboxRows.tsx',
      'components/chat-dock/ChatInboxHoverCard.tsx',
      'components/chat-dock/ChatDockHeader.tsx',
      'components/home/HomeRecentWorkSection.tsx',
      'components/flow/WorkflowPlanPanel.tsx',
      'components/chat/ToolCallDisplay.tsx',
      'components/chat/ToolCallBatch.tsx',
    ]) {
      expect(names).toContain(guarded);
    }
    expect(files.length).toBeGreaterThan(60);
  });

  test('no surface writes a retired status word, lane name, noun or time form', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const name = relative(SRC_ROOT, file).replaceAll('\\', '/');
      const source = withoutComments(readFileSync(file, 'utf8'));
      // Case-blind: a retired word is retired at the start of a label and
      // mid-sentence alike ("Awaiting approval", "2 awaiting approval").
      const folded = source.toLowerCase();
      for (const [retired, use] of RETIRED) {
        if (!folded.includes(retired.toLowerCase())) continue;
        if (RETIRED_ALLOWED.some(([f, r]) => f === name && r === retired))
          continue;
        offenders.push(`${name}: "${retired}" — write "${use}"`);
      }
      for (const call of RETIRED_TIME_CALLS) {
        if (source.includes(call))
          offenders.push(`${name}: ${call} — use relativeTime/absoluteTime`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the ladder is the only module that spells its words', () => {
    // A second table of the same words is how two surfaces drift: every
    // status word is spelled in work-status.ts and read from there. The
    // Plan strip and the approval strip render documented longer forms of
    // "Needs approval"; nothing else may spell a rung's word.
    const WORDS = [
      "'Needs approval'",
      "'Needs answer'",
      "'Interrupted'",
      "'Elsewhere'",
      "'Idle'",
      "'Done'",
    ];
    const spellers = new Set([
      'views/home/work-status.ts',
      // The lane names: "Idle" is both a lane and the word for its rows.
      'views/home/home-lane-model.ts',
      // The glyph table's accessible names, keyed by the fold's label.
      'components/status/StatusGlyph.tsx',
      // The Plan strip's and the chat status pill's documented longer forms
      // ("Needs approval (2)").
      'components/flow/WorkflowPlanPanel.tsx',
      'components/status/chatStatus.ts',
    ]);
    const offenders: string[] = [];
    for (const file of files) {
      const name = relative(SRC_ROOT, file).replaceAll('\\', '/');
      if (spellers.has(name)) continue;
      const source = withoutComments(readFileSync(file, 'utf8'));
      for (const word of WORDS) {
        if (source.includes(word)) offenders.push(`${name}: ${word}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
