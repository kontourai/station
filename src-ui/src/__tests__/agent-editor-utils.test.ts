import { resolveEngineCapabilityMatrix } from '@kontourai/station-contracts/engine-capability-matrix';
import { describe, expect, test } from 'vitest';
import type { Tool } from '../types';
import {
  buildAgentPayload,
  formFromAgent,
  validateAgentForm,
} from '../views/agent-editor/agentsViewUtils';
import type { AgentFormData } from '../views/agent-editor/types';
import {
  removeIntegration,
  slugify,
  toggleIntegrationAutoApprove,
  toggleIntegrationToolAutoApprove,
  toggleIntegrationToolEnabled,
} from '../views/agent-editor/utils';

const toolList: Tool[] = [
  {
    id: 'shell',
    name: 'Shell',
    toolName: 'run',
    description: 'Run shell commands',
  },
  {
    id: 'search',
    name: 'Search',
    toolName: 'find',
    description: 'Find files',
  },
] as Tool[];

function buildForm(): AgentFormData {
  return {
    slug: 'planner',
    name: 'Planner',
    description: '',
    prompt: '',
    modelId: '',
    region: '',
    guardrails: null,
    maxSteps: '',
    tools: {
      mcpServers: ['github'],
      available: [],
      autoApprove: [],
    },
    execution: {
      agentConnectionId: 'bedrock-runtime',
      modelConnectionId: '',
      runtimeOptions: {},
    },
    icon: '',
    skills: [],
    project: '',
  };
}

describe('agent-editor utils', () => {
  test('slugify normalizes names', () => {
    expect(slugify('My Planner Agent')).toBe('my-planner-agent');
    expect(slugify('  Review++ Agent  ')).toBe('review-agent');
  });

  test("validateAgentForm requires a prompt exactly when the resolved matrix's systemPrompt.state is native (station#1003 Phase B: AgentType retired)", () => {
    const agentConnections = [
      {
        id: 'managed-runtime',
        kind: 'agent',
        type: 'managed-runtime',
        name: 'Managed Runtime',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { engineId: 'station' },
      },
      {
        id: 'codex',
        kind: 'agent',
        type: 'codex',
        name: 'Codex Runtime',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { engineId: 'codex' },
      },
    ] as any;

    const managedConnection = agentConnections.find(
      (c: any) => c.id === 'managed-runtime',
    );
    const codexConnection = agentConnections.find((c: any) => c.id === 'codex');

    const stationMatrix = resolveEngineCapabilityMatrix(
      'managed-runtime',
      managedConnection,
    );
    const codexMatrix = resolveEngineCapabilityMatrix('codex', codexConnection);
    const acpMatrix = resolveEngineCapabilityMatrix('acp');

    expect(stationMatrix.systemPrompt.state).toBe('native');
    expect(codexMatrix.systemPrompt.state).not.toBe('native');
    expect(acpMatrix.systemPrompt.state).not.toBe('native');

    const managedForm: AgentFormData = {
      ...buildForm(),
      prompt: '',
      execution: {
        agentConnectionId: 'managed-runtime',
        modelConnectionId: '',
        runtimeOptions: {},
      },
    };
    expect(
      validateAgentForm(managedForm, false, {
        requiresPrompt: stationMatrix.systemPrompt.state === 'native',
      }),
    ).toMatchObject({ prompt: 'System prompt is required' });

    const codexForm: AgentFormData = {
      ...buildForm(),
      prompt: '',
      execution: {
        agentConnectionId: 'codex',
        modelConnectionId: '',
        runtimeOptions: {},
      },
    };
    expect(
      validateAgentForm(codexForm, false, {
        requiresPrompt: codexMatrix.systemPrompt.state === 'native',
      }).prompt,
    ).toBeUndefined();
  });

  test('removeIntegration clears matching tool state', () => {
    const form = {
      ...buildForm(),
      tools: {
        mcpServers: ['github'],
        available: ['github_run', 'github_find'],
        autoApprove: ['github_*', 'github_run'],
      },
    };

    expect(removeIntegration(form, 'github').tools).toEqual({
      mcpServers: [],
      available: [],
      autoApprove: [],
    });
  });

  test('tool toggles expand implicit all-tools state into explicit lists', () => {
    const base = buildForm();
    const disabled = toggleIntegrationToolEnabled(
      base,
      'github',
      'github_run',
      toolList,
    );
    expect(disabled.tools.available.sort()).toEqual(['github_find']);

    const reenabled = toggleIntegrationToolEnabled(
      disabled,
      'github',
      'github_run',
      toolList,
    );
    expect(reenabled.tools.available.sort()).toEqual([
      'github_find',
      'github_run',
    ]);
  });

  test('auto-approve toggles between wildcard and explicit tool approvals', () => {
    const base = buildForm();
    const wildcard = toggleIntegrationAutoApprove(base, 'github');
    expect(wildcard.tools.autoApprove).toEqual(['github_*']);

    const explicit = toggleIntegrationToolAutoApprove(
      wildcard,
      'github',
      'github_run',
      toolList,
    );
    expect(explicit.tools.autoApprove.sort()).toEqual(['github_find']);
  });
});

// archive#3530: the editor's save payload builds `execution` as an explicit
// whitelist, so a persisted field the form type does not carry is silently
// DELETED by any unrelated edit. Nothing in this editor sets a credential
// profile — a user pins one from the CLI — so a rename must not unpin the
// agent's account and drop it back to the connection's, with no signal.
describe('credential profile round-trip through the agent editor', () => {
  const pinnedAgent = {
    slug: 'work-agent',
    name: 'Work Agent',
    prompt: '',
    execution: {
      agentConnectionId: 'claude',
      credentialProfileRef: 'work-account',
    },
  };

  test('survives hydrate → unrelated edit → save', () => {
    const form = formFromAgent(pinnedAgent);
    expect(form.execution.credentialProfileRef).toBe('work-account');

    // The kind of edit that has nothing to do with credentials.
    const renamed = { ...form, name: 'Renamed Work Agent' };
    const payload = buildAgentPayload(renamed);

    expect(payload.execution?.credentialProfileRef).toBe('work-account');
  });

  test('an agent with no pin still sends no ref', () => {
    const form = formFromAgent({
      slug: 'unpinned',
      name: 'Unpinned',
      prompt: '',
      execution: { agentConnectionId: 'claude' },
    });
    expect(form.execution.credentialProfileRef).toBeUndefined();
    expect(
      buildAgentPayload(form).execution?.credentialProfileRef,
    ).toBeUndefined();
  });
});
