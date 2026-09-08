import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import {
  collectPaneHostCompositionFindings,
  createRequiredSourceReader,
} from '../repo-guardrail-source.mjs';

describe('required repo-guardrail sources', () => {
  test('returns source text without reporting an existing path', () => {
    const reportMissing = vi.fn();
    const readRequiredSource = createRequiredSourceReader({
      baseUrl: import.meta.url,
      reportMissing,
      readSource: (sourceUrl) => sourceUrl.pathname,
    });

    expect(readRequiredSource('../proof-repo-guardrails.mjs')).toContain(
      'proof-repo-guardrails.mjs',
    );
    expect(reportMissing).not.toHaveBeenCalled();
  });

  test('turns a deleted required path into an actionable gate failure', () => {
    const reportMissing = vi.fn();
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const readRequiredSource = createRequiredSourceReader({
      baseUrl: import.meta.url,
      reportMissing,
      readSource: () => {
        throw missing;
      },
    });

    expect(readRequiredSource('../deleted-source.ts')).toBe('');
    expect(reportMissing).toHaveBeenCalledWith('../deleted-source.ts');
  });

  test('does not mask non-missing filesystem failures', () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const readRequiredSource = createRequiredSourceReader({
      baseUrl: import.meta.url,
      reportMissing: vi.fn(),
      readSource: () => {
        throw denied;
      },
    });

    expect(() => readRequiredSource('../protected-source.ts')).toThrow(denied);
  });

  test('reports a missing current pane-host source instead of throwing ENOENT', () => {
    const reportMissing = vi.fn();
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const readRequiredSource = createRequiredSourceReader({
      baseUrl: import.meta.url,
      reportMissing,
      readSource: () => {
        throw missing;
      },
    });

    expect(
      readRequiredSource(
        '../../src-ui/src/app-shell/ProjectLayoutRenderer.tsx',
      ),
    ).toBe('');
    expect(reportMissing).toHaveBeenCalledWith(
      '../../src-ui/src/app-shell/ProjectLayoutRenderer.tsx',
    );
  });
});

describe('pane-host composition guardrail', () => {
  const projectLayoutRenderer = readFileSync(
    'src-ui/src/app-shell/ProjectLayoutRenderer.tsx',
    'utf8',
  );
  const builtinWorkspacePaneRegistry = readFileSync(
    'src-ui/src/workspace-panes/builtinWorkspacePaneRegistry.tsx',
    'utf8',
  );

  test('accepts the current project pane-host composition', () => {
    expect(
      collectPaneHostCompositionFindings({
        projectLayoutRenderer,
        builtinWorkspacePaneRegistry,
      }),
    ).toEqual([]);
  });

  test.each([
    [
      'project host delegation',
      'projectLayoutRenderer',
      `const Pane =
            descriptor &&
            getBuiltinWorkspacePaneRenderer(`,
      'ProjectLayoutRenderer must delegate builtin renderer selection to the pane registry.',
    ],
  ] as const)(
    'rejects a direct negative mutation of %s',
    (_label, sourceName, marker, expectedFinding) => {
      const sources = { projectLayoutRenderer, builtinWorkspacePaneRegistry };
      const mutated = sources[sourceName].replace(marker, 'removed-by-test');
      expect(mutated).not.toBe(sources[sourceName]);
      expect(mutated).toContain('getBuiltinWorkspacePaneRenderer(');

      expect(
        collectPaneHostCompositionFindings({
          ...sources,
          [sourceName]: mutated,
        }),
      ).toContain(expectedFinding);
    },
  );

  test('rejects swapped file-browser and diff registry mappings', () => {
    const fileBrowserMapping =
      '[WORKSPACE_CODING_FILE_BROWSER_PANE_RENDERER_NAME]: CodingFileBrowserPane,';
    const diffMapping =
      '[WORKSPACE_CODING_DIFF_PANE_RENDERER_NAME]: CodingDiffPane,';
    const mutated = builtinWorkspacePaneRegistry
      .replace(
        fileBrowserMapping,
        '[WORKSPACE_CODING_FILE_BROWSER_PANE_RENDERER_NAME]: CodingDiffPane,',
      )
      .replace(
        diffMapping,
        '[WORKSPACE_CODING_DIFF_PANE_RENDERER_NAME]: CodingFileBrowserPane,',
      );
    expect(mutated).not.toBe(builtinWorkspacePaneRegistry);

    expect(
      collectPaneHostCompositionFindings({
        projectLayoutRenderer,
        builtinWorkspacePaneRegistry: mutated,
      }),
    ).toEqual(
      expect.arrayContaining([
        'builtinWorkspacePaneRegistry must map file-browser panes to CodingFileBrowserPane.',
        'builtinWorkspacePaneRegistry must map diff panes to CodingDiffPane.',
      ]),
    );
  });

  test('rejects a deleted terminal registry mapping', () => {
    const mapping =
      '[WORKSPACE_CODING_TERMINAL_PANE_RENDERER_NAME]: CodingTerminalWorkspacePane,';
    const mutated = builtinWorkspacePaneRegistry.replace(mapping, '');
    expect(mutated).not.toBe(builtinWorkspacePaneRegistry);

    expect(
      collectPaneHostCompositionFindings({
        projectLayoutRenderer,
        builtinWorkspacePaneRegistry: mutated,
      }),
    ).toContain(
      'builtinWorkspacePaneRegistry must map terminal panes to CodingTerminalWorkspacePane.',
    );
  });

  test('rejects a selection seam disabled to return null', () => {
    // Remove the actual lookup expression, rather than a formatting-sensitive
    // whole return statement. The registry declaration itself has no bracket
    // access, so this is a non-vacuous proof that selection remains delegated.
    const lookup = 'builtinWorkspacePaneRegistry[';
    const mutated = builtinWorkspacePaneRegistry.replace(
      lookup,
      'selection-seam-disabled[',
    );
    expect(mutated).not.toBe(builtinWorkspacePaneRegistry);

    expect(
      collectPaneHostCompositionFindings({
        projectLayoutRenderer,
        builtinWorkspacePaneRegistry: mutated,
      }),
    ).toContain(
      'getBuiltinWorkspacePaneRenderer must delegate selection to the builtin workspace pane registry.',
    );
  });
});
