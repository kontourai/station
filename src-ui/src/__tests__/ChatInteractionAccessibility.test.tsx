/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const openPreview = vi.fn();

vi.mock('../contexts/PreviewContext', () => ({
  usePreview: () => ({ openPreview }),
}));

// File previews now resolve attachment bytes through the app's API-base seam,
// even when this test supplies inline image bytes. Keep the accessibility test
// focused on its button contract while mounting the current dependency.
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

import { FilePartPreview } from '../components/chat/FilePartPreview';
import { ToolCallDisplay } from '../components/chat/ToolCallDisplay';

describe('chat interaction accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('uses a native button to open an image preview', () => {
    render(
      <FilePartPreview
        part={{
          type: 'file',
          url: 'https://example.test/diagram.png',
          mediaType: 'image/png',
          name: 'diagram.png',
        }}
        allParts={[
          {
            type: 'file',
            url: 'https://example.test/diagram.png',
            mediaType: 'image/png',
            name: 'diagram.png',
          },
        ]}
      />,
    );

    const preview = screen.getByRole('button', {
      name: 'Preview diagram.png',
    }) as HTMLButtonElement;
    expect(preview.type).toBe('button');
    fireEvent.click(preview);
    expect(openPreview).toHaveBeenCalledWith(
      {
        url: 'https://example.test/diagram.png',
        mediaType: 'image/png',
        name: 'diagram.png',
      },
      [
        {
          url: 'https://example.test/diagram.png',
          mediaType: 'image/png',
          name: 'diagram.png',
        },
      ],
    );
  });

  test('uses one native disclosure button per activity row (station#2652 redesign)', () => {
    const onApprove = vi.fn();
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 'call-1',
          toolName: 'read_file',
          args: { path: 'README.md' },
          state: 'running',
          progressMessage: 'Reading README.md',
          needsApproval: true,
        }}
        onApprove={onApprove}
      />,
    );

    // The row line IS the disclosure button; its accessible name is its
    // visible verb-first label (plus the labelled awaiting-approval state).
    const toggle = screen.getByRole('button', {
      name: /Read README\.md/,
    }) as HTMLButtonElement;
    expect(toggle.type).toBe('button');
    expect(toggle.querySelector('div, pre')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Raw internal state strings never render (the old card printed
    // `state` verbatim as a badge).
    expect(screen.queryByText('running')).toBeNull();
    expect(screen.getByText('Reading README.md')).toBeTruthy();

    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'Enter' });
    // Browsers dispatch click for Enter and Space on native buttons.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Arguments:')).toBeTruthy();

    // The disclosure is the ONLY toggle: clicking (or selecting text
    // inside) the details panel never collapses the row, so copying detail
    // text is always safe — the old document-level click listener is gone.
    fireEvent.click(
      document.querySelector<HTMLElement>('.tool-call__details')!,
    );
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const approve = screen.getByRole('button', {
      name: 'Allow Once',
    }) as HTMLButtonElement;
    expect(approve.type).toBe('button');
    fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledWith('once');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});
