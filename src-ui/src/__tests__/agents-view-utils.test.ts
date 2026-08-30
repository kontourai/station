import type { AgentTools } from '@kontourai/station-contracts/agent';
import {
  type AgentResponseError,
  updateAgentRaw,
} from '@kontourai/station-sdk/client';
import { describe, expect, test, vi } from 'vitest';
import {
  AGENT_SPEC_COPY_CLASSIFICATION,
  agentSaveErrorMessage,
  buildAgentPayload,
  cloneableAgentFields,
  createEmptyAgentForm,
  createNewAgentForm,
  formFromAgent,
  groupAgentToolsByServer,
  isAgentFormDirty,
  resolveStationModelBinding,
  validateAgentForm,
} from '../views/agent-editor/agentsViewUtils';

describe('agents view utils', () => {
  test('copy allowlist classifies every AgentSpec field', () => {
    expect(AGENT_SPEC_COPY_CLASSIFICATION).toEqual({
      name: 'clone',
      prompt: 'clone',
      description: 'clone',
      icon: 'clone',
      model: 'clone',
      execution: 'clone',
      region: 'clone',
      maxSteps: 'clone',
      guardrails: 'clone',
      tools: 'clone',
      skills: 'clone',
      project: 'exclude',
      delegation: 'exclude',
      streaming: 'exclude',
      commands: 'exclude',
      ui: 'exclude',
      provenance: 'exclude',
    });
  });

  test('cloneableAgentFields excludes credentials, tool env, and ownership', () => {
    expect(
      cloneableAgentFields({
        slug: 'source',
        name: 'Source',
        description: 'Safe description',
        prompt: 'Safe prompt',
        icon: '🧠',
        skills: ['safe-skill'],
        project: 'private-project',
        toolsConfig: {
          mcpServers: ['safe-server'],
          available: ['safe-server_read'],
          autoApprove: ['safe-server_read'],
          env: { PATH: '/tmp/must-not-copy' },
        } as AgentTools,
        execution: {
          agentConnectionId: 'codex',
          modelConnectionId: 'model-a',
          runtimeOptions: { effort: 'high' },
          modelOptions: { thinking: 'medium' },
          credentialProfileRef: 'account-a',
        },
      }),
    ).toEqual({
      name: 'Source',
      description: 'Safe description',
      prompt: 'Safe prompt',
      modelId: '',
      region: '',
      guardrails: null,
      maxSteps: '',
      tools: {
        mcpServers: ['safe-server'],
        available: ['safe-server_read'],
        autoApprove: ['safe-server_read'],
      },
      execution: {
        agentConnectionId: 'codex',
        modelConnectionId: 'model-a',
        runtimeOptions: { effort: 'high' },
        modelOptions: { thinking: 'medium' },
      },
      icon: '🧠',
      skills: ['safe-skill'],
    });
  });

  test('createEmptyAgentForm returns a fresh editable form', () => {
    const first = createEmptyAgentForm();
    const second = createEmptyAgentForm();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.tools).not.toBe(second.tools);
    expect(first.execution).not.toBe(second.execution);
  });

  test('formFromAgent normalizes persisted agent data into form data', () => {
    expect(
      formFromAgent({
        slug: 'agent-1',
        name: 'Agent One',
        description: 'Desc',
        prompt: 'Prompt',
        model: { modelId: 'bedrock-model' },
        region: 'us-east-1',
        guardrails: { temperature: 0.2 },
        maxSteps: 7,
        toolsConfig: {
          mcpServers: ['server-1'],
          available: ['server-1_tool-a'],
          autoApprove: ['server-1_tool-a'],
        },
        delegation: { blockedTools: ['filesystem_delete_*'] },
        execution: {
          agentConnectionId: 'runtime-1',
          modelConnectionId: 'model-1',
          runtimeOptions: { timeout: 30 },
        },
        icon: '🧠',
        skills: ['skill-a'],
      }),
    ).toEqual({
      slug: 'agent-1',
      name: 'Agent One',
      description: 'Desc',
      prompt: 'Prompt',
      modelId: 'bedrock-model',
      region: 'us-east-1',
      guardrails: { temperature: 0.2 },
      maxSteps: '7',
      tools: {
        mcpServers: ['server-1'],
        available: ['server-1_tool-a'],
        autoApprove: ['server-1_tool-a'],
      },
      // The spec's tools object verbatim, so a save can tell an ABSENT key
      // from an authored-empty one and can carry through fields the form does
      // not model (archive#2693).
      toolsOriginal: {
        mcpServers: ['server-1'],
        available: ['server-1_tool-a'],
        autoApprove: ['server-1_tool-a'],
      },
      delegation: { blockedTools: ['filesystem_delete_*'] },
      execution: {
        agentConnectionId: 'runtime-1',
        modelConnectionId: 'model-1',
        runtimeOptions: { timeout: 30 },
        modelOptions: {},
      },
      icon: '🧠',
      skills: ['skill-a'],
      project: '',
    });
  });

  test('createNewAgentForm merges template form data onto a fresh base form', () => {
    const next = createNewAgentForm(
      {
        name: 'Template Agent',
        tools: {
          mcpServers: ['server-2'],
          available: [],
          autoApprove: [],
        },
      },
      'managed-runtime',
    );

    expect(next.name).toBe('Template Agent');
    expect(next.tools.mcpServers).toEqual(['server-2']);
    expect(next.execution.agentConnectionId).toBe('managed-runtime');
  });

  test('validateAgentForm enforces required fields and slug rules for new agents', () => {
    expect(validateAgentForm(createEmptyAgentForm(), true)).toEqual({
      name: 'Name is required',
      prompt: 'System prompt is required',
      slug: 'Slug is required',
    });

    expect(
      validateAgentForm(
        {
          ...createEmptyAgentForm(),
          name: 'Agent',
          prompt: 'Prompt',
          slug: 'Bad Slug',
        },
        true,
      ),
    ).toEqual({
      slug: 'Lowercase letters, numbers, hyphens only',
    });

    expect(
      validateAgentForm(
        {
          ...createEmptyAgentForm(),
          name: 'Agent',
          prompt: 'Prompt',
        },
        false,
      ),
    ).toEqual({});
  });

  test('validateAgentForm allows empty prompts for connected runtimes only', () => {
    expect(
      validateAgentForm(
        {
          ...createEmptyAgentForm(),
          name: 'Connected Agent',
          prompt: '',
          execution: {
            agentConnectionId: 'codex-runtime',
            modelConnectionId: '',
            runtimeOptions: {},
          },
        },
        true,
        { requiresPrompt: false },
      ),
    ).toEqual({
      slug: 'Slug is required',
    });

    expect(
      validateAgentForm(
        {
          ...createEmptyAgentForm(),
          name: 'Managed Agent',
          prompt: '',
          execution: {
            agentConnectionId: 'bedrock-runtime',
            modelConnectionId: '',
            runtimeOptions: {},
          },
        },
        false,
        { requiresPrompt: true },
      ),
    ).toEqual({
      prompt: 'System prompt is required',
    });
  });

  test('buildAgentPayload strips empty fields and preserves runtime settings', () => {
    expect(
      buildAgentPayload({
        ...createEmptyAgentForm(),
        slug: 'agent-1',
        name: 'Agent One',
        description: '',
        prompt: 'Prompt',
        modelId: 'model-1',
        region: 'us-east-1',
        guardrails: null,
        maxSteps: '12',
        tools: {
          mcpServers: ['server-1'],
          available: [],
          autoApprove: [],
        },
        // The spec's tools object verbatim, so a save can tell an ABSENT key
        // from an authored-empty one and can carry through fields the form
        // does not model (archive#2693).
        toolsOriginal: { mcpServers: ['server-1'] },
        execution: {
          agentConnectionId: 'runtime-1',
          modelConnectionId: '',
          runtimeOptions: { timeout: 30 },
        },
        icon: '',
        skills: [],
      }),
    ).toEqual({
      slug: 'agent-1',
      name: 'Agent One',
      description: undefined,
      prompt: 'Prompt',
      model: 'model-1',
      region: 'us-east-1',
      guardrails: undefined,
      maxSteps: 12,
      // Only the key the spec authored. This previously asserted
      // `available: []`, which PINNED a defect: the runtime reads
      // `available || ['*']` and [] is truthy, so persisting an empty
      // allow-list where the key was absent turns "all tools" into "no tools"
      // (archive#2693).
      tools: {
        mcpServers: ['server-1'],
      },
      execution: {
        agentConnectionId: 'runtime-1',
        modelConnectionId: undefined,
        modelId: 'model-1',
        runtimeOptions: { timeout: 30 },
      },
      icon: undefined,
      skills: undefined,
      project: null,
    });
  });

  test('buildAgentPayload preserves an empty prompt for connected runtimes', () => {
    expect(
      buildAgentPayload({
        ...createEmptyAgentForm(),
        slug: 'connected-agent',
        name: 'Connected Agent',
        prompt: '',
        execution: {
          agentConnectionId: 'codex-runtime',
          modelConnectionId: '',
          runtimeOptions: {},
        },
      }),
    ).toMatchObject({
      slug: 'connected-agent',
      name: 'Connected Agent',
      prompt: '',
      execution: {
        agentConnectionId: 'codex-runtime',
        modelId: undefined,
      },
      project: null,
    });
  });

  test('formFromAgent/buildAgentPayload round-trip the project field; empty select clears ownership (station#1004 §9)', () => {
    const owned = formFromAgent({
      slug: 'owned-agent',
      name: 'Owned Agent',
      project: 'demo-project',
    });
    expect(owned.project).toBe('demo-project');
    expect(buildAgentPayload(owned)).toMatchObject({
      project: 'demo-project',
    });

    const global = formFromAgent({
      slug: 'global-agent',
      name: 'Global Agent',
    });
    expect(global.project).toBe('');
    // Update: an empty select is the explicit ownership-clearing signal.
    // `execution: null` is the same shape for the engine binding since
    // archive#3662 — this Agent carries no execution state at all, and an
    // omitted block would mean "leave whatever is persisted alone".
    expect(buildAgentPayload(global)).toMatchObject({
      project: null,
      execution: null,
    });
    // Create: an empty select is simply omitted (JSON drops `undefined`).
    expect(buildAgentPayload(global, { isCreating: true })).not.toHaveProperty(
      'project',
    );
  });

  test('groupAgentToolsByServer groups tool definitions by server name', () => {
    expect(
      groupAgentToolsByServer([
        { id: '1', name: 'One', server: 'alpha' },
        { id: '2', name: 'Two', server: 'beta' },
        { id: '3', name: 'Three', server: 'alpha' },
        { id: '4', name: 'No server' },
      ]),
    ).toEqual({
      alpha: [
        { id: '1', name: 'One', server: 'alpha' },
        { id: '3', name: 'Three', server: 'alpha' },
      ],
      beta: [{ id: '2', name: 'Two', server: 'beta' }],
    });
  });

  test('isAgentFormDirty compares the full form payload', () => {
    const base = createEmptyAgentForm();

    expect(isAgentFormDirty(base, base)).toBe(false);
    expect(
      isAgentFormDirty(
        {
          ...base,
          name: 'Changed',
        },
        base,
      ),
    ).toBe(true);
  });

  test('leaves an absent allow-list absent instead of writing an empty one', () => {
    // The runtime reads `spec.tools.available || ['*']` and [] is TRUTHY, so
    // persisting an empty array where the key was absent turns "every tool is
    // allowed" into "no tool is allowed" — silently, with the Tools tab still
    // rendering every tool as checked.
    const form = formFromAgent({
      slug: 'planner',
      toolsConfig: { mcpServers: ['github'] },
    });
    expect(form.tools.available).toEqual([]);
    expect(buildAgentPayload(form).tools).not.toHaveProperty('available');
  });

  test('leaves an absent mcpServers absent (authored-empty disables every server)', () => {
    // An authored `mcpServers: []` is an explicit "disable every tool server"
    // and ships strictMcpConfig:true to external engines, suppressing their own
    // MCP discovery. An unrelated edit must not manufacture that.
    const form = formFromAgent({
      slug: 'planner',
      toolsConfig: { autoApprove: ['Read'] },
    });
    const tools = buildAgentPayload(form).tools;
    expect(tools).toMatchObject({ autoApprove: ['Read'] });
    expect(tools).not.toHaveProperty('mcpServers');
  });

  test('preserves an authored-empty key rather than dropping it', () => {
    const form = formFromAgent({
      slug: 'planner',
      toolsConfig: { mcpServers: [], autoApprove: ['Read'] },
    });
    expect(buildAgentPayload(form).tools).toMatchObject({ mcpServers: [] });
  });

  test('carries through tools fields the form does not model', () => {
    // `tools.env` is in the persisted schema but not in the contract type or
    // this form; replacing the whole tools object destroyed it on every save.
    const form = formFromAgent({
      slug: 'planner',
      toolsConfig: {
        mcpServers: ['github'],
        env: { TOKEN: 'x' },
      } as never,
    });
    expect(buildAgentPayload(form).tools).toMatchObject({
      env: { TOKEN: 'x' },
    });
  });

  test('persists clearing the last integration, because the key was authored', () => {
    // emptying the form previously produced `tools: undefined`,
    // which means "no change" server-side — the integration came back on the
    // next load while the editor reported the save as successful. An emptied
    // key that the spec HAD authored is now sent as empty, so the clear sticks.
    const form = formFromAgent({
      slug: 'planner',
      toolsConfig: { mcpServers: ['github'], available: ['github_run'] },
    });
    const cleared = {
      ...form,
      tools: { ...form.tools, mcpServers: [], available: [] },
    };
    expect(buildAgentPayload(cleared).tools).toMatchObject({
      mcpServers: [],
      available: [],
    });
  });

  test('sends tool configuration that carries no MCP servers', () => {
    // Regression: the payload gated `tools` on mcpServers.length > 0, so an
    // agent with only available/autoApprove/aliases had those fields dropped
    // while the editor reported the save as successful.
    const form = formFromAgent({
      slug: 'planner',
      toolsConfig: { mcpServers: [], autoApprove: ['builtin_read'] },
    });
    expect(buildAgentPayload(form).tools).toMatchObject({
      autoApprove: ['builtin_read'],
    });
  });
});

describe('the Station Agent round-trips as UNBOUND (#3662 review HIGH-2)', () => {
  const STATION = {
    slug: 'station',
    name: 'Station',
    prompt: '',
  };

  test('an absent binding stays absent in the form — no id is invented', () => {
    // The defect: `formFromAgent(agent, defaultManagedRuntimeId)` replaced an
    // absent binding with the managed-runtime connection id, so simply
    // OPENING the healed Station Agent put a connection id into the form.
    expect(formFromAgent(STATION).execution.agentConnectionId).toBe('');
  });

  test('saving an unrelated field on it persists NO agentConnectionId', () => {
    const form = formFromAgent(STATION);
    const edited = { ...form, description: 'Edited elsewhere in the form' };
    const payload = buildAgentPayload(edited) as {
      execution: Record<string, unknown> | null;
    };
    expect(payload.execution).toBeNull();
    // Whatever shape it takes, it must never NAME a connection.
    expect(JSON.stringify(payload)).not.toContain('agentConnectionId');
  });

  test('saving an unrelated field drops the runtime-projected Station binding', () => {
    const projected = formFromAgent({
      ...STATION,
      execution: { agentConnectionId: 'codex' },
    });
    const payload = buildAgentPayload({
      ...projected,
      description: 'Edited elsewhere in the form',
    });

    expect(JSON.stringify(payload)).not.toContain('agentConnectionId');
  });

  test('a Station-engine model pin survives, still with no binding', () => {
    // The old payload gated the whole `execution` block on the binding, so an
    // unbound Agent could not persist a model pin at all.
    const form = formFromAgent({
      ...STATION,
      execution: { modelId: 'claude-sonnet-4' },
    } as never);
    expect(form.execution.agentConnectionId).toBe('');
    const payload = buildAgentPayload(form) as {
      execution: Record<string, unknown>;
    };
    expect(payload.execution.modelId).toBe('claude-sonnet-4');
    expect(payload.execution.agentConnectionId).toBeUndefined();
  });

  test('an external Agent keeps its binding through the same round-trip', () => {
    const form = formFromAgent({
      slug: 'coder',
      name: 'Coder',
      execution: { agentConnectionId: 'codex' },
    } as never);
    expect(form.execution.agentConnectionId).toBe('codex');
    const payload = buildAgentPayload(form) as {
      execution: Record<string, unknown>;
    };
    expect(payload.execution.agentConnectionId).toBe('codex');
  });

  test('maps the real SDK Station-setting refusal to one short action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: 'server implementation detail must not render',
            code: 'STATION_ENGINE_IS_APP_SETTING',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const error = await updateAgentRaw('http://station.test', 'station', {
      name: 'Station',
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as AgentResponseError).code).toBe(
      'STATION_ENGINE_IS_APP_SETTING',
    );
    expect(agentSaveErrorMessage(error)).toBe(
      'Change the built-in Agent engine in Settings, then save your changes again.',
    );
  });

  test('switching an external Agent to Station CLEARS the binding', () => {
    // `undefined` here would be "leave whatever is persisted alone", which is
    // how a visible engine change silently keeps the old connection.
    const external = formFromAgent({
      slug: 'coder',
      name: 'Coder',
      execution: { agentConnectionId: 'codex' },
    } as never);
    const movedToStation = {
      ...external,
      execution: { ...external.execution, agentConnectionId: '' },
    };
    expect(buildAgentPayload(movedToStation)).toMatchObject({
      execution: null,
    });
  });
});

/**
 * archive#3743 (and the misattributed half of archive#3740): the Create gate
 * and the §3.3 model picker have to be one answer. Every case below is a case
 * where they used to give two.
 */
describe('station model binding', () => {
  const readyLlm = {
    id: 'stub-compat',
    kind: 'model',
    type: 'openai-compat',
    name: 'Stub compat',
    enabled: true,
    status: 'ready',
    capabilities: ['llm'],
    config: {},
  } as never;
  const vectorDb = {
    id: 'lancedb-builtin',
    kind: 'model',
    type: 'lancedb',
    name: 'Station Built-In',
    enabled: true,
    status: 'ready',
    capabilities: ['vectordb'],
    config: {},
  } as never;

  // The defect: "Chat with a model" pressed before the connections query
  // resolved captured an empty id, and nothing backfilled it. The picker went
  // on listing the connection as Ready while Create stayed disabled and
  // nothing said why.
  test('an unset choice resolves the way a launched chat resolves it', () => {
    const binding = resolveStationModelBinding({
      modelConnectionId: '',
      modelConnections: [vectorDb, readyLlm],
      appConfig: { defaultLLMProvider: '' },
    });
    expect(binding).toMatchObject({ kind: 'resolved', explicit: false });
    expect(binding.kind === 'resolved' ? binding.connection.id : null).toBe(
      'stub-compat',
    );
  });

  test('the app default wins over the merely-first connection', () => {
    const second = { ...(readyLlm as never as object), id: 'second' } as never;
    const binding = resolveStationModelBinding({
      modelConnectionId: '',
      modelConnections: [readyLlm, second],
      appConfig: { defaultLLMProvider: 'second' },
    });
    expect(binding.kind === 'resolved' ? binding.connection.id : null).toBe(
      'second',
    );
  });

  // archive#3740 was reported as "disabling the built-in vector store stops
  // Station's engine chatting". A vector store is not a chat model, and the
  // binding must not change when one is toggled either way.
  test('a vector store is never the engine, present or absent', () => {
    const withVectorDb = resolveStationModelBinding({
      modelConnectionId: '',
      modelConnections: [
        { ...(vectorDb as never as object) } as never,
        readyLlm,
      ],
      appConfig: null,
    });
    const withoutVectorDb = resolveStationModelBinding({
      modelConnectionId: '',
      modelConnections: [
        {
          ...(vectorDb as never as object),
          enabled: false,
          status: 'disabled',
        } as never,
        readyLlm,
      ],
      appConfig: null,
    });
    expect(withVectorDb).toEqual(withoutVectorDb);
    expect(withVectorDb.kind).toBe('resolved');

    expect(
      resolveStationModelBinding({
        modelConnectionId: '',
        modelConnections: [vectorDb],
        appConfig: null,
      }),
    ).toEqual({
      kind: 'unresolved',
      reason:
        'Station needs a ready model connection before it can run this agent.',
    });
  });

  // An unresolved binding always carries the sentence the picker prints, so
  // a disabled Create can never be silent.
  test('a named connection that cannot serve says so in its own words', () => {
    expect(
      resolveStationModelBinding({
        modelConnectionId: 'stub-compat',
        modelConnections: [
          {
            ...(readyLlm as never as object),
            status: 'missing_prerequisites',
            readinessEvidence: { summary: 'Stub compat needs an API key.' },
          } as never,
        ],
        appConfig: null,
      }),
    ).toEqual({
      kind: 'unresolved',
      reason: 'Stub compat needs an API key.',
    });

    expect(
      resolveStationModelBinding({
        modelConnectionId: 'gone',
        modelConnections: [readyLlm],
        appConfig: null,
      }),
    ).toEqual({
      kind: 'unresolved',
      reason: 'The model connection this agent names is no longer configured.',
    });
  });
});
