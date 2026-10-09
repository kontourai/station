/** @vitest-environment jsdom */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const observation = vi.hoisted(() => ({
  value: undefined as number | undefined,
  source: 'engine-events' as 'engine-events' | 'station-memory',
  notFound: false,
}));
vi.mock('../contexts/StatsContext', () => ({
  useStats: () => ({
    stats: {
      contextWindowPercentage: observation.value,
      measurement: { source: observation.source },
      ...(observation.notFound ? { notFound: true } : {}),
    },
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

beforeEach(() => {
  observation.value = undefined;
  observation.source = 'engine-events';
  observation.notFound = false;
});
test('context names Station estimates and suppresses missing-conversation values', () => {
  observation.value = 1.5;
  observation.source = 'station-memory';
  const mounted = render(
    <ContextDiagnostics sessions={[session]} readStatus="success" />,
  );
  expect(screen.getByText('Estimated context occupancy')).toBeTruthy();
  expect(screen.getByText('1.5%')).toBeTruthy();
  expect(screen.queryByText('Reported context occupancy')).toBeNull();
  observation.notFound = true;
  mounted.rerender(
    <ContextDiagnostics sessions={[session]} readStatus="success" />,
  );
  expect(screen.queryByText('1.5%')).toBeNull();
});
