// @vitest-environment jsdom

import { getJson } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import {
  DelegationGrantPostureBadge,
  DelegationGrantSettings,
} from '../DelegationGrantSettings';

vi.mock('@kontourai/station-sdk', () => ({
  useFeaturePreviewsQuery: () => ({
    data: [{ id: 'delegation-grants', enabled: true }],
  }),
}));

vi.mock('@kontourai/station-sdk/client', () => ({
  getJson: vi.fn(),
  authenticatedFetch: vi.fn(),
}));

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'operator',
  }),
}));

test('reports confirmed risky writes in Settings and on the granted child', async () => {
  vi.mocked(getJson).mockImplementation(async (url) => {
    if (String(url).endsWith('/sessions/child')) {
      return Response.json({
        success: true,
        data: {
          access: 'confined',
          scope: 'project',
          ownWorktree: true,
          network: 'open',
          highRiskGitWrites: true,
        },
      });
    }
    return Response.json({
      success: true,
      ignoredEntries: 1,
      data: [
        {
          id: 'grant',
          access: 'confined',
          scope: { kind: 'project' },
          agents: ['codex'],
          models: ['coding'],
          projects: ['project'],
          ownWorktree: true,
          network: { mode: 'default' },
          expiry: { kind: 'revoked' },
          createdBy: 'operator',
          createdAt: 0,
          extraGitWritePaths: { project: ['hooks'] },
          children: ['child'],
          highRiskGitWrites: true,
        },
      ],
    });
  });
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <DelegationGrantSettings />
      <DelegationGrantPostureBadge
        apiBase="http://station.test"
        sessionId="child"
      />
    </QueryClientProvider>,
  );

  expect(await screen.findByText('High-risk Git writes')).toBeTruthy();
  expect(
    await screen.findByText(/Confined worktree.*High-risk Git writes/),
  ).toBeTruthy();
  expect(
    screen.getByText("Open (Codex can't enforce an allowlist)"),
  ).toBeTruthy();
  expect(
    screen.getByText(/Station ignored unsigned or invalid grants/),
  ).toBeTruthy();
});
