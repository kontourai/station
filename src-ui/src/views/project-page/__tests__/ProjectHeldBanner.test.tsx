/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({
  previews: [] as Array<{ id: string; enabled: boolean }>,
  mutate: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useFeaturePreviewsQuery: () => ({ data: sdkMocks.previews }),
  useProjectLifecycleMutation: () => ({
    isPending: false,
    error: null,
    mutate: sdkMocks.mutate,
  }),
}));

import { ProjectHeldBanner } from '../ProjectHeldBanner';

const paused = { state: 'paused' as const, changedAt: '2026-11-16T09:00:00Z' };
const archived = {
  state: 'archived' as const,
  changedAt: '2026-11-16T09:00:00Z',
};

// The server refuses a held Project's turns and skips its schedules whatever
// the `project-pause-archive` preview says; the preview gates only starting a
// hold. So the banner that explains the refusal, and lifts the hold, shows
// with the preview off as well as on.
describe.each([
  ['off', []],
  ['on', [{ id: 'project-pause-archive', enabled: true }]],
])(
  'ProjectHeldBanner with the pause-and-archive preview %s',
  (_label, previews) => {
    beforeEach(() => {
      sdkMocks.previews = previews;
      sdkMocks.mutate.mockReset();
    });

    test('a paused Project says so and Resume lifts the hold', () => {
      render(<ProjectHeldBanner slug="atlas" lifecycle={paused} />);
      expect(screen.getByRole('status').textContent).toContain('Paused.');
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
      expect(sdkMocks.mutate).toHaveBeenCalledWith('resume');
    });

    test('an archived Project says so and Unarchive lifts the hold', () => {
      render(<ProjectHeldBanner slug="atlas" lifecycle={archived} />);
      expect(screen.getByRole('status').textContent).toContain('Archived.');
      fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
      expect(sdkMocks.mutate).toHaveBeenCalledWith('unarchive');
    });

    test('a Project that is not held shows no banner', () => {
      render(<ProjectHeldBanner slug="atlas" lifecycle={undefined} />);
      expect(screen.queryByRole('status')).toBeNull();
    });
  },
);
