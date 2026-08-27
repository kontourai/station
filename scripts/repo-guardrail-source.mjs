import { readFileSync } from 'node:fs';

export function createRequiredSourceReader({
  baseUrl,
  reportMissing,
  readSource = (sourceUrl) => readFileSync(sourceUrl, 'utf8'),
}) {
  if (typeof reportMissing !== 'function') {
    throw new TypeError('reportMissing must be a function');
  }

  return (relativePath) => {
    const sourceUrl = new URL(relativePath, baseUrl);
    try {
      return readSource(sourceUrl);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      reportMissing(relativePath);
      return '';
    }
  };
}

const PANE_HOST_COMPOSITION_REQUIREMENTS = [
  {
    sourceKey: 'projectLayoutRenderer',
    sourceLabel: 'ProjectLayoutRenderer',
    marker: "from '../workspace-panes/builtinWorkspacePaneRegistry'",
    expectation: 'resolve builtin panes through builtinWorkspacePaneRegistry',
  },
  {
    sourceKey: 'projectLayoutRenderer',
    sourceLabel: 'ProjectLayoutRenderer',
    marker: '<WorkspacePaneHost',
    expectation: 'own the WorkspacePaneHost composition boundary',
  },
  {
    sourceKey: 'projectLayoutRenderer',
    sourceLabel: 'ProjectLayoutRenderer',
    marker: `const Pane =
            descriptor &&
            getBuiltinWorkspacePaneRenderer(`,
    expectation: 'delegate builtin renderer selection to the pane registry',
  },
  {
    sourceKey: 'builtinWorkspacePaneRegistry',
    sourceLabel: 'builtinWorkspacePaneRegistry',
    marker: 'export function getBuiltinWorkspacePaneRenderer(',
    expectation: 'export the builtin renderer selection seam',
  },
  ...[
    [
      '[WORKSPACE_CODING_FILE_BROWSER_PANE_RENDERER_NAME]: CodingFileBrowserPane,',
      'map file-browser panes to CodingFileBrowserPane',
    ],
    [
      '[WORKSPACE_CODING_DIFF_PANE_RENDERER_NAME]: CodingDiffPane,',
      'map diff panes to CodingDiffPane',
    ],
    [
      '[WORKSPACE_CODING_TERMINAL_PANE_RENDERER_NAME]: CodingTerminalWorkspacePane,',
      'map terminal panes to CodingTerminalWorkspacePane',
    ],
  ].map(([marker, expectation]) => ({
    sourceKey: 'builtinWorkspacePaneRegistry',
    sourceLabel: 'builtinWorkspacePaneRegistry',
    marker,
    expectation,
  })),
  {
    sourceKey: 'builtinWorkspacePaneRegistry',
    sourceLabel: 'getBuiltinWorkspacePaneRenderer',
    marker: 'builtinWorkspacePaneRegistry[',
    expectation: 'delegate selection to the builtin workspace pane registry',
  },
];

/**
 * The current pane-host invariant: the project renderer owns host composition,
 * while the builtin registry owns builtin renderer selection and leaf panels.
 */
export function collectPaneHostCompositionFindings({
  projectLayoutRenderer,
  builtinWorkspacePaneRegistry,
}) {
  const sources = { projectLayoutRenderer, builtinWorkspacePaneRegistry };
  return PANE_HOST_COMPOSITION_REQUIREMENTS.flatMap((requirement) =>
    sources[requirement.sourceKey]?.includes(requirement.marker)
      ? []
      : [`${requirement.sourceLabel} must ${requirement.expectation}.`],
  );
}
