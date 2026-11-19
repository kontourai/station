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
