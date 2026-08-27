import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

vi.mock(
  '@kontourai/station-shared/lifecycle-events',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/lifecycle-events')
      >();
    return {
      ...actual,
      acquireFileMutationLock: (path: string) =>
        actual.acquireFileMutationLock(path, {
          birthFingerprint: (pid) => `test-birth-${pid}`,
        }),
    };
  },
);

import {
  phase4aAgentsExportRequiredSections,
  phase4aAgentsMdFixture,
  phase4aRoundTripMatrix,
} from './fixtures/phase4a-portability-fixtures.js';
import {
  extractLossReport,
  extractMarkdownHeadings,
  fieldsRequiringLossWarnings,
  mapRoundTripByFieldId,
} from './helpers/phase4a-portability.js';

describe('Phase 4a AGENTS portability verification backbone', () => {
  test('defines the minimum required AGENTS.md structured sections in order', () => {
    expect(extractMarkdownHeadings(phase4aAgentsMdFixture)).toEqual(
      phase4aAgentsExportRequiredSections,
    );
  });

  test('embeds a machine-readable loss report block for non-round-trippable fields', () => {
    const lossReport = extractLossReport(phase4aAgentsMdFixture);

    expect(lossReport.format).toBe('agents-md');
    expect(lossReport.version).toBe(1);
    expect(lossReport.warnings.length).toBeGreaterThan(0);
  });

  test('requires every degraded or ignored matrix field to produce a loss warning', () => {
    const lossReport = extractLossReport(phase4aAgentsMdFixture);

    expect(
      lossReport.warnings.map((warning) => warning.fieldId).sort(),
    ).toEqual(fieldsRequiringLossWarnings(phase4aRoundTripMatrix).sort());
  });

  test('keeps warning codes and import behavior aligned with the round-trip matrix', () => {
    const byFieldId = mapRoundTripByFieldId(phase4aRoundTripMatrix);
    const lossReport = extractLossReport(phase4aAgentsMdFixture);

    for (const warning of lossReport.warnings) {
      const matrixEntry = byFieldId.get(warning.fieldId);
      expect(matrixEntry).toBeDefined();
      expect(matrixEntry?.disposition).not.toBe('preserved');
      expect(warning.code).toBe(matrixEntry?.lossReportCode);
      expect(warning.importBehavior).toBe(matrixEntry?.importBehavior);
    }
  });

  test('treats preserved fields as deterministic round-trip candidates without loss warnings', () => {
    const warnedFieldIds = new Set(
      extractLossReport(phase4aAgentsMdFixture).warnings.map(
        (warning) => warning.fieldId,
      ),
    );

    for (const entry of phase4aRoundTripMatrix.filter(
      (candidate) => candidate.disposition === 'preserved',
    )) {
      expect(entry.importBehavior).toBe('restore-to-canonical-config');
      expect(entry.lossReportCode).toBeUndefined();
      expect(warnedFieldIds.has(entry.fieldId)).toBe(false);
    }
  });
});

describe('Phase 4a CLI contract placeholders', () => {
  test('station export --format=agents-md emits the structured sections and machine-readable export block', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-portability-spec-home-'));
    const outDir = mkdtempSync(join(tmpdir(), 'station-portability-spec-out-'));

    try {
      mkdirSync(join(home, 'config'), { recursive: true });
      mkdirSync(join(home, 'agents', 'assistant'), { recursive: true });
      mkdirSync(join(home, 'integrations', 'github'), { recursive: true });

      writeFileSync(
        join(home, 'config', 'app.json'),
        JSON.stringify(
          {
            systemPrompt: 'Be helpful',
            defaultModel: 'gpt-5.4',
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(home, 'agents', 'assistant', 'agent.json'),
        JSON.stringify({ name: 'Assistant', prompt: 'Help users' }, null, 2),
      );
      writeFileSync(
        join(home, 'integrations', 'github', 'integration.json'),
        JSON.stringify(
          {
            id: 'github',
            kind: 'mcp',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
          },
          null,
          2,
        ),
      );

      const { exportConfig } = await import('../commands/export.js');
      const output = exportConfig({
        format: 'agents-md',
        output: join(outDir, 'AGENTS.md'),
        projectHome: home,
      });

      expect(extractMarkdownHeadings(output)).toEqual([
        'Workspace Guidance',
        'Managed Agents',
        'MCP Tool Expectations',
        'Loss Report',
      ]);
      expect(output).toContain('<!-- STATION:EXPORT:START -->');
      const document = JSON.parse(
        output.match(/```json\s*([\s\S]*?)\s*```/)![1],
      );
      expect(document.guidance.workspace.systemPrompt).toBe('Be helpful');
      expect(document.losses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'omitted-field',
            path: 'defaultModel',
          }),
        ]),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('station import <AGENTS.md> restores preserved fields to canonical config and unmatched prose as notes', async () => {
    const home = mkdtempSync(
      join(tmpdir(), 'station-portability-spec-import-'),
    );
    const sourcePath = join(home, 'AGENTS.md');

    try {
      writeFileSync(
        sourcePath,
        `# AGENTS.md

Operator note outside the structured block.

<!-- STATION:EXPORT:START -->
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
      integrations: [{ id: 'codex', transport: 'stdio', command: 'codex' }],
    },
    losses: [],
  },
  null,
  2,
)}
\`\`\`
<!-- STATION:EXPORT:END -->
`,
        'utf-8',
      );

      const { importConfig } = await import('../commands/import.js');
      const result = await importConfig(sourcePath, { projectHome: home });
      const ledger = JSON.parse(readFileSync(result.ledgerPath, 'utf-8'));

      expect(
        JSON.parse(readFileSync(join(home, 'config', 'app.json'), 'utf-8'))
          .systemPrompt,
      ).toBe('Imported prompt');
      expect(
        JSON.parse(
          readFileSync(
            join(home, 'agents', 'assistant', 'agent.json'),
            'utf-8',
          ),
        ).prompt,
      ).toBe('Hi');
      expect(result.notesPath).toBeDefined();
      expect(readFileSync(result.notesPath!, 'utf-8')).toContain(
        'Operator note',
      );
      expect(ledger.degradedFields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'ambiguous-prose',
            path: 'AGENTS.md',
          }),
        ]),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('station-exported AGENTS.md round-trips with preserved guidance stable and loss markers retained', async () => {
    const sourceHome = mkdtempSync(
      join(tmpdir(), 'station-portability-spec-source-'),
    );
    const targetHome = mkdtempSync(
      join(tmpdir(), 'station-portability-spec-target-'),
    );
    const exportPath = join(sourceHome, 'AGENTS.md');

    try {
      mkdirSync(join(sourceHome, 'config'), { recursive: true });
      mkdirSync(join(sourceHome, 'agents', 'assistant'), { recursive: true });

      writeFileSync(
        join(sourceHome, 'config', 'app.json'),
        JSON.stringify(
          {
            systemPrompt: 'Round-trip me',
            defaultModel: 'gpt-5.4',
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(sourceHome, 'agents', 'assistant', 'agent.json'),
        JSON.stringify({ name: 'Assistant', prompt: 'Help users' }, null, 2),
      );

      const { exportConfig } = await import('../commands/export.js');
      const { importConfig } = await import('../commands/import.js');

      const first = exportConfig({
        format: 'agents-md',
        output: exportPath,
        projectHome: sourceHome,
      });
      await importConfig(exportPath, { projectHome: targetHome });
      const second = exportConfig({
        format: 'agents-md',
        projectHome: targetHome,
      });

      const firstDocument = JSON.parse(
        first.match(/```json\s*([\s\S]*?)\s*```/)![1],
      );
      const secondDocument = JSON.parse(
        second.match(/```json\s*([\s\S]*?)\s*```/)![1],
      );

      expect(secondDocument.guidance).toEqual(firstDocument.guidance);
      expect(firstDocument.losses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'omitted-field',
            path: 'defaultModel',
          }),
        ]),
      );
      expect(secondDocument.losses).toEqual([]);
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
    }
  });
});
