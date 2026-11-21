// @vitest-environment node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../config-loader.js';
import { validator } from '../validator.js';

// Mock the logger seam directly — config-loader.ts's module-scope logger
// is built through `createLogger` from our own seam (archive#1895), not
// `@voltagent/logger` any more. `vi.hoisted` is required because `vi.mock`
// factories are hoisted above normal `const`s.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  },
}));
vi.mock('../../utils/logger.js', async () => {
  const actual = await vi.importActual<typeof import('../../utils/logger.js')>(
    '../../utils/logger.js',
  );
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

const createTempDir = () => mkdtempSync(join(tmpdir(), 'station-test-'));

describe('Agent schema validation', () => {
  it('accepts component and workflow shortcut metadata', () => {
    const spec = {
      name: 'Test Agent',
      prompt: 'Do things.',
      ui: {
        component: 'custom-component',
        workflowShortcuts: ['daily-report.ts'],
      },
    };

    expect(() => validator.validateAgentSpec(spec)).not.toThrow();
  });

  it('rejects the retired quick prompt field in a new document', () => {
    const spec = {
      name: 'Broken Agent',
      prompt: 'Does not matter.',
      ui: {
        quickPrompts: [
          { id: 'hello', label: 'Say Hello', prompt: 'Hello there!' },
        ],
      },
    };

    expect(() => validator.validateAgentSpec(spec)).toThrowError(
      /Invalid agent configuration:[\s\S]*\/ui: must NOT have additional properties/,
    );
  });

  it('accepts execution metadata for runtime-backed agents', () => {
    const spec = {
      name: 'Claude Runtime Chat',
      prompt: 'You are a project-aware chat assistant.',
      execution: {
        agentConnectionId: 'claude',
        modelId: 'claude-sonnet-4',
        runtimeOptions: {
          thinking: true,
          effort: 'medium',
        },
      },
    };

    expect(() => validator.validateAgentSpec(spec)).not.toThrow();
  });

  it('accepts a spec carrying an owning project slug (station#1004, unification slice 7)', () => {
    const spec = {
      name: 'Project Owned Agent',
      prompt: 'You are owned by a project.',
      project: 'demo-project',
    };

    expect(() => validator.validateAgentSpec(spec)).not.toThrow();
  });

  it('still rejects unknown top-level fields', () => {
    const spec = {
      name: 'Bad Agent',
      prompt: 'Prompt.',
      totallyUnknownField: 'nope',
    };

    expect(() => validator.validateAgentSpec(spec)).toThrowError(
      /must NOT have additional properties/,
    );
  });

  it('accepts the unattended opt-in as a string list, and only as one (#2613)', () => {
    const spec = (unattendedAutoApprove: unknown) => ({
      name: 'Scheduled Agent',
      prompt: 'Prompt.',
      tools: {
        mcpServers: ['station-control'],
        autoApprove: ['station-control_*'],
        unattendedAutoApprove,
      },
    });

    expect(() =>
      validator.validateAgentSpec(spec(['station-control_list_agents'])),
    ).not.toThrow();
    expect(() => validator.validateAgentSpec(spec('*'))).toThrowError(
      /must be array/,
    );
  });

  it('accepts an empty prompt for connected runtimes', () => {
    const spec = {
      name: 'Codex Runtime Chat',
      prompt: '',
      execution: {
        agentConnectionId: 'codex',
      },
    };

    expect(() => validator.validateAgentSpec(spec)).not.toThrow();
  });

  it('does not treat a Bedrock provider-model id as a managed Agent runtime (#1055)', () => {
    const spec = {
      name: 'Managed Agent',
      prompt: '',
      execution: {
        agentConnectionId: 'bedrock-runtime',
      },
    };

    expect(() => validator.validateAgentSpec(spec)).not.toThrow();
  });

  it('an unbound spec is a STATION-engine spec, so it needs a prompt (#3662)', () => {
    // Absent `agentConnectionId` means Station's own engine, which delivers
    // the system prompt natively — so the managed rule applies to it exactly
    // as it does to a bedrock/ollama binding.
    expect(() =>
      validator.validateAgentSpec({ name: 'Unbound Agent', prompt: '' }),
    ).toThrowError(/System prompt is required for managed agents/);
  });

  it('exempts the reserved station Agent, and only when named (#3662)', () => {
    // Station's own Agent record is an overlay: the runtime builds its one
    // instance under the internal `default` key, never from this spec, and
    // the prompt that instance runs with is Station's own. An empty prompt
    // here is the truth about the record, not an omission — which is why the
    // seed can write it. The exemption is keyed to the identity, so the same
    // bytes under any other slug still fail.
    const spec = { name: 'Station', prompt: '' };
    expect(() => validator.validateAgentSpec(spec, 'station')).not.toThrow();
    expect(() => validator.validateAgentSpec(spec, 'my-agent')).toThrowError(
      /System prompt is required for managed agents/,
    );
  });

  // #2436: an Agent's default approval posture is part of its execution
  // config; the schema must admit it or every saved default is unloadable.
  it('accepts an execution approval default, and only a real posture', () => {
    const withMode = (approvalMode: unknown) => ({
      name: 'Posture Agent',
      prompt: '',
      execution: { agentConnectionId: 'claude', approvalMode },
    });
    for (const mode of ['ask', 'auto', 'never', 'connection-default']) {
      expect(() => validator.validateAgentSpec(withMode(mode))).not.toThrow();
    }
    expect(() => validator.validateAgentSpec(withMode('yolo'))).toThrow();
  });

  it('does not treat an Ollama provider-model id as a managed Agent runtime (#1055)', () => {
    const spec = {
      name: 'Ollama Managed Agent',
      prompt: '',
      execution: {
        agentConnectionId: 'ollama-runtime',
      },
    };

    expect(() => validator.validateAgentSpec(spec)).not.toThrow();
  });
});

describe('retired Agent configuration fields', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = createTempDir();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const legacy = {
    name: 'Legacy Agent',
    prompt: 'Prompt',
    streaming: {
      useNewPipeline: true,
      enableThinking: false,
      debugStreaming: true,
    },
    ui: {
      component: 'custom-component',
      workflowShortcuts: ['daily-report.ts'],
      quickPrompts: [
        { id: 'hello', label: 'Say Hello', prompt: 'Hello there!' },
      ],
    },
  };

  function writeLegacy(spec: unknown) {
    const agentDir = join(workDir, 'agents', 'legacy');
    mkdirSync(agentDir, { recursive: true });
    const path = join(agentDir, 'agent.json');
    const original = `${JSON.stringify(spec, null, 2)}\n`;
    writeFileSync(path, original);
    return { path, original };
  }

  it('loads both retired fields without rewriting and preserves other UI fields through an edit and reload', async () => {
    const { path, original } = writeLegacy(legacy);
    const loader = new ConfigLoader({ projectHomeDir: workDir });
    const ui = {
      component: 'custom-component',
      workflowShortcuts: ['daily-report.ts'],
    };
    const loaded = await loader.loadAgent('legacy');
    expect(loaded.name).toBe('Legacy Agent');
    expect(loaded.ui).toEqual(ui);
    expect(loaded).not.toHaveProperty('streaming');
    expect(readFileSync(path, 'utf-8')).toBe(original);

    await loader.updateAgent('legacy', { description: 'Edited description' });
    const saved = JSON.parse(readFileSync(path, 'utf-8'));
    expect(saved).toMatchObject({
      name: 'Legacy Agent',
      description: 'Edited description',
    });
    expect(saved.ui).toEqual(ui);
    expect(saved).not.toHaveProperty('streaming');
    expect(await loader.loadAgent('legacy')).toEqual(saved);
  });

  it('refuses unrelated invalid UI data in an old file and keeps its bytes', async () => {
    const { path, original } = writeLegacy({
      ...legacy,
      ui: { ...legacy.ui, unknownUiField: true },
    });
    const loader = new ConfigLoader({ projectHomeDir: workDir });
    await expect(loader.loadAgent('legacy')).rejects.toThrow(
      /Invalid agent configuration:[\s\S]*\/ui: must NOT have additional properties/,
    );
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  it('accepts old callers through the normal create path and writes the canonical shape', async () => {
    const loader = new ConfigLoader({ projectHomeDir: workDir });
    await loader.createAgent(legacy);
    const saved = JSON.parse(
      readFileSync(
        join(workDir, 'agents', 'legacy-agent', 'agent.json'),
        'utf-8',
      ),
    );
    expect(saved).not.toHaveProperty('streaming');
    expect(saved.ui).toEqual({
      component: 'custom-component',
      workflowShortcuts: ['daily-report.ts'],
    });
  });

  it('rejects retired streaming in a new document', () => {
    expect(() =>
      validator.validateAgentSpec({
        name: 'New Agent',
        prompt: 'Prompt.',
        streaming: { enableThinking: true },
      }),
    ).toThrow(
      /Invalid agent configuration:[\s\S]*\/: must NOT have additional properties/,
    );
  });
});

describe('App schema validation', () => {
  it('accepts app config without region', () => {
    const config = {
      defaultModel: 'claude-sonnet',
      invokeModel: 'invoke-model',
      structureModel: 'structure-model',
      approvalGuardian: {
        enabled: true,
        mode: 'enforce',
        model: 'guardian-model',
      },
    };

    expect(() => validator.validateAppConfig(config)).not.toThrow();
  });

  it('#4769: refuses a confinedNetwork whose allowed host the broker cannot read, when it is written', () => {
    const base = {
      defaultModel: 'claude-sonnet',
      invokeModel: 'invoke-model',
      structureModel: 'structure-model',
    };
    for (const confinedNetwork of [
      { mode: 'full' },
      { mode: 'restricted', allowedHosts: [] },
      {
        mode: 'restricted',
        allowedHosts: ['registry.npmjs.org', '*.github.com:443', '[::1]:8443'],
      },
    ])
      expect(() =>
        validator.validateAppConfig({ ...base, confinedNetwork }),
      ).not.toThrow();
    expect(() =>
      validator.validateAppConfig({
        ...base,
        confinedNetwork: {
          mode: 'restricted',
          allowedHosts: ['https://x.com'],
        },
      }),
    ).toThrow(/confinedNetwork: each allowedHosts entry must be/);
    // The shape itself is the schema's to refuse.
    expect(() =>
      validator.validateAppConfig({
        ...base,
        confinedNetwork: { mode: 'restricted' },
      }),
    ).toThrow();
  });

  // ── archive#1503 delta review, R4 ────────────────────────────────────────

  it('LOADS a contribution scope key this version cannot name', () => {
    // This schema is validated on the config LOAD path
    // (`config-loader-app.ts`), not just on save. An earlier revision of
    // archive#1500 constrained `contribution`'s key shape with
    // `propertyNames.pattern`, which turned a key written by a NEWER Station —
    // a future `channel:` scope — into an UNLOADABLE config after a downgrade.
    // That converts the graceful degradation `parseContributionScopeKey` exists
    // to provide ("an unparseable key contributes NOTHING and is never merged")
    // into a hard failure, and it enforces at the read where no operator is
    // present — the same mistake the H2 finding was about.
    //
    // The write path refuses an unusable key with an actionable sentence; the
    // read path must keep loading.
    const config = {
      defaultModel: 'claude-sonnet',
      invokeModel: 'invoke-model',
      structureModel: 'structure-model',
      contribution: {
        'project:prj_1': { enabled: true },
        'channel:chn_1': { enabled: true },
        fleet: { enabled: true },
      },
    };

    expect(() => validator.validateAppConfig(config)).not.toThrow();
  });

  it('still validates the SHAPE of a contribution entry', () => {
    // Removing the key-name pattern must not remove the value checks.
    const config = {
      defaultModel: 'claude-sonnet',
      invokeModel: 'invoke-model',
      structureModel: 'structure-model',
      contribution: { 'project:prj_1': { enabled: 'yes' } },
    };

    expect(() => validator.validateAppConfig(config)).toThrow();
  });
});

describe('ConfigLoader workflow metadata', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = createTempDir();
    const agentDir = join(workDir, 'agents', 'example');
    mkdirSync(join(workDir, 'agents'), { recursive: true });
    mkdirSync(join(agentDir, 'workflows'), { recursive: true });

    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify(
        {
          name: 'Example Agent',
          prompt: 'Prompt',
          ui: {
            workflowShortcuts: ['existing.ts', 'missing.ts'],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    writeFileSync(
      join(agentDir, 'workflows', 'existing.ts'),
      '// workflow placeholder',
      'utf-8',
    );
    writeFileSync(
      join(agentDir, 'workflows', 'second-workflow.js'),
      '// another',
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('lists workflow metadata with derived labels', async () => {
    const loader = new ConfigLoader({ projectHomeDir: workDir });
    const workflows = await loader.listAgentWorkflows('example');

    expect(workflows).toEqual([
      expect.objectContaining({
        id: 'existing.ts',
        label: 'Existing',
        filename: 'existing.ts',
      }),
      expect.objectContaining({
        id: 'second-workflow.js',
        label: 'Second Workflow',
        filename: 'second-workflow.js',
      }),
    ]);
  });

  it('reports missing workflow shortcuts during agent listing', async () => {
    const loader = new ConfigLoader({ projectHomeDir: workDir });
    const agents = await loader.listAgents();

    expect(agents[0].workflowWarnings).toEqual(['missing.ts']);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Agent references missing workflows in ui.workflowShortcuts',
      { agent: 'example', missing: 'missing.ts' },
    );
  });
});
