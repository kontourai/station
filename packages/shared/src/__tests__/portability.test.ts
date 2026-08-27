import { describe, expect, test } from 'vitest';
import {
  buildAgentsMdDocument,
  buildAgentsMdImportPlan,
  normalizeMcpToolDef,
  parseAgentsMd,
  serializeAgentsMd,
} from '../portability.js';
import type { AgentSpec, AppConfig, ToolDef } from '../types.js';

describe('portability helpers', () => {
  test('bounds an incomplete export-marker run (station#2384)', () => {
    const startedAt = performance.now();
    expect(() =>
      parseAgentsMd('<!-- STATION:EXPORT:START -->'.repeat(50_000)),
    ).toThrow('No Station export block found');
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test('bounds thousands of candidate closing fences without an export terminator (station#2384)', () => {
    // N chosen so the pre-fix O(fences×length) scan (~796ms) blows the
    // budget while the linear scan stays ~5ms — i.e. this test actually
    // discriminates against the quadratic regression (station#2384). At
    // N=50_000 the quadratic version finished in ~90ms and passed.
    const input = `<!-- STATION:EXPORT:START -->
\`\`\`json
{}
${'```x\n'.repeat(150_000)}`;
    const startedAt = performance.now();
    expect(() => parseAgentsMd(input)).toThrow('No Station export block found');
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test('serializes and parses a Station AGENTS export block', () => {
    const appConfig: AppConfig = {
      systemPrompt: 'Be helpful',
      approvalGuardian: { enabled: true, mode: 'review' },
      defaultModel: 'gpt-5.4',
      invokeModel: 'gpt-5.4',
      structureModel: 'gpt-5.4',
    };
    const agent: AgentSpec = {
      name: 'Writer',
      prompt: 'Write clearly',
      tools: { mcpServers: ['filesystem'] },
    };
    const integration: ToolDef = {
      id: 'filesystem',
      kind: 'mcp',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
    };

    const document = buildAgentsMdDocument({
      appConfig,
      agents: [{ slug: 'writer', spec: agent }],
      integrations: [integration],
      generatedAt: '2026-04-12T06:00:00.000Z',
    });

    expect(document.losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'omitted-field',
          path: 'defaultModel',
        }),
      ]),
    );

    const markdown = serializeAgentsMd(document);
    const parsed = parseAgentsMd(markdown);

    expect(parsed.document.guidance.workspace.systemPrompt).toBe('Be helpful');
    expect(parsed.document.guidance.agents[0]?.slug).toBe('writer');
    expect(parsed.document.guidance.integrations[0]?.id).toBe('filesystem');
    expect(parsed.unmatchedProse).toBeNull();
    expect(parsed.warnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'ambiguous-prose' }),
      ]),
    );
  });

  test('builds an import plan that denormalizes integrations and keeps degraded warnings', () => {
    const markdown = `# AGENTS.md

${'<!-- STATION:EXPORT:START -->'}
\`\`\`json
${JSON.stringify(
  {
    kind: 'station-agents-md',
    version: 1,
    generatedAt: '2026-04-12T06:00:00.000Z',
    guidance: {
      workspace: { systemPrompt: 'Imported prompt' },
      agents: [
        { slug: 'assistant', spec: { name: 'Assistant', prompt: 'Hi' } },
      ],
      integrations: [
        {
          id: 'codex',
          transport: 'stdio',
          command: 'codex',
        },
      ],
    },
    losses: [
      {
        code: 'degraded-field',
        scope: 'document',
        path: 'notes',
        message: 'Example warning',
        severity: 'warning',
      },
    ],
  },
  null,
  2,
)}
\`\`\`
${'<!-- STATION:EXPORT:END -->'}
`;

    const parsed = parseAgentsMd(markdown);
    const plan = buildAgentsMdImportPlan({
      sourcePath: '/tmp/AGENTS.md',
      parsed,
      importedAt: '2026-04-12T06:10:00.000Z',
      notesPath: '/tmp/import-note.md',
    });

    expect(plan.appConfig.systemPrompt).toBe('Imported prompt');
    expect(plan.agents[0]?.slug).toBe('assistant');
    expect(plan.integrations[0]).toEqual(
      expect.objectContaining({
        id: 'codex',
        kind: 'mcp',
        transport: 'stdio',
        command: 'codex',
      }),
    );
    expect(plan.ledgerEntry.degradedFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'degraded-field' }),
      ]),
    );
    expect(plan.ledgerEntry.notesPath).toBe('/tmp/import-note.md');
  });

  test('records a manifest icon as an omitted-field PortabilityLoss instead of silently dropping it (issue #691)', () => {
    const integration: ToolDef = {
      id: 'survey-mcp',
      kind: 'mcp',
      transport: 'stdio',
      command: 'survey-review-mcp',
      icon: '📋',
    };

    const { normalized, losses } = normalizeMcpToolDef(integration);

    // The AGENTS.md export whitelist is unchanged this slice: icon is not
    // part of the portable projection.
    expect(normalized).not.toHaveProperty('icon');
    expect(losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'omitted-field',
          scope: 'integration',
          path: 'survey-mcp.icon',
        }),
      ]),
    );
  });

  test('does not record an icon loss when the integration declares no icon', () => {
    const integration: ToolDef = {
      id: 'survey-mcp',
      kind: 'mcp',
      transport: 'stdio',
      command: 'survey-review-mcp',
    };

    const { losses } = normalizeMcpToolDef(integration);
    expect(losses).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'omitted-field' }),
      ]),
    );
  });

  test('exports only credential-free hints and rejects secret binding refs on import', () => {
    const { normalized } = normalizeMcpToolDef({
      id: 'github',
      kind: 'mcp',
      transport: 'stdio',
      command: 'github-mcp',
      env: { TOKEN: 'legacy-material-sentinel' },
      storedEnvNames: ['OTHER'],
      secretEnvRefs: { TOKEN: 'binding-id', BOUND: 'other-binding-id' },
      requiredEnvNames: ['PREDECLARED'],
    });
    expect(normalized).toMatchObject({
      requiredEnvNames: ['BOUND', 'OTHER', 'PREDECLARED', 'TOKEN'],
    });
    expect(JSON.stringify(normalized)).not.toContain(
      'legacy-material-sentinel',
    );
    expect(JSON.stringify(normalized)).not.toContain('binding-id');

    const poisoned = `<!-- STATION:EXPORT:START -->
\`\`\`json
${JSON.stringify({
  kind: 'station-agents-md',
  version: 1,
  generatedAt: '2026-08-24T00:00:00.000Z',
  guidance: {
    workspace: {},
    agents: [],
    integrations: [
      {
        id: 'github',
        transport: 'stdio',
        command: 'github-mcp',
        secretEnvRefs: { TOKEN: 'binding-id' },
      },
    ],
  },
  losses: [],
})}
\`\`\`
<!-- STATION:EXPORT:END -->`;
    expect(() => parseAgentsMd(poisoned)).toThrow(
      'Portable imports cannot contain secretEnvRefs.',
    );
  });
});
