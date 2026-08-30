/** @vitest-environment jsdom */

import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type { EnrichedAgentProjection } from '@kontourai/station-contracts/enriched-agent';
import { describe, expect, test } from 'vitest';
import { schedulerRunnableAgents } from '../components/scheduler/AgentPicker';

const agent = (
  slug: string,
  overrides: Partial<EnrichedAgentProjection> = {},
): EnrichedAgentProjection => ({
  slug: agentId(slug),
  name: slug,
  ...overrides,
});

describe('scheduler Agent picker', () => {
  test('offers only agents the in-process scheduler runner can resolve', () => {
    const offered = schedulerRunnableAgents([
      agent('station'),
      agent('external-station', {
        execution: { agentConnectionId: engineConnectionId('claude') },
      }),
      agent('reviewer'),
      agent('claude', {
        execution: { agentConnectionId: engineConnectionId('claude') },
      }),
      agent('offline', { available: false }),
    ]);

    expect(offered.map(({ slug }) => slug)).toEqual(['station', 'reviewer']);
  });
});
