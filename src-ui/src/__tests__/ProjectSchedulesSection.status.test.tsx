/**
 * @vitest-environment jsdom
 *
 * A Project's schedules say their state in the Automations words: a paused
 * schedule reads Paused (never "Off"), and a one-time schedule that has run
 * reads Done.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const jobs = vi.hoisted(() => ({ data: [] as unknown[] }));

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSchedulerJobs: () => ({
    data: jobs.data,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useProjectSchedulesCapability: () => ({ data: true }),
}));

import { ProjectSchedulesSection } from '../views/project-settings/ProjectSchedulesSection';

describe('ProjectSchedulesSection status words', () => {
  test('paused reads Paused, a one-time schedule that ran reads Done', () => {
    const past = Date.now() - 86_400_000;
    jobs.data = [
      {
        name: 'paused-digest',
        displayName: 'Paused digest',
        provider: 'built-in',
        prompt: 'x',
        projectId: 'p1',
        enabled: false,
        schedule: { kind: 'cron', expr: '0 9 * * 1' },
      },
      {
        name: 'one-off',
        displayName: 'One-off review',
        provider: 'built-in',
        prompt: 'x',
        projectId: 'p1',
        enabled: true,
        schedule: { kind: 'at', timeMs: past },
        lastRun: new Date(past + 1_000).toISOString(),
      },
    ];
    render(
      <ProjectSchedulesSection
        projectId="p1"
        projectName="Atlas"
        held={false}
      />,
    );
    const row = (name: string) =>
      screen.getByText(name).closest('.page-row') as HTMLElement;
    expect(within(row('Paused digest')).getByText('Paused')).toBeTruthy();
    expect(within(row('One-off review')).getByText('Done')).toBeTruthy();
    expect(screen.queryByText('Off')).toBeNull();
  });
});
