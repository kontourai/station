/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CredentialUsageSection } from '../views/connections-hub/CredentialUsageSection';

const byEngine: Record<string, unknown> = {};
let isError = false;

vi.mock('@kontourai/station-sdk', () => ({
  useCredentialUsageQuery: (id: string) => ({
    data: byEngine[id],
    isLoading: false,
    isError,
    refetch: vi.fn(),
  }),
}));

vi.mock('../views/connections-hub/ConnectionsHubSection', () => ({
  ConnectionsHubSection: ({ children }: { children: React.ReactNode }) => (
    <section>{children}</section>
  ),
}));

const AT = new Date().toISOString();

beforeEach(() => {
  for (const key of Object.keys(byEngine)) delete byEngine[key];
  isError = false;
});

describe('CredentialUsageSection (station#3552)', () => {
  test('renders a meter per window with the reset time', () => {
    byEngine.claude = [
      {
        ref: null,
        label: "This connection's account",
        usage: {
          status: 'ok',
          fetchedAt: AT,
          planLabel: 'Max',
          exhausted: false,
          windows: [
            {
              id: 'five-hour',
              label: '5-hour limit',
              usedPercent: 20,
              resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
            },
          ],
        },
      },
    ];
    render(<CredentialUsageSection />);
    expect(screen.getByText("This connection's account")).toBeTruthy();
    expect(screen.getByText('Max')).toBeTruthy();
    expect(screen.getByText('20%')).toBeTruthy();
    expect(screen.getByText('resets in 3h')).toBeTruthy();
// A real <meter> carries its value natively, so assert the element's own
// attributes rather than a hand-maintained aria triple.
    const meter = screen.getByRole('meter', { name: /5-hour limit used/i });
    expect(meter.tagName).toBe('METER');
    expect(meter.getAttribute('value')).toBe('20');
    expect(meter.getAttribute('max')).toBe('100');
  });

// The defect this whole surface exists to avoid: a failed read must not
// render as an empty meter, which a user reads as "nothing used".
  test('an unknown reading shows its reason and NO meter', () => {
    byEngine.codex = [
      {
        ref: 'work',
        label: 'Work',
        usage: {
          status: 'unknown',
          fetchedAt: AT,
          reason: 'The stored credential was rejected. Sign in again.',
        },
      },
    ];
    render(<CredentialUsageSection />);
    expect(screen.getByText('Usage unavailable')).toBeTruthy();
    expect(screen.getByText(/Sign in again/)).toBeTruthy();
    expect(screen.queryByRole('meter')).toBeNull();
  });

// `exhausted` is the provider's own verdict. A 100% window that the provider
// says is still allowed must NOT be badged as limit-reached, and a low
// percentage the provider says IS exhausted must be.
  test('the limit-reached badge follows the provider, not the percentage', () => {
    byEngine.claude = [
      {
        ref: 'a',
        label: 'Allowed at 100',
        usage: {
          status: 'ok',
          fetchedAt: AT,
          exhausted: false,
          windows: [{ id: 'w', label: 'Weekly', usedPercent: 100 }],
        },
      },
    ];
    byEngine.codex = [
      {
        ref: 'b',
        label: 'Blocked at 4',
        usage: {
          status: 'ok',
          fetchedAt: AT,
          exhausted: true,
          windows: [{ id: 'w', label: 'Weekly', usedPercent: 4 }],
        },
      },
    ];
    render(<CredentialUsageSection />);
    expect(screen.getAllByText('Limit reached')).toHaveLength(1);
    const blocked = screen.getByText('Blocked at 4').closest('li');
    expect(blocked?.textContent).toContain('Limit reached');
  });

  test('states when each reading was taken', () => {
    byEngine.claude = [
      {
        ref: null,
        label: 'Account',
        usage: {
          status: 'ok',
          fetchedAt: AT,
          exhausted: false,
          windows: [{ id: 'w', label: 'Weekly', usedPercent: 1 }],
        },
      },
    ];
    render(<CredentialUsageSection />);
    expect(screen.getByText(/read just now/i)).toBeTruthy();
  });

// An engine with no accounts, or one whose route 404s, renders nothing —
// better than a card that never fills.
  test('renders nothing for an engine with no accounts or an errored read', () => {
    byEngine.claude = [];
    const { container } = render(<CredentialUsageSection />);
    expect(container.querySelector('.credential-usage__engine')).toBeNull();

    isError = true;
    byEngine.codex = [
      {
        ref: null,
        label: 'x',
        usage: { status: 'unknown', fetchedAt: AT, reason: 'r' },
      },
    ];
    const errored = render(<CredentialUsageSection />);
    expect(
      errored.container.querySelector('.credential-usage__engine'),
    ).toBeNull();
  });
});

// restoring the old unconditional zero-window guard
// left all credential-usage tests green, so this behaviour was unprotected —
// and the card it produced contradicted itself.
describe('an exhausted account with no percentages', () => {
  test('says percentages are missing, not that there are no limits', () => {
    byEngine.claude = [
      {
        ref: null,
        label: 'Blocked, no percentages',
        usage: {
          status: 'ok',
          fetchedAt: AT,
          exhausted: true,
          windows: [],
        },
      },
    ];
    render(<CredentialUsageSection />);
    expect(screen.getByText('Limit reached')).toBeTruthy();
    expect(screen.getByText(/did not report usage percentages/i)).toBeTruthy();
// The contradictory sentence must not appear beneath a limit-reached badge.
    expect(
      screen.queryByText(/reported no limits for this account/i),
    ).toBeNull();
  });

  test('a NOT-exhausted account with no windows still reads as no limits', () => {
    byEngine.codex = [
      {
        ref: 'a',
        label: 'No limits',
        usage: { status: 'ok', fetchedAt: AT, exhausted: false, windows: [] },
      },
    ];
    render(<CredentialUsageSection />);
    expect(
      screen.getByText(/reported no limits for this account/i),
    ).toBeTruthy();
  });
});
