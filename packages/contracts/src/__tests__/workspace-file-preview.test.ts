import {
  isWorkspaceFilePreviewImageDataUrl,
  parseWorkspaceFilePreviewPaneState,
  parseWorkspaceFilePreviewRequest,
  WORKSPACE_FILE_PREVIEW_MAX_IMAGE_FINAL_RASTER_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_LINES,
  WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
} from '../workspace-file-preview.js';

describe('Workspace file preview contract', () => {
  test('publishes a conservative final browser-raster budget', () => {
    expect(WORKSPACE_FILE_PREVIEW_MAX_IMAGE_FINAL_RASTER_BYTES).toBe(
      16 * 1024 * 1024,
    );
  });

  test('admits only bounded PNG data URLs for the image renderer', () => {
    expect(
      isWorkspaceFilePreviewImageDataUrl(
        'data:image/png;base64,iVBORw0KGgo=',
        'image/png',
      ),
    ).toBe(true);
    expect(
      isWorkspaceFilePreviewImageDataUrl(
        'data:image/svg+xml;base64,PHN2Zz4=',
        'image/svg+xml',
      ),
    ).toBe(false);
    expect(
      isWorkspaceFilePreviewImageDataUrl(
        'data:image/png;base64,not valid!',
        'image/png',
      ),
    ).toBe(false);
  });

  test('accepts a workspace-relative request with an inclusive line range', () => {
    expect(
      parseWorkspaceFilePreviewRequest({
        path: 'src/main.ts',
        lineRange: { start: 4, end: 8 },
      }),
    ).toEqual({
      path: 'src/main.ts',
      lineRange: { start: 4, end: 8 },
    });
  });

  test.each([
    undefined,
    {},
    { path: '' },
    { path: 'src/main.ts', root: '/tmp' },
    { path: 'src/main.ts', lineRange: { start: 0, end: 1 } },
    { path: 'src/main.ts', lineRange: { start: 4, end: 3 } },
    {
      path: 'src/main.ts',
      lineRange: { start: 1, end: WORKSPACE_FILE_PREVIEW_MAX_LINES + 1 },
    },
  ])('rejects malformed preview input: %j', (input) => {
    expect(() => parseWorkspaceFilePreviewRequest(input)).toThrow();
  });
});

describe('Workspace File Preview pane state', () => {
  test('exports the one canonical server and UI descriptor identity', () => {
    expect(WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR).toMatchObject({
      id: 'pane:builtin:workspace-preview:file-preview',
      rendererId: 'renderer:builtin:builtin-component:workspace-file-preview',
      renderer: {
        kind: 'builtin-component',
        name: 'workspace-file-preview',
      },
      modes: [
        { id: 'default', contextRequirement: { project: true, source: true } },
      ],
      provenance: { origin: 'builtin' },
    });
  });
  test('admits only a versioned data-only relative state', () => {
    expect(
      parseWorkspaceFilePreviewPaneState({
        version: '1.0',
        projectSlug: 'demo',
        path: 'src/main.ts',
        lineRange: { start: 2, end: 4 },
        wrap: true,
        markdownMode: 'rendered',
      }),
    ).toEqual({
      version: '1.0',
      projectSlug: 'demo',
      path: 'src/main.ts',
      lineRange: { start: 2, end: 4 },
      wrap: true,
      markdownMode: 'rendered',
    });
  });

  test.each([
    { version: '1.0', projectSlug: 'demo', path: '/etc/passwd', wrap: true },
    { version: '1.0', projectSlug: 'demo', path: '../secret', wrap: true },
    { version: '1.0', projectSlug: 'demo', path: 'C:\\secret', wrap: true },
    { version: '1.0', projectSlug: 'demo', path: 'src\\secret', wrap: true },
    { version: '1.0', projectSlug: 'demo', path: 'src/../secret', wrap: true },
    {
      version: '1.0',
      projectSlug: 'demo',
      path: 'src/main.ts',
      wrap: true,
      renderer: 'native',
    },
    {
      version: '1.0',
      projectSlug: 'demo',
      path: 'README.md',
      wrap: true,
      markdownMode: 'html',
    },
  ])('fails closed for non-pane data: %j', (value) => {
    expect(parseWorkspaceFilePreviewPaneState(value)).toBeNull();
  });
});
