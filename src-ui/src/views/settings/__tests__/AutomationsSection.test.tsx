/** @vitest-environment jsdom */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const sources = vi.fn();
const rules = vi.fn();
const episodes = vi.fn();
const deliveries = vi.fn();
const retry = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useAutomationSources: () => sources(),
  useAutomationRules: () => rules(),
  useAutomationEpisodes: () => episodes(),
  useAutomationDeliveries: () => deliveries(),
  useRetryAutomationEpisode: () => ({
    mutate: retry,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

const { AutomationsSection } = await import('../AutomationsSection');

const ok = <T,>(data: T) => ({
  data,
  isLoading: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
});
const failed = (error: unknown) => ({
  data: undefined,
  isLoading: false,
  isError: true,
  error,
  refetch: vi.fn(),
});

const RULE = {
  id: 'rule-1',
  name: 'Diagnose red main',
  mode: 'live',
  sourceId: 'source-1',
  match: { type: 'github.workflow_run.completed', where: {} },
  action: { kind: 'dispatch-task' },
  rateLimit: { maxStartsPerHour: 2 },
};
const EPISODE = (episodeId: string, state: string) => ({
  ruleId: 'rule-1',
  episodeId,
  state,
  attemptCount: 1,
  maxAttempts: 1,
  openedAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:00:00.000Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  sources.mockReturnValue(
    ok({
      configurationFingerprint: 'f'.repeat(64),
      sources: [
        {
          id: 'source-1',
          kind: 'github-poll',
          name: 'Main',
          repository: 'kontourai/station',
          enabled: true,
        },
      ],
    }),
  );
  rules.mockReturnValue(
    ok({ configurationFingerprint: 'f'.repeat(64), rules: [RULE] }),
  );
  episodes.mockReturnValue(
    ok({ episodes: [EPISODE('41', 'exhausted'), EPISODE('42', 'open')] }),
  );
  deliveries.mockReturnValue(
    ok({
      polls: [],
      deliveries: ['a', 'b', 'c'].map((key) => ({
        deliveryKey: key.repeat(64),
        sourceId: 'source-1',
        semanticKey: `workflow_run:${key}:1:completed`,
        eventType: 'github.workflow_run.completed',
        receivedAt: '2026-11-06T00:00:00.000Z',
        updatedAt: '2026-11-06T00:00:00.000Z',
        outcome: key === 'b' ? 'suppressed' : 'matched',
        ...(key === 'b' ? { reason: 'rate-limited' } : {}),
      })),
    }),
  );
});

/** #4513: each heading's count is the length of the list it heads. */
test('every count equals the length of the list it heads', () => {
  render(<AutomationsSection />);
  for (const [title, count] of [
    ['Sources', 1],
    ['Rules', 1],
    ['Open episodes', 2],
    ['Recent deliveries', 3],
  ] as const) {
    const list = screen.getByRole('region', {
      name: new RegExp(`^${title}`),
    });
    expect(within(list).getByRole('heading').textContent).toBe(
      `${title} · ${count}`,
    );
    expect(within(list).getAllByRole('listitem')).toHaveLength(count);
  }
  expect(screen.getByText('suppressed · rate-limited')).toBeTruthy();
});

test('a delivery whose turn a person stopped reads as stopped by a person, not failed', () => {
  deliveries.mockReturnValue(
    ok({
      polls: [],
      deliveries: [
        {
          deliveryKey: 'd'.repeat(64),
          sourceId: 'source-1',
          semanticKey: 'workflow_run:d:1:completed',
          eventType: 'github.workflow_run.completed',
          receivedAt: '2026-11-06T00:00:00.000Z',
          updatedAt: '2026-11-06T00:00:00.000Z',
          outcome: 'stopped',
        },
      ],
    }),
  );
  render(<AutomationsSection />);
  const list = screen.getByRole('region', { name: /^Recent deliveries/ });
  expect(within(list).getByText('stopped by a person')).toBeTruthy();
  expect(within(list).queryByText(/failed/)).toBeNull();
});

test('only an exhausted episode offers a retry, naming that episode', () => {
  render(<AutomationsSection />);
  const buttons = screen.getAllByRole('button', { name: /^Retry episode/ });
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]!);
  expect(retry).toHaveBeenCalledWith({ ruleId: 'rule-1', episodeId: '41' });
});

test('one failed read is shown with a retry; the other lists stay usable', () => {
  const episodeRead = failed(new Error('Automation policy is unavailable.'));
  episodes.mockReturnValue(episodeRead);
  render(<AutomationsSection />);
  const list = screen.getByRole('region', { name: /^Open episodes/ });
  // No count for a list that could not be read.
  expect(within(list).getByRole('heading').textContent).toBe('Open episodes');
  fireEvent.click(within(list).getByRole('button', { name: 'Retry' }));
  expect(episodeRead.refetch).toHaveBeenCalled();
  expect(
    within(screen.getByRole('region', { name: /^Rules/ })).getAllByRole(
      'listitem',
    ),
  ).toHaveLength(1);
});

test('with the preview off the section says so instead of four errors', () => {
  const off = Object.assign(new Error('Enable it'), {
    code: 'feature_preview_disabled',
  });
  for (const read of [sources, rules, episodes, deliveries])
    read.mockReturnValue(failed(off));
  render(<AutomationsSection />);
  expect(
    screen.getByText('GitHub automation observations are off'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

test('the section is reachable from the Advanced page beside Feature previews', async () => {
  const { settingsPageForSection, settingsSectionsForView } = await import(
    '../settings-pages'
  );
  expect(settingsPageForSection('github-automations')?.id).toBe('advanced');
  const advanced = settingsSectionsForView('advanced');
  expect(advanced.indexOf('github-automations')).toBe(
    advanced.indexOf('feature-previews') + 1,
  );
});

test('an open episode whose start failed says the Agent did not start and offers a retry', () => {
  episodes.mockReturnValue(
    ok({
      episodes: [
        { ...EPISODE('43', 'open'), attemptCount: 0, startFailed: true },
        EPISODE('42', 'open'),
      ],
    }),
  );
  render(<AutomationsSection />);
  expect(
    screen.getAllByText(
      'The Agent did not start, so nothing ran. Retry is available.',
    ),
  ).toHaveLength(1);
  const buttons = screen.getAllByRole('button', { name: /^Retry episode/ });
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]!);
  expect(retry).toHaveBeenCalledWith({ ruleId: 'rule-1', episodeId: '43' });
});

test('a failed start on a rule that may not act says so and offers no retry', () => {
  rules.mockReturnValue(
    ok({
      configurationFingerprint: 'f'.repeat(64),
      rules: [{ ...RULE, mode: 'off' }],
    }),
  );
  episodes.mockReturnValue(
    ok({
      episodes: [
        { ...EPISODE('43', 'open'), attemptCount: 0, startFailed: true },
      ],
    }),
  );
  render(<AutomationsSection />);
  expect(
    screen.getByText(
      'The Agent did not start, so nothing ran. The rule is not live, so it cannot be retried.',
    ),
  ).toBeTruthy();
  expect(screen.queryAllByRole('button', { name: /^Retry episode/ })).toEqual(
    [],
  );
});

test('a start refused for the rule approval setting names the Agent and offers no retry until the rule changes', () => {
  rules.mockReturnValue(
    ok({
      configurationFingerprint: 'f'.repeat(64),
      rules: [
        { ...RULE, action: { kind: 'dispatch-task', agentId: 'helper' } },
      ],
    }),
  );
  episodes.mockReturnValue(
    ok({
      episodes: [
        {
          ...EPISODE('43', 'open'),
          attemptCount: 0,
          startFailed: true,
          startFailure: 'agent-own-approval-required',
          retryNeedsRuleChange: true,
        },
      ],
    }),
  );
  render(<AutomationsSection />);
  expect(
    screen.getByText(
      "Agent helper uses its own approval settings; set the rule's approval to the Agent's own, or change its Agent.",
    ),
  ).toBeTruthy();
  expect(screen.queryAllByRole('button', { name: /^Retry episode/ })).toEqual(
    [],
  );
});

test('a start refused for the approval setting says what brings Retry back', () => {
  rules.mockReturnValue(
    ok({
      configurationFingerprint: 'f'.repeat(64),
      rules: [
        { ...RULE, action: { kind: 'dispatch-task', agentId: 'helper' } },
      ],
    }),
  );
  episodes.mockReturnValue(
    ok({
      episodes: [
        {
          ...EPISODE('43', 'open'),
          attemptCount: 0,
          startFailed: true,
          startFailure: 'agent-option-unsupported',
          retryNeedsRuleChange: true,
        },
      ],
    }),
  );
  render(<AutomationsSection />);
  expect(
    screen.getByText(
      "Agent helper cannot take this approval setting. Retry returns when you change the rule's setting or its Agent.",
    ),
  ).toBeTruthy();
  expect(screen.queryAllByRole('button', { name: /^Retry episode/ })).toEqual(
    [],
  );
});

test('a Task that could not be canceled is shown and not retried over', () => {
  episodes.mockReturnValue(
    ok({
      episodes: [
        {
          ...EPISODE('43', 'open'),
          attemptCount: 0,
          startFailed: true,
          startFailure: 'task-not-canceled',
        },
      ],
    }),
  );
  render(<AutomationsSection />);
  expect(
    screen.getByText(
      'The Agent did not start, and its Task could not be canceled. Cancel that Task before retrying.',
    ),
  ).toBeTruthy();
  expect(screen.queryAllByRole('button', { name: /^Retry episode/ })).toEqual(
    [],
  );
});

test('each rule shows its effective approval posture', () => {
  rules.mockReturnValue(
    ok({
      configurationFingerprint: 'f'.repeat(64),
      rules: [
        { ...RULE, id: 'r1', name: 'One', action: { kind: 'dispatch-task' } },
        {
          ...RULE,
          id: 'r2',
          name: 'Two',
          action: { kind: 'dispatch-task', approvalMode: 'connection-default' },
        },
      ],
    }),
  );
  render(<AutomationsSection />);
  expect(
    screen.getByText('One · dispatch-task · Asks before acting'),
  ).toBeTruthy();
  expect(
    screen.getByText("Two · dispatch-task · Agent's own approval settings"),
  ).toBeTruthy();
});

test('paused automation Tasks are shown while Station cannot read its Projects', () => {
  episodes.mockReturnValue(
    ok({
      episodes: [],
      actionsUnavailable: {
        reason: 'projects-unreadable',
        since: '2026-11-06T00:00:00.000Z',
        detail: "project record identity does not match directory 'broken'",
      },
    }),
  );
  render(<AutomationsSection />);
  expect(
    screen.getByText(
      "Automation Tasks are paused: Station cannot read its Projects. Pending runs start once it can. project record identity does not match directory 'broken'",
    ),
  ).toBeTruthy();
});
