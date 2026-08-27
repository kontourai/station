import { describe, expect, test } from 'vitest';
import {
  analyzeInventory,
  parseInventory,
} from '../agent-identity-supported-surface-inventory.mjs';

describe('agent identity supported-surface inventory', () => {
  test('keeps classified legacy paths distinct from unclassified paths', () => {
    const report = analyzeInventory(
      new Map([['src-server/known.ts', 'server-runtime']]),
      [
        { path: 'src-server/known.ts', content: "const id = '__agent:known';" },
        { path: 'src-server/new.ts', content: "const id = '__acp:new';" },
      ],
    );

    expect(report.findings).toEqual([
      {
        path: 'src-server/known.ts',
        classification: 'server-runtime',
        matches: 1,
      },
    ]);
    expect(report.unclassified).toEqual(['src-server/new.ts']);
    expect(report.stale).toEqual([]);
  });

  test('rejects stale and duplicate checklist paths', () => {
    expect(
      analyzeInventory(new Map([['src-server/old.ts', 'server-runtime']]), []),
    ).toMatchObject({ stale: ['src-server/old.ts'] });
    expect(() =>
      parseInventory(`<!-- agent-identity-supported-surfaces:start -->
\`\`\`json
{"one":["same.ts"],"two":["same.ts"]}
\`\`\`
<!-- agent-identity-supported-surfaces:end -->`),
    ).toThrow('classified twice');
  });

  test('finds helper definitions, renamed imports, and promotion callback seams', () => {
    const report = analyzeInventory(
      new Map([
        ['packages/shared/src/agent-slug.ts', 'slug-and-alias'],
        ['src-ui/src/utils/execution.ts', 'clients'],
        [
          'src-server/runtime/bootstrap/runtime-initialize-deps.ts',
          'server-runtime',
        ],
      ]),
      [
        {
          path: 'packages/shared/src/agent-slug.ts',
          content: 'export const toRuntimeAgentSlug = (id: string) => id;',
        },
        {
          path: 'src-server/runtime/bootstrap/runtime-startup.ts',
          content: "await runStartupMigrations('/tmp/project');",
        },
        {
          path: 'src-ui/src/utils/execution.ts',
          content: `import { toRuntimeAgentSlug as buildAgentId } from 'shared'; const run = \`\${toRuntimeAgentSlug('id')}\`;`,
        },
        {
          path: 'src-server/runtime/bootstrap/runtime-initialize-deps.ts',
          content:
            'const deps = { onACPConnectionsSettled: () => runDefaultAgentPromotionMigration() };',
        },
      ],
    );

    expect(report.findings.map((finding) => finding.path)).toEqual([
      'packages/shared/src/agent-slug.ts',
      'src-server/runtime/bootstrap/runtime-initialize-deps.ts',
      'src-ui/src/utils/execution.ts',
    ]);
    expect(report).toMatchObject({ unclassified: [], stale: [] });
  });

  test('detects constructed prefixes but exempts documented harmless fixtures', () => {
    const report = analyzeInventory(
      new Map([['src-ui/src/utils/execution.ts', 'clients']]),
      [
        {
          path: 'src-ui/src/utils/execution.ts',
          content: "const legacy = ['__agent', ':'].join('');",
        },
        {
          path: 'src-ui/src/__tests__/identicon.test.ts',
          content: "const hashSeed = '__agent:conn-1';",
        },
      ],
      new Map([
        [
          'src-ui/src/__tests__/identicon.test.ts',
          'Hash-seed fixture literal only.',
        ],
      ]),
    );

    expect(report.findings).toHaveLength(1);
    expect(report.unclassified).toEqual([]);
    expect(report.exemptions).toEqual([
      [
        'src-ui/src/__tests__/identicon.test.ts',
        'Hash-seed fixture literal only.',
      ],
    ]);
  });

  test('detects the retired SDK namespace parser and layout resolver link', () => {
    const report = analyzeInventory(new Map(), [
      {
        path: 'packages/sdk/src/agentResolver.ts',
        content:
          'export function parseAgentSlug() {}; export function resolveAgentName() {}; api._setLayoutContextResolver(fn);',
      },
    ]);

    expect(report.unclassified).toEqual(['packages/sdk/src/agentResolver.ts']);
  });

  test('detects synthetic ACP Agents and colon-derived Agent identity', () => {
    const report = analyzeInventory(new Map(), [
      {
        path: 'src-server/monitoring.ts',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source deliberately contains a literal placeholder
        content: 'const agent = { slug: `acp:${connection.id}` };',
      },
      {
        path: 'src-ui/agent.ts',
        content: "if (agent.slug.includes(':')) return agent.slug;",
      },
      {
        path: 'src-server/plugin.ts',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source deliberately contains a literal placeholder
        content: 'const slug = `${pluginName}:${agent.slug}`;',
      },
    ]);

    expect(report.unclassified).toEqual([
      'src-server/monitoring.ts',
      'src-server/plugin.ts',
      'src-ui/agent.ts',
    ]);
  });
});
