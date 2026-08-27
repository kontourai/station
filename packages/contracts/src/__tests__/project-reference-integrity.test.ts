import { describe, expect, test } from 'vitest';
import { agentId } from '../agent-identity.js';
import {
  agentAvailableInProject,
  agentOwnershipFinding,
  availableAgentSlugsForProject,
  normalizeProjectAgentScope,
  projectAllowsAgent,
  validateLayoutAgentReferences,
  validateProjectAgentScope,
} from '../project-reference-integrity';

describe('project reference integrity', () => {
  test('distinguishes unscoped projects from explicit empty agent scopes', () => {
    expect(normalizeProjectAgentScope(undefined)).toBeUndefined();
    expect(
      normalizeProjectAgentScope([agentId('alpha'), agentId('alpha')]),
    ).toEqual(['alpha']);
    expect(projectAllowsAgent(undefined, agentId('alpha'))).toBe(true);
    expect(projectAllowsAgent([], agentId('alpha'))).toBe(false);
    expect(
      availableAgentSlugsForProject(undefined, undefined, [
        { slug: agentId('alpha') },
        { slug: agentId('beta') },
      ]),
    ).toEqual(['alpha', 'beta']);
    expect(
      availableAgentSlugsForProject(
        undefined,
        [],
        [{ slug: agentId('alpha') }, { slug: agentId('beta') }],
      ),
    ).toEqual([]);
  });

  test('reports stale project and layout agent references', () => {
    const diagnostics = validateProjectAgentScope(
      { slug: 'demo', agents: [agentId('alpha'), agentId('missing')] },
      { knownAgents: [{ slug: agentId('alpha') }] },
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'unknown_project_agent',
        refType: 'agent',
        refId: 'missing',
      }),
    ]);

    expect(
      validateLayoutAgentReferences(
        { slug: 'demo', agents: [agentId('alpha')] },
        {
          config: {
            availableAgents: ['alpha', 'beta'],
            defaultAgent: 'beta',
          },
        },
        {
          knownAgents: [{ slug: agentId('alpha') }, { slug: agentId('beta') }],
        },
      ).map((diagnostic) => diagnostic.code),
    ).toEqual([
      'layout_agent_outside_project_scope',
      'layout_default_agent_not_available',
    ]);
  });

  describe('§3.3 project-owned agents (station#1004, unification slice 7)', () => {
    test('agentAvailableInProject returns true for an agent owned by the current project even when the ProjectConfig.agents filter excludes it', () => {
      expect(
        agentAvailableInProject('proj-a', [], {
          slug: agentId('owned-agent'),
          project: 'proj-a',
        }),
      ).toBe(true);
    });

    test('agentAvailableInProject returns false for an owned agent in any other project and in the global context', () => {
      expect(
        agentAvailableInProject('proj-b', undefined, {
          slug: agentId('owned-agent'),
          project: 'proj-a',
        }),
      ).toBe(false);
      expect(
        agentAvailableInProject(undefined, undefined, {
          slug: agentId('owned-agent'),
          project: 'proj-a',
        }),
      ).toBe(false);
    });

    test('agentAvailableInProject applies the opt-in filter only to global agents', () => {
      expect(
        agentAvailableInProject('proj-a', [agentId('other')], {
          slug: agentId('global-agent'),
        }),
      ).toBe(false);
      expect(
        agentAvailableInProject('proj-a', [agentId('global-agent')], {
          slug: agentId('global-agent'),
        }),
      ).toBe(true);
      expect(
        agentAvailableInProject('proj-a', undefined, {
          slug: agentId('global-agent'),
        }),
      ).toBe(true);
    });

    test('validateProjectAgentScope flags a filter entry naming an agent owned by another project', () => {
      const diagnostics = validateProjectAgentScope(
        { slug: 'proj-b', agents: [agentId('owned-agent')] },
        {
          knownAgents: [{ slug: agentId('owned-agent'), project: 'proj-a' }],
        },
      );
      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: 'agent_owned_by_other_project',
          refType: 'agent',
          refId: 'owned-agent',
          message:
            "Agent 'owned-agent' is owned by project 'proj-a' and cannot be selected here.",
        }),
      ]);
    });

    test('validateProjectAgentScope accepts a filter entry naming an agent owned by this project (redundant, not wrong)', () => {
      const diagnostics = validateProjectAgentScope(
        { slug: 'proj-a', agents: [agentId('owned-agent')] },
        {
          knownAgents: [{ slug: agentId('owned-agent'), project: 'proj-a' }],
        },
      );
      expect(diagnostics).toEqual([]);
    });

    test('validateLayoutAgentReferences treats agents owned by this project as in scope without a filter entry', () => {
      const diagnostics = validateLayoutAgentReferences(
        { slug: 'proj-a', agents: [] },
        { config: { availableAgents: ['owned-agent'] } },
        {
          knownAgents: [{ slug: agentId('owned-agent'), project: 'proj-a' }],
        },
      );
      expect(diagnostics).toEqual([]);
    });

    test('validateLayoutAgentReferences flags an agent owned by a different project as outside scope', () => {
      const diagnostics = validateLayoutAgentReferences(
        { slug: 'proj-b', agents: [] },
        { config: { availableAgents: ['owned-agent'] } },
        {
          knownAgents: [{ slug: agentId('owned-agent'), project: 'proj-a' }],
        },
      );
      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: 'layout_agent_outside_project_scope',
          refId: 'owned-agent',
        }),
      ]);
    });

    test('layout prompt references to an agent owned by another project are flagged (station#1004 review HIGH-2)', () => {
      const diagnostics = validateLayoutAgentReferences(
        { slug: 'proj-b', agents: [] },
        {
          config: {
            globalSkills: [
              {
                id: 'p1',
                label: 'Prompt One',
                prompt: 'x',
                agent: 'owned-agent',
              },
            ],
            actions: [
              {
                type: 'prompt',
                label: 'Action One',
                data: 'x',
                agent: 'owned-agent',
              },
            ],
            tabs: [
              {
                id: 'tab-1',
                label: 'Tab',
                component: 'default',
                actions: [
                  {
                    type: 'prompt',
                    label: 'Tab Action',
                    data: 'x',
                    agent: 'owned-agent',
                  },
                ],
                skills: [
                  {
                    type: 'prompt',
                    label: 'Tab Skill',
                    data: 'x',
                    agent: 'unknown-agent',
                  },
                ],
              },
            ],
          },
        },
        {
          knownAgents: [{ slug: agentId('owned-agent'), project: 'proj-a' }],
        },
      );

      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: 'layout_agent_outside_project_scope',
          refId: 'owned-agent',
          path: 'config.actions[0]',
        }),
        expect.objectContaining({
          code: 'layout_agent_outside_project_scope',
          refId: 'owned-agent',
          path: 'config.globalSkills[0]',
        }),
        expect.objectContaining({
          code: 'layout_agent_outside_project_scope',
          refId: 'owned-agent',
          path: 'config.tabs[0].actions[0]',
        }),
        expect.objectContaining({
          code: 'unknown_layout_agent',
          refId: 'unknown-agent',
          path: 'config.tabs[0].skills[0]',
        }),
      ]);
    });

    test('layout prompt references to an agent owned by THIS project are not flagged', () => {
      const diagnostics = validateLayoutAgentReferences(
        { slug: 'proj-a', agents: [] },
        {
          config: {
            globalSkills: [
              {
                id: 'p1',
                label: 'Prompt One',
                prompt: 'x',
                agent: 'owned-agent',
              },
            ],
          },
        },
        {
          knownAgents: [{ slug: agentId('owned-agent'), project: 'proj-a' }],
        },
      );
      expect(diagnostics).toEqual([]);
    });

    test('agentOwnershipFinding names the missing project verbatim and returns undefined for global or known owners', () => {
      expect(
        agentOwnershipFinding('ghost-project', new Set(['proj-a'])),
      ).toEqual({
        code: 'unknown_owner_project',
        project: 'ghost-project',
        message:
          "This agent's owning project 'ghost-project' no longer exists.",
      });
      expect(
        agentOwnershipFinding(undefined, new Set(['proj-a'])),
      ).toBeUndefined();
      expect(
        agentOwnershipFinding('proj-a', new Set(['proj-a'])),
      ).toBeUndefined();
    });
  });
});
