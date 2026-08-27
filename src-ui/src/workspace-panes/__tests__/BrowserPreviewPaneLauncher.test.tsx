/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { BrowserPreviewPaneLauncher } from '../BrowserPreviewPaneLauncher';
import { readBrowserPreviewPaneState } from '../browserPreviewPaneStateStorage';

const AVAILABLE = {
  state: 'available' as const,
  reason: { code: 'ready' as const, source: 'resolver' as const },
};

describe('BrowserPreviewPaneLauncher', () => {
  test('opens only a validated local target through the host prepare transaction', () => {
    window.localStorage.clear();
    const open = vi.fn((_, preparation) => preparation?.prepare() ?? false);
    render(
      <BrowserPreviewPaneLauncher
        projectId="project-uuid-1"
        host={{ open }}
        availability={AVAILABLE}
      />,
    );

    fireEvent.change(screen.getByLabelText('Local preview address'), {
      target: { value: 'http://localhost:4173' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Open Browser Preview' }),
    );

    expect(open).toHaveBeenCalledOnce();
    const instance = open.mock.calls[0]?.[0];
    expect(instance).toMatchObject({
      descriptorId: 'pane:builtin:workspace-preview:browser-preview',
      boundContext: {
        projectId: 'project-uuid-1',
        sourceId: 'builtin:workspace-browser-preview',
      },
    });
    expect(
      readBrowserPreviewPaneState(window.localStorage, instance.stateKey),
    ).toMatchObject({
      projectId: 'project-uuid-1',
      requestedUrl: 'http://localhost:4173/',
    });
  });

  test('does not prepare or open an arbitrary remote address', () => {
    const open = vi.fn();
    render(
      <BrowserPreviewPaneLauncher
        projectId="project-uuid-1"
        host={{ open }}
        availability={AVAILABLE}
      />,
    );

    fireEvent.change(screen.getByLabelText('Local preview address'), {
      target: { value: 'https://example.test/' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Open Browser Preview' }),
    );

    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('allowed local');
  });

  test('keeps creation disabled with the catalog-resolved unavailable reason', () => {
    const open = vi.fn();
    render(
      <BrowserPreviewPaneLauncher
        projectId="project-uuid-1"
        host={{ open }}
        availability={{
          state: 'temporarily-unavailable',
          reason: { code: 'health-unavailable', source: 'health' },
        }}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Open Browser Preview' }),
    ).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toContain(
      'temporarily unavailable',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Open Browser Preview' }),
    );
    expect(open).not.toHaveBeenCalled();
  });
});
