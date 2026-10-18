import { describe, expect, test } from 'vitest';
import type { Tool } from '../types';
import {
  buildAgentPayload,
  formFromAgent,
} from '../views/agent-editor/agentsViewUtils';
import type { AgentFormData } from '../views/agent-editor/types';
import {
  applyNewToolApprovalDefaults,
  removeIntegration,
  selectIntegrationTools,
  setIntegrationToolApproval,
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
      unattendedAutoApprove: [],
      browser: true,
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
  test('editing one source keeps other grants and does not rebind source-qualified names', () => {
    const form = buildForm();
    form.tools.mcpServers = ['github', 'filesystem'];
    form.tools.autoApprove = ['github_get_issue'];
    const tools: Tool[] = [
      { id: 'read', name: 'get_issue', toolName: 'get_issue' },
      { id: 'write', name: 'write_file', toolName: 'write_file' },
    ];
    const next = setIntegrationToolApproval(
      form,
      'filesystem',
      'filesystem_write_file',
      'ask',
      tools,
    );
    expect(next.tools.autoApprove).toEqual(['github_get_issue']);
    expect(next.tools.askBeforeUse).toEqual(['mcp/filesystem/write_file']);
  });
  test('including future tools saves an ask default with a reviewed read exception', () => {
    const previous = buildForm();
    previous.tools.mcpServers = [];
    const tools: Tool[] = [
      {
        id: 'read',
        name: 'read',
        readOnly: true,
        classificationSource: 'station',
      },
    ];
    const selected = selectIntegrationTools(previous, 'reports', 'all', {
      reports: tools,
    });
    const next = applyNewToolApprovalDefaults(
      selected,
      previous,
      'reports',
      tools,
      'station',
    );
    const saved = buildAgentPayload(next);
    expect(saved.tools?.askBeforeUse).toEqual(['mcp/reports/*']);
    expect(saved.tools?.autoApprove).toEqual(['mcp/reports/read']);
  });

  test('narrowing future selections preserves the exact Always exception', () => {
    const form = buildForm();
    form.tools.askBeforeUse = ['mcp/github/*'];
    form.tools.autoApprove = ['mcp/github/find'];
    const next = selectIntegrationTools(form, 'github', ['github_find'], {
      github: toolList,
    });
    expect(next.tools.askBeforeUse).toEqual(['mcp/github/*']);
    expect(next.tools.autoApprove).toEqual(['mcp/github/find']);
  });

  test('narrowing a catalog retains explicit approval for a selected action missing from discovery', () => {
    const form = buildForm();
    form.tools.askBeforeUse = ['mcp/github/missing'];
    form.tools.autoApprove = ['*'];
    const next = selectIntegrationTools(
      form,
      'github',
      ['github_missing', 'github_find'],
      { github: toolList },
    );
    expect(next.tools.askBeforeUse).toEqual(['mcp/github/missing']);
  });

  test('narrowing an ask-all source preserves prompts for retained actions', () => {
    const form = buildForm();
    form.tools.askBeforeUse = ['github_*'];
    const next = selectIntegrationTools(form, 'github', ['github_run'], {
      github: toolList,
    });
    expect(next.tools.askBeforeUse).toEqual(['github_*']);
  });

  test('slugify normalizes names', () => {
    expect(slugify('My Planner Agent')).toBe('my-planner-agent');
    expect(slugify('  Review++ Agent  ')).toBe('review-agent');
  });

  test('removeIntegration clears matching tool state', () => {
    const form = {
      ...buildForm(),
      tools: {
        mcpServers: ['github'],
        available: ['github_run', 'github_find'],
        autoApprove: ['github_*', 'github_run'],
        unattendedAutoApprove: [],
        browser: true,
      },
    };

    expect(removeIntegration(form, 'github').tools).toEqual({
      mcpServers: [],
      available: [],
      autoApprove: [],
      unattendedAutoApprove: [],
      // Removing an integration leaves the built-in browser tools alone.
      browser: true,
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
