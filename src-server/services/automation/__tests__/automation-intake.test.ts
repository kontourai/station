import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { AutomationEvent } from '@kontourai/station-contracts/automation';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  automationEpisodeKey,
  automationMatcherMatches,
  recordAutomationEvent,
} from '../automation-intake.js';
import {
  type AutomationLedger,
  createAutomationLedger,
} from '../automation-ledger.js';
import { AutomationPolicyUnavailableError } from '../automation-store.js';
import { normalizeGitHubWorkflowRun } from '../github-workflow-run.js';
import {
  QUALIFICATION_RULE,
  workflowRun,
} from './fixtures/workflow-run-fixture.js';

const makeTempDir = trackTempDirs();

const NOW = Date.parse('2026-10-06T08:00:00.000Z');
const RED_AT = '2026-10-06T06:34:46Z';

function event(run: Record<string, unknown>): AutomationEvent {
  const result = normalizeGitHubWorkflowRun(run, {
    source: {
      id: 'source-1',
      kind: 'github-poll',
      repository: 'kontourai/station',
    },
    receivedAt: NOW,
  });
  if (result.kind !== 'event') throw new Error(result.reason);
  return result.event;
}

const red = (
  overrides: Parameters<typeof workflowRun>[0] = { updatedAt: RED_AT },
) => event(workflowRun({ conclusion: 'failure', ...overrides }));

describe('automationMatcherMatches', () => {
  test('the qualification rule matches a red scheduled run on main', () => {
    expect(automationMatcherMatches(QUALIFICATION_RULE.match, red())).toBe(
      true,
    );
  });

  test.each([
    ['a fork head repository', { headRepository: 'someone/station' }],
    ['a push event', { event: 'push' }],
    ['a pull request branch', { headBranch: 'feature' }],
    ['a branch-less run', { headBranch: null }],
    ['a cancelled run', { conclusion: 'cancelled' }],
    ['a green run', { conclusion: 'success' }],
  ])('does not match %s', (_name, overrides) => {
    expect(
      automationMatcherMatches(
        QUALIFICATION_RULE.match,
        event(
          workflowRun({
            conclusion: 'failure',
            updatedAt: RED_AT,
            ...overrides,
          }),
        ),
      ),
    ).toBe(false);
  });

  test('is exact: no prefix, case folding or empty where', () => {
    const base = red();
    const where = (value: string) => ({
      type: 'github.workflow_run.completed' as const,
      where: { 'run.head_branch': value },
    });
    expect(automationMatcherMatches(where('mai'), base)).toBe(false);
    expect(automationMatcherMatches(where('MAIN'), base)).toBe(false);
    expect(automationMatcherMatches(where('main'), base)).toBe(true);
    expect(
      automationMatcherMatches(
        { type: 'github.workflow_run.completed', where: {} },
        base,
      ),
    ).toBe(false);
  });

  test('the episode key is JSON over the rule id and key fields', () => {
    expect(automationEpisodeKey(QUALIFICATION_RULE, red())).toBe(
      JSON.stringify([
        'rule-qualification',
        'kontourai/station',
        '.github/workflows/main-qualification.yml',
        'main',
      ]),
    );
  });
});

describe('recordAutomationEvent (observe-only)', () => {
  let directory: string;
  let ledger: AutomationLedger;

  beforeEach(() => {
    directory = makeTempDir('automation-intake-');
    ledger = createAutomationLedger({ directory, busyTimeoutMs: 200 });
  });
  afterEach(() => ledger.close());

  const record = (value: AutomationEvent, rules = [QUALIFICATION_RULE]) =>
    recordAutomationEvent({
      ledger,
      rules,
      event: value,
      transportId: value.semanticKey,
      now: NOW,
    });

  test('a red qualification run is recorded as matched and opens an episode', () => {
    const result = record(red());
    expect(result).toMatchObject({
      outcome: 'matched',
      matchedRuleIds: ['rule-qualification'],
      openedEpisodeIds: ['37423043587'],
    });
    expect(ledger.listDeliveries()).toEqual([
      expect.objectContaining({
        semanticKey: 'workflow_run:37423043587:1:completed',
        outcome: 'matched',
        ruleId: 'rule-qualification',
        episodeId: '37423043587',
      }),
    ]);
    expect(ledger.listEpisodes()).toEqual([
      expect.objectContaining({
        episodeId: '37423043587',
        state: 'open',
        attemptCount: 0,
      }),
    ]);
  });

  test('a failed episode write rolls back delivery dedupe and can be retried after restart', () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const database = new DatabaseSync(join(directory, 'automation.sqlite'));
    database.exec(`CREATE TRIGGER refuse_episode BEFORE INSERT ON automation_episodes
      BEGIN SELECT RAISE(ABORT, 'injected episode failure'); END`);
    try {
      expect(() => record(red())).toThrow(AutomationPolicyUnavailableError);
      expect(ledger.listDeliveries()).toEqual([]);
      expect(ledger.listEpisodes()).toEqual([]);
      database.exec('DROP TRIGGER refuse_episode');
      ledger.close();
      ledger = createAutomationLedger({ directory });
      expect(record(red())).toMatchObject({
        outcome: 'matched',
        openedEpisodeIds: ['37423043587'],
      });
      expect(record(red())).toMatchObject({ outcome: 'duplicate' });
      expect(ledger.listEpisodes()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  test('a fork run is no-match and opens nothing', () => {
    expect(
      record(red({ headRepository: 'someone/station', updatedAt: RED_AT })),
    ).toMatchObject({ outcome: 'no-match', openedEpisodeIds: [] });
    expect(ledger.listDeliveries()[0]).toMatchObject({ outcome: 'no-match' });
    expect(ledger.listEpisodes()).toEqual([]);
  });

  test('a second red run joins the open episode instead of opening another', () => {
    record(red());
    const second = record(red({ id: 37423099999, updatedAt: RED_AT }));
    expect(second).toMatchObject({ outcome: 'matched', openedEpisodeIds: [] });
    expect(ledger.listDeliveries()[0]).toMatchObject({
      outcome: 'matched',
      episodeId: '37423043587',
    });
    expect(ledger.listEpisodes()).toHaveLength(1);
  });

  test('a green run closes the episode and starts nothing', () => {
    record(red());
    const green = record(
      event(
        workflowRun({
          id: 37423100000,
          conclusion: 'success',
          updatedAt: RED_AT,
        }),
      ),
    );
    expect(green).toMatchObject({
      outcome: 'no-match',
      closedEpisodeIds: ['37423043587'],
    });
    expect(ledger.listDeliveries()[0]).toMatchObject({
      outcome: 'no-match',
      ruleId: 'rule-qualification',
      episodeId: '37423043587',
    });
    expect(ledger.listEpisodes()[0]).toMatchObject({ state: 'closed' });
    // Observe-only: nothing anywhere claims, starts or settles an action.
    expect(ledger.listDeliveries().map(({ outcome }) => outcome)).not.toContain(
      'started',
    );
  });

  test('re-recording the same run is a duplicate and writes no row', () => {
    record(red());
    expect(record(red())).toMatchObject({
      outcome: 'duplicate',
      duplicateLayer: 'transport',
    });
    expect(ledger.listDeliveries()).toHaveLength(1);
  });

  test('a new run attempt is a new delivery', () => {
    record(red());
    expect(record(red({ runAttempt: 2, updatedAt: RED_AT }))).toMatchObject({
      outcome: 'matched',
    });
    expect(
      ledger.listDeliveries().map(({ semanticKey }) => semanticKey),
    ).toEqual([
      'workflow_run:37423043587:2:completed',
      'workflow_run:37423043587:1:completed',
    ]);
  });

  test('a failing re-run after the episode closed opens a new episode', () => {
    record(red());
    record(
      event(
        workflowRun({
          id: 37423100000,
          conclusion: 'success',
          updatedAt: RED_AT,
        }),
      ),
    );
    const rerun = record(red({ runAttempt: 2, updatedAt: RED_AT }));
    expect(rerun).toMatchObject({
      outcome: 'matched',
      openedEpisodeIds: ['37423043587.2'],
    });
    expect(
      ledger.listEpisodes().map(({ episodeId, state }) => [episodeId, state]),
    ).toEqual([
      ['37423043587.2', 'open'],
      ['37423043587', 'closed'],
    ]);
  });

  test('a source with no actionable rules records the event as ignored', () => {
    expect(record(red(), [])).toMatchObject({ outcome: 'ignored' });
    expect(ledger.listDeliveries()[0]).toMatchObject({ outcome: 'ignored' });
  });

  test('a rule without an episode policy opens no observe-only episode', () => {
    const { episode: _episode, ...perDelivery } = QUALIFICATION_RULE;
    expect(record(red(), [perDelivery])).toMatchObject({
      outcome: 'matched',
      openedEpisodeIds: [],
    });
    expect(ledger.listEpisodes()).toEqual([]);
  });
});
