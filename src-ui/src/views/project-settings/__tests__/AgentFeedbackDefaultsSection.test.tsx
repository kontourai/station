// @vitest-environment jsdom

import type { ProjectPullRequestFeedbackDefaults } from '@kontourai/station-contracts/pull-request-feedback';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Project settings' Agent feedback: loading, a failed read with Retry, the
 * two switches saving at once, the consent line while on, the owner-only
 * rule for everyone else, and what turning them off leaves on.
 */

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'k',
    isCurrent: () => true,
  }),
}));
const sdk = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
}));
const flags = vi.hoisted(() => ({ headReview: false }));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(flags.headReview ? ['pull-request-head-review'] : []),
}));
vi.mock('@kontourai/station-sdk/pull-request-feedback', () => ({
  getProjectPullRequestFeedbackDefaults: (...args: unknown[]) =>
    sdk.read(...args),
  writeProjectPullRequestFeedbackDefaults: (...args: unknown[]) =>
    sdk.write(...args),
}));

import { AgentFeedbackDefaultsSection } from '../AgentFeedbackDefaultsSection';

const CONSENT = 'Existing pull requests keep their settings.';

function defaults(
  overrides: Partial<ProjectPullRequestFeedbackDefaults> = {},
  switches: Partial<ProjectPullRequestFeedbackDefaults['settings']> = {},
): ProjectPullRequestFeedbackDefaults {
  return {
    projectSlug: 'widgets',
    settings: {
      fixFailingChecks: false,
      addressReviewComments: false,
      reviewEachHead: false,
      ...switches,
    },
    canChange: true,
    stillOn: 0,
    ...overrides,
  };
}

function renderSection() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentFeedbackDefaultsSection slug="widgets" />
    </QueryClientProvider>,
  );
}

const fixChecks = () =>
  screen.findByRole('switch', { name: 'Fix failing checks automatically' });

beforeEach(() => {
  sdk.read.mockReset();
  sdk.write.mockReset();
  flags.headReview = false;
});
afterEach(cleanup);

describe('Agent feedback defaults', () => {
  test('says what it is for, off, with no consent line', async () => {
    sdk.read.mockResolvedValue(defaults());
    renderSection();
    expect(
      await screen.findByText(
        'Automatically send feedback for new pull requests from Task branches.',
      ),
    ).toBeTruthy();
    expect((await fixChecks()).getAttribute('aria-checked')).toBe('false');
    expect(
      screen.getByText(
        "Sends unresolved review threads and change requests to the Task's agent.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(CONSENT)).toBeNull();
  });

  test('a switch saves at once, and the consent line shows while on', async () => {
    sdk.read.mockResolvedValue(defaults());
    sdk.write.mockResolvedValue(defaults({}, { fixFailingChecks: true }));
    renderSection();
    fireEvent.click(await fixChecks());
    await waitFor(() =>
      expect(sdk.write).toHaveBeenCalledWith(
        'http://station.test',
        'widgets',
        { fixFailingChecks: true, addressReviewComments: false },
        expect.anything(),
      ),
    );
    expect(await screen.findByText(CONSENT)).toBeTruthy();
    expect((await fixChecks()).getAttribute('aria-checked')).toBe('true');
  });

  test('turned off with pull requests it turned on, says they keep feedback', async () => {
    sdk.read.mockResolvedValue(defaults({}, { fixFailingChecks: true }));
    sdk.write.mockResolvedValue(defaults({ stillOn: 3 }));
    renderSection();
    fireEvent.click(await fixChecks());
    expect(
      await screen.findByText(
        '3 pull requests still get feedback. Turn them off from each chat.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(CONSENT)).toBeNull();
  });

  test("someone other than the Station's owner sees them disabled", async () => {
    sdk.read.mockResolvedValue(
      defaults({ canChange: false }, { addressReviewComments: true }),
    );
    renderSection();
    expect((await fixChecks()).hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByText("Only this Station's owner can change these."),
    ).toBeTruthy();
    expect(screen.getByText(CONSENT)).toBeTruthy();
  });

  test('a refused save shows inline and leaves the switch as it was', async () => {
    sdk.read.mockResolvedValue(defaults());
    sdk.write.mockRejectedValue(
      new StationHttpError(404, 'Project unavailable'),
    );
    renderSection();
    fireEvent.click(await fixChecks());
    expect((await screen.findByRole('alert')).textContent).toBeTruthy();
    expect((await fixChecks()).getAttribute('aria-checked')).toBe('false');
  });

  test('a failed read offers Retry', async () => {
    sdk.read.mockRejectedValueOnce(new Error('network down'));
    renderSection();
    expect(
      await screen.findByText('Could not load agent feedback defaults'),
    ).toBeTruthy();
    sdk.read.mockResolvedValue(defaults());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await fixChecks()).toBeTruthy();
  });
});

describe('"Review each new head" in the defaults', () => {
  test('hidden while its preview is off, and left out of a write', async () => {
    sdk.read.mockResolvedValue(defaults({}, { reviewEachHead: true }));
    sdk.write.mockResolvedValue(defaults({}, { fixFailingChecks: true }));
    renderSection();
    fireEvent.click(await fixChecks());
    expect(
      screen.queryByRole('switch', { name: 'Review each new head' }),
    ).toBeNull();
    // Review alone does nothing while off: no consent line for it.
    await waitFor(() =>
      expect(sdk.write).toHaveBeenCalledWith(
        'http://station.test',
        'widgets',
        { fixFailingChecks: true, addressReviewComments: false },
        expect.anything(),
      ),
    );
  });

  test('shown with its preview, saves at once, and alone counts as on', async () => {
    flags.headReview = true;
    sdk.read.mockResolvedValue(defaults());
    sdk.write.mockResolvedValue(defaults({}, { reviewEachHead: true }));
    renderSection();
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Review each new head' }),
    );
    await waitFor(() =>
      expect(sdk.write).toHaveBeenCalledWith(
        'http://station.test',
        'widgets',
        {
          fixFailingChecks: false,
          addressReviewComments: false,
          reviewEachHead: true,
        },
        expect.anything(),
      ),
    );
    expect(await screen.findByText(CONSENT)).toBeTruthy();
  });
});
