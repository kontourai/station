import { agentId } from '@kontourai/station-contracts/agent-identity';
import { describe, expect, test } from 'vitest';
import type { AgentData } from '../contexts/AgentsContext';
import {
  annotateUnavailableAgentLabel as annotateUnavailableAgentLabelTyped,
  type ProjectAgentFilterState,
  resolveLayoutLaunchAgent as resolveLayoutLaunchAgentTyped,
} from '../views/layoutViewUtils';

function agent(
  overrides: Omit<Partial<AgentData>, 'slug'> & { slug: string },
): AgentData {
  return {
    name: overrides.slug,
    ...overrides,
    slug: agentId(overrides.slug),
  } as AgentData;
}

function ready(agents?: readonly string[]): ProjectAgentFilterState {
  return { status: 'ready', agents: agents?.map(agentId) };
}

function resolveLayoutLaunchAgent(
  id: string | undefined,
  agents: readonly AgentData[],
  project: string,
  filter: ProjectAgentFilterState,
) {
  return resolveLayoutLaunchAgentTyped(
    id ? agentId(id) : undefined,
    agents,
    project,
    filter,
  );
}

function annotateUnavailableAgentLabel<
  T extends { label: string; agent?: string },
>(
  item: T,
  agents: readonly AgentData[],
  project: string,
  filter: ProjectAgentFilterState,
): T {
  return annotateUnavailableAgentLabelTyped(
    { ...item, agent: item.agent ? agentId(item.agent) : undefined },
    agents,
    project,
    filter,
  ) as T;
}

const unknown: ProjectAgentFilterState = { status: 'unknown' };

describe('layoutViewUtils (station#1004 review HIGH-2)', () => {
  describe('resolveLayoutLaunchAgent', () => {
    test('never launches an agent owned by another project', () => {
      const agents = [agent({ slug: 'owned-agent', project: 'project-a' })];
      expect(
        resolveLayoutLaunchAgent(
          'owned-agent',
          agents,
          'project-b',
          ready(undefined),
        ),
      ).toBeUndefined();
    });

    test('launches an agent owned by this project even when ProjectConfig.agents excludes it', () => {
      const agents = [agent({ slug: 'owned-agent', project: 'project-a' })];
      expect(
        resolveLayoutLaunchAgent('owned-agent', agents, 'project-a', ready([])),
      ).toEqual(agents[0]);
    });

    test('launches a global (unowned) agent from any project when no filter is set (status ready, agents undefined)', () => {
      const agents = [agent({ slug: 'global-agent' })];
      expect(
        resolveLayoutLaunchAgent(
          'global-agent',
          agents,
          'project-a',
          ready(undefined),
        ),
      ).toEqual(agents[0]);
    });

    test('a global agent excluded by ProjectConfig.agents must NOT resolve for launch (closure review HIGH-2 residual)', () => {
      const agents = [agent({ slug: 'global-agent' })];
      expect(
        resolveLayoutLaunchAgent(
          'global-agent',
          agents,
          'project-a',
          ready(['some-other-agent']),
        ),
      ).toBeUndefined();
    });

    test('a global agent passing ProjectConfig.agents resolves', () => {
      const agents = [agent({ slug: 'global-agent' })];
      expect(
        resolveLayoutLaunchAgent(
          'global-agent',
          agents,
          'project-a',
          ready(['global-agent']),
        ),
      ).toEqual(agents[0]);
    });

    test('returns undefined for an unknown agent slug', () => {
      const agents = [agent({ slug: 'global-agent' })];
      expect(
        resolveLayoutLaunchAgent(
          'nonexistent',
          agents,
          'project-a',
          ready(undefined),
        ),
      ).toBeUndefined();
    });

    test('returns undefined for an undefined slug', () => {
      const agents = [agent({ slug: 'global-agent' })];
      expect(
        resolveLayoutLaunchAgent(
          undefined,
          agents,
          'project-a',
          ready(undefined),
        ),
      ).toBeUndefined();
    });

    describe('status "unknown" — filter availability not yet settled (closure round 2, new HIGH)', () => {
      test('never resolves a global agent that WOULD be excluded once the filter loads', () => {
        const agents = [agent({ slug: 'global-agent' })];
        expect(
          resolveLayoutLaunchAgent(
            'global-agent',
            agents,
            'project-a',
            unknown,
          ),
        ).toBeUndefined();
      });

      test('never resolves a global agent that WOULD pass the filter once it loads either — fail closed, not "guess allow"', () => {
        const agents = [agent({ slug: 'global-agent' })];
        expect(
          resolveLayoutLaunchAgent(
            'global-agent',
            agents,
            'project-a',
            unknown,
          ),
        ).toBeUndefined();
      });

      test('never resolves even an agent owned by this project while unknown — refuses everything, no exceptions', () => {
        const agents = [agent({ slug: 'owned-agent', project: 'project-a' })];
        expect(
          resolveLayoutLaunchAgent('owned-agent', agents, 'project-a', unknown),
        ).toBeUndefined();
      });
    });
  });

  describe('annotateUnavailableAgentLabel', () => {
    test('marks a prompt naming another project agent as unavailable, never launches', () => {
      const agents = [agent({ slug: 'owned-agent', project: 'project-a' })];
      const prompt = { id: 'p1', label: 'Do the thing', agent: 'owned-agent' };

      const annotated = annotateUnavailableAgentLabel(
        prompt,
        agents,
        'project-b',
        ready(undefined),
      );

      expect(annotated.label).toContain('Do the thing');
      expect(annotated.label).toContain('unavailable');
      expect(
        resolveLayoutLaunchAgent(
          annotated.agent,
          agents,
          'project-b',
          ready(undefined),
        ),
      ).toBeUndefined();
    });

    test('marks a prompt naming a global agent excluded by ProjectConfig.agents as unavailable', () => {
      const agents = [agent({ slug: 'global-agent' })];
      const prompt = { id: 'p1', label: 'Do the thing', agent: 'global-agent' };

      const annotated = annotateUnavailableAgentLabel(
        prompt,
        agents,
        'project-a',
        ready(['some-other-agent']),
      );

      expect(annotated.label).toContain('unavailable');
    });

    test('leaves a prompt naming an agent available in this project untouched', () => {
      const agents = [agent({ slug: 'owned-agent', project: 'project-a' })];
      const prompt = { id: 'p1', label: 'Do the thing', agent: 'owned-agent' };

      expect(
        annotateUnavailableAgentLabel(
          prompt,
          agents,
          'project-a',
          ready(undefined),
        ).label,
      ).toBe('Do the thing');
    });

    test('leaves a prompt with no agent ref untouched', () => {
      const agents: AgentData[] = [];
      const prompt = { id: 'p1', label: 'Do the thing' };
      expect(
        annotateUnavailableAgentLabel(
          prompt,
          agents,
          'project-a',
          ready(undefined),
        ).label,
      ).toBe('Do the thing');
    });

    test('marks a prompt as availability-pending (not "unavailable") while the filter status is unknown', () => {
      const agents = [agent({ slug: 'global-agent' })];
      const prompt = { id: 'p1', label: 'Do the thing', agent: 'global-agent' };

      const annotated = annotateUnavailableAgentLabel(
        prompt,
        agents,
        'project-a',
        unknown,
      );

      expect(annotated.label).toContain('Do the thing');
      expect(annotated.label).toContain('pending');
    });
  });
});
