import {
  normalizeLocalBrowserPreviewUrl,
  parseWorkspaceBrowserPreviewPaneState,
  parseWorkspaceBrowserPreviewState,
  WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION,
  WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR,
  WORKSPACE_BROWSER_PREVIEW_PANE_VERSION,
} from '../workspace-browser-preview.js';

describe('Workspace browser preview contract', () => {
  test('publishes one canonical Browser Preview descriptor and parses durable metadata without renderer health', () => {
    expect(WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR).toMatchObject({
      id: 'pane:builtin:workspace-preview:browser-preview',
      rendererId:
        'renderer:builtin:builtin-component:workspace-browser-preview',
      renderer: {
        kind: 'builtin-component',
        name: 'workspace-browser-preview',
      },
      placement: {
        supportedRegions: ['primary', 'secondary', 'standalone'],
        preferredRegion: 'secondary',
      },
      modes: [
        { id: 'default', contextRequirement: { project: true, source: true } },
      ],
      provenance: { origin: 'builtin' },
      lifecycle: { stage: 'preview' },
    });
    expect(
      parseWorkspaceBrowserPreviewPaneState({
        version: WORKSPACE_BROWSER_PREVIEW_PANE_VERSION,
        projectId: 'project-uuid-1',
        requestedUrl: 'http://localhost:5173',
        viewportPreference: 'responsive',
        updatedAt: '2026-08-09T12:00:00.000Z',
      }),
    ).toEqual({
      version: WORKSPACE_BROWSER_PREVIEW_PANE_VERSION,
      projectId: 'project-uuid-1',
      requestedUrl: 'http://localhost:5173/',
      viewportPreference: 'responsive',
      updatedAt: '2026-08-09T12:00:00.000Z',
    });
  });

  test.each([
    { version: '2.0' },
    { projectId: ' project-uuid-1 ' },
    { requestedUrl: 'https://example.test/' },
    { viewportPreference: 'print' },
    { updatedAt: 'soon' },
    { status: 'rendering-unverified' },
  ])('rejects malformed or renderer-owned pane metadata: %j', (override) => {
    expect(
      parseWorkspaceBrowserPreviewPaneState({
        version: WORKSPACE_BROWSER_PREVIEW_PANE_VERSION,
        projectId: 'project-uuid-1',
        requestedUrl: 'http://localhost:5173/',
        viewportPreference: 'responsive',
        updatedAt: '2026-08-09T12:00:00.000Z',
        ...override,
      }),
    ).toBeNull();
  });

  test.each([
    ['http://localhost:5173/app', 'http://localhost:5173/app'],
    ['https://127.0.0.1:8443/', 'https://127.0.0.1:8443/'],
    ['http://127.255.255.255:3000', 'http://127.255.255.255:3000/'],
    ['http://[::1]:4173/', 'http://[::1]:4173/'],
  ])('normalizes bounded loopback URL %s', (input, expected) => {
    expect(normalizeLocalBrowserPreviewUrl(input)).toBe(expected);
  });

  test.each([
    'ftp://localhost/file',
    'file:///tmp/index.html',
    'https://example.test/',
    'http://localhost.evil.test/',
    'http://user:password@localhost:5173/',
    'http://localhost:5173/#section',
    'http://[::2]:5173/',
  ])('rejects non-local or unsafe URL %s', (input) => {
    expect(() => normalizeLocalBrowserPreviewUrl(input)).toThrow();
  });

  test('parses versioned descriptive state without claiming renderer health', () => {
    expect(
      parseWorkspaceBrowserPreviewState({
        contractVersion: WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION,
        requestedUrl: 'http://localhost:5173',
        currentUrl: 'http://localhost:5173/',
        status: 'rendering-unverified',
        historyCapability: 'unavailable',
        viewportPreference: 'responsive',
        updatedAt: '2026-08-02T12:00:00.000Z',
        identity: {
          projectId: 'project-1',
          taskId: 'task-1',
          environmentId: 'development',
        },
      }),
    ).toEqual({
      contractVersion: WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION,
      requestedUrl: 'http://localhost:5173/',
      currentUrl: 'http://localhost:5173/',
      status: 'rendering-unverified',
      historyCapability: 'unavailable',
      viewportPreference: 'responsive',
      updatedAt: '2026-08-02T12:00:00.000Z',
      identity: {
        projectId: 'project-1',
        taskId: 'task-1',
        environmentId: 'development',
      },
    });
  });

  test.each([
    { contractVersion: '2.0' },
    { status: 'healthy' },
    { historyCapability: 'available' },
    { requestedUrl: 'https://example.test/' },
    { currentUrl: 'http://localhost/#fragment' },
    { updatedAt: 'soon' },
    { updatedAt: 'August 2, 2026 12:00:00 UTC' },
    { identity: {} },
    { identity: { projectId: ' project-1 ' } },
    { unexpected: true },
  ])('rejects a malformed state field: %j', (override) => {
    const state = {
      contractVersion: WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION,
      requestedUrl: 'http://localhost:5173/',
      currentUrl: 'http://localhost:5173/',
      status: 'loading',
      historyCapability: 'unavailable',
      viewportPreference: 'desktop',
      updatedAt: '2026-08-02T12:00:00.000Z',
      ...override,
    };
    expect(() => parseWorkspaceBrowserPreviewState(state)).toThrow();
  });

  test('rejects inherited state instead of treating prototype fields as transport data', () => {
    const inherited = Object.create({
      contractVersion: WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION,
      requestedUrl: 'http://localhost:5173/',
      currentUrl: 'http://localhost:5173/',
      status: 'loading',
      historyCapability: 'unavailable',
      viewportPreference: 'desktop',
      updatedAt: '2026-08-02T12:00:00.000Z',
    });

    expect(() => parseWorkspaceBrowserPreviewState(inherited)).toThrow();
  });

  test('rejects accessors without evaluating them at either state level', () => {
    let getterReads = 0;
    const state = {
      contractVersion: WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION,
      requestedUrl: 'http://localhost:5173/',
      currentUrl: 'http://localhost:5173/',
      status: 'loading',
      historyCapability: 'unavailable',
      viewportPreference: 'desktop',
      updatedAt: '2026-08-02T12:00:00.000Z',
      identity: Object.defineProperty({}, 'projectId', {
        enumerable: true,
        get() {
          getterReads += 1;
          return 'project-1';
        },
      }),
    };

    expect(() => parseWorkspaceBrowserPreviewState(state)).toThrow();
    expect(getterReads).toBe(0);

    const topLevelAccessor = Object.defineProperty(
      { ...state, identity: undefined },
      'currentUrl',
      {
        enumerable: true,
        get() {
          getterReads += 1;
          return 'http://localhost:5173/';
        },
      },
    );
    expect(() => parseWorkspaceBrowserPreviewState(topLevelAccessor)).toThrow();
    expect(getterReads).toBe(0);
  });
});
