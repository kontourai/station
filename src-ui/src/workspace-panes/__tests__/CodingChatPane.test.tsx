/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFilePreviewPaneState } from '../filePreviewPaneStateStorage';
import { WorkspacePaneHostOpenContext } from '../WorkspacePaneHostOpenContext';

const { isMobile, navigation, setDockState } = vi.hoisted(() => ({
  isMobile: vi.fn(() => false),
  navigation: {
    openFilePreviewIntent: null as {
      projectSlug: string;
      path: string;
      lineRange?: { start: number; end: number };
    } | null,
    updateParams: vi.fn(),
    setDockMode: vi.fn(),
  },
  setDockState: vi.fn(),
}));

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ ...navigation, setDockState }),
}));
vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => isMobile(),
}));

import { CodingChatPane } from '../CodingChatPane';

describe('CodingChatPane', () => {
  afterEach(() => {
    window.localStorage.clear();
    isMobile.mockReset();
    isMobile.mockReturnValue(false);
    navigation.openFilePreviewIntent = null;
    navigation.updateParams.mockReset();
    navigation.setDockMode.mockReset();
    setDockState.mockReset();
  });

  test('does not touch dock placement when Coding chat mounts or unmounts', () => {
    const view = render(
      <CodingChatPane projectId="project-uuid" projectSlug="demo" />,
    );

    expect(navigation.setDockMode).not.toHaveBeenCalled();
    expect(setDockState).not.toHaveBeenCalled();
    view.unmount();
    expect(navigation.setDockMode).not.toHaveBeenCalled();
    expect(setDockState).not.toHaveBeenCalled();
  });

  test('opens the existing mobile chat dock only while its host pane is active', () => {
    isMobile.mockReturnValue(true);
    const view = render(
      <CodingChatPane projectId="project-uuid" projectSlug="demo" />,
    );

    expect(setDockState).toHaveBeenCalledWith(true, true);
    view.unmount();
    expect(setDockState).toHaveBeenLastCalledWith(false, false);
  });

  test.each([
    ['desktop', false],
    ['mobile', true],
  ])(
    'consumes a one-shot File Preview deep link through the host on %s',
    (_, mobile) => {
      isMobile.mockReturnValue(mobile);
      navigation.openFilePreviewIntent = {
        projectSlug: 'demo',
        path: 'src/deep-link.ts',
        lineRange: { start: 17, end: 17 },
      };
      const open = vi.fn((_, preparation) => preparation?.prepare() ?? false);

      render(
        <WorkspacePaneHostOpenContext.Provider value={{ open }}>
          <CodingChatPane projectId="project-uuid" projectSlug="demo" />
        </WorkspacePaneHostOpenContext.Provider>,
      );

      expect(open).toHaveBeenCalledOnce();
      const instance = open.mock.calls[0]?.[0];
      expect(instance).toMatchObject({
        descriptorId: 'pane:builtin:workspace-preview:file-preview',
        boundContext: {
          projectId: 'project-uuid',
          sourceId: 'builtin:workspace-file-preview',
        },
      });
      expect(
        readFilePreviewPaneState(window.localStorage, instance.stateKey),
      ).toMatchObject({
        projectSlug: 'demo',
        path: 'src/deep-link.ts',
        lineRange: { start: 17, end: 17 },
      });
      expect(navigation.updateParams).toHaveBeenCalledWith({
        previewPath: null,
        previewLineStart: null,
        previewLineEnd: null,
      });
    },
  );

  test('does not reopen a File Preview after navigation clears the consumed query', () => {
    navigation.openFilePreviewIntent = {
      projectSlug: 'demo',
      path: 'src/one-shot.ts',
    };
    const open = vi.fn((_, preparation) => preparation?.prepare() ?? false);
    navigation.updateParams.mockImplementation(() => {
      navigation.openFilePreviewIntent = null;
    });
    const view = render(
      <WorkspacePaneHostOpenContext.Provider value={{ open }}>
        <CodingChatPane projectId="project-uuid" projectSlug="demo" />
      </WorkspacePaneHostOpenContext.Provider>,
    );

    view.rerender(
      <WorkspacePaneHostOpenContext.Provider value={{ open }}>
        <CodingChatPane projectId="project-uuid" projectSlug="demo" />
      </WorkspacePaneHostOpenContext.Provider>,
    );

    expect(open).toHaveBeenCalledOnce();
    expect(navigation.updateParams).toHaveBeenCalledOnce();
  });

  test('renders one catalog-admitted Browser Preview creator with its resolved reason', () => {
    render(
      <WorkspacePaneHostOpenContext.Provider value={{ open: vi.fn() }}>
        <CodingChatPane
          projectId="project-uuid"
          projectSlug="demo"
          browserPreviewAvailability={{
            state: 'not-configured',
            reason: { code: 'configuration-missing', source: 'configuration' },
          }}
        />
      </WorkspacePaneHostOpenContext.Provider>,
    );

    expect(
      screen.getByRole('button', { name: 'Open Browser Preview' }),
    ).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toContain('configuration');
  });
});
