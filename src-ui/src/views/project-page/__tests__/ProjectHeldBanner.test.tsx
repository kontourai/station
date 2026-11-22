/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({
  previews: [] as Array<{ id: string; enabled: boolean }>,
}));

vi.mock('@kontourai/station-sdk', () => ({
  useFeaturePreviewsQuery: () => ({ data: sdkMocks.previews }),
  useProjectLifecycleMutation: () => ({
    isPending: false,
    error: null,
    mutate: vi.fn(),
  }),
}));

import { ProjectHeldBanner } from '../ProjectHeldBanner';

const paused = { state: 'paused' as const, changedAt: '2026-11-16T09:00:00Z' };

describe('ProjectHeldBanner', () => {
  beforeEach(() => {
    sdkMocks.previews = [];
  });

  test('stays hidden for a held project while the project-pause-archive preview is off', () => {
    render(<ProjectHeldBanner slug="atlas" lifecycle={paused} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  test('says so, with the action that lifts the hold, while the preview is on', () => {
    sdkMocks.previews = [{ id: 'project-pause-archive', enabled: true }];
    render(<ProjectHeldBanner slug="atlas" lifecycle={paused} />);
    expect(screen.getByRole('status').textContent).toContain('Paused.');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
  });

  test('renders nothing for a project that is not held, preview on', () => {
    sdkMocks.previews = [{ id: 'project-pause-archive', enabled: true }];
    render(<ProjectHeldBanner slug="atlas" lifecycle={undefined} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
