/** @vitest-environment jsdom */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

const observation = vi.hoisted(() => ({
  value: undefined as number | undefined,
}));
vi.mock('../contexts/StatsContext', () => ({
  useStats: () => ({
    stats: { contextWindowPercentage: observation.value },
    error: null,
    loading: false,
    refetch: vi.fn(),
  }),
}));

import { ContextDiagnostics } from '../views/monitoring/ContextDiagnostics';

const session: OrchestrationSessionSummary = {
  provider: 'codex',
  threadId: 'context-session',
  status: 'ready',
  controlMode: 'station-owned',
  answerability: { answerable: true },
  isLoaded: true,
  isPersisted: true,
  eventCount: 3,
  createdAt: '2026-10-07T12:00:00Z',
  updatedAt: '2026-10-07T12:00:00Z',
  assignedAgentSlug: agentId('analyst'),
  conversationId: 'context-conversation',
  displayTitle: 'Context investigation',
};

test('context occupancy distinguishes unreported values from a reported zero', () => {
  const mounted = render(
    <ContextDiagnostics sessions={[session]} readStatus="success" />,
  );
  expect(screen.queryByText('0.0%')).toBeNull();
  observation.value = 0;
  mounted.rerender(
    <ContextDiagnostics sessions={[session]} readStatus="success" />,
  );
  expect(screen.getByText('0.0%')).toBeTruthy();
  observation.value = Number.NaN;
  mounted.rerender(
    <ContextDiagnostics sessions={[session]} readStatus="success" />,
  );
  expect(screen.queryByText('NaN%')).toBeNull();
  expect(screen.queryByText('0.0%')).toBeNull();
});
