/**
 * @vitest-environment jsdom
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clipboardAbsent,
  clipboardRefuses,
  clipboardWrites,
} from './clipboard-stubs';

const { triggerHapticMock } = vi.hoisted(() => ({
  triggerHapticMock: vi.fn(),
}));
vi.mock('../platform/native/haptics', () => ({
  triggerHaptic: triggerHapticMock,
}));

import { SessionConversationItem } from '../components/session/SessionConversationItem';
import { chatDraftsStore } from '../contexts/chat-drafts-store';

afterEach(() => {
  triggerHapticMock.mockReset();
  clipboardAbsent();
});

function renderItem(
  mutable?: boolean,
  overrides: Partial<
    Parameters<typeof SessionConversationItem>[0]['conversation']
  > = {},
) {
  return render(
    <SessionConversationItem
      conversation={{
        id: 'thread-runtime',
        agentSlug: 'claude',
        title: 'Engine history',
        updatedAt: '2026-07-23T00:00:00Z',
        mutable,
        ...overrides,
      }}
      isActive={false}
      hasActiveChat={false}
      isRenaming={false}
      newTitle=""
      inputRef={createRef<HTMLInputElement>()}
      onSelect={vi.fn()}
      onStartRename={vi.fn()}
      onRename={vi.fn()}
      onCancelRename={vi.fn()}
      onDelete={vi.fn()}
      onTitleChange={vi.fn()}
    />,
  );
}

describe('SessionConversationItem', () => {
  it('does not rename on IME Enter, then renames on plain Enter', () => {
    const onRename = vi.fn();
    render(
      <SessionConversationItem
        conversation={{
          id: 'rename-me',
          agentSlug: 'station',
          title: 'Old title',
          updatedAt: '2026-08-13T00:00:00Z',
        }}
        isActive={false}
        hasActiveChat={false}
        isRenaming={true}
        newTitle="New title"
        inputRef={createRef<HTMLInputElement>()}
        onSelect={vi.fn()}
        onStartRename={vi.fn()}
        onRename={onRename}
        onCancelRename={vi.fn()}
        onDelete={vi.fn()}
        onTitleChange={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, {
      key: 'Enter',
      isComposing: true,
      keyCode: 229,
    });
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledOnce();
  });

  it('shows a Draft chip only while the conversation has a non-empty draft', () => {
    chatDraftsStore.clear('thread-runtime');
    renderItem();
    expect(screen.queryByText('Draft')).toBeNull();

    act(() => chatDraftsStore.set('thread-runtime', 'Unsent thought'));
    expect(screen.getByText('Draft')).toBeTruthy();

    act(() => chatDraftsStore.clear('thread-runtime'));
    expect(screen.queryByText('Draft')).toBeNull();
  });

  it('does not show a Draft chip for whitespace-only input', () => {
    chatDraftsStore.set('thread-runtime', '   ');
    renderItem();
    expect(screen.queryByText('Draft')).toBeNull();
    chatDraftsStore.clear('thread-runtime');
  });

  it('uses time only for the last 24 hours and unambiguous locale dates for yesterday, last week, and last year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
    const timeFormat = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    const dateFormat = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
    });
    const cases = [
      {
        id: 'recent',
        updatedAt: '2026-08-16T11:00:00.000Z',
        format: timeFormat,
      },
      {
        id: 'yesterday',
        updatedAt: '2026-08-15T11:00:00.000Z',
        format: dateFormat,
      },
      {
        id: 'last-week',
        updatedAt: '2026-08-09T12:00:00.000Z',
        format: dateFormat,
      },
      {
        id: 'last-year',
        updatedAt: '2025-08-16T12:00:00.000Z',
        format: dateFormat,
      },
    ];

    try {
      for (const entry of cases) {
        const { container, unmount } = renderItem(undefined, entry);
        expect(
          container.querySelector('.session-item__date')?.textContent,
        ).toBe(entry.format.format(new Date(entry.updatedAt)));
        unmount();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not offer destructive actions for runtime-owned history', () => {
    renderItem(false);

    expect(screen.queryByTitle('Rename')).toBeNull();
    expect(screen.queryByTitle('Delete')).toBeNull();
  });

  it('keeps actions for memory-backed history', () => {
    renderItem();

    expect(screen.getByTitle('Rename')).toBeTruthy();
    expect(screen.getByTitle('Delete')).toBeTruthy();
  });

  it('fires title regeneration and renders its inline failure', () => {
    const onRegenerateTitle = vi.fn();
    render(
      <SessionConversationItem
        conversation={{
          id: 'c1',
          agentSlug: 'station',
          title: 'Old',
          updatedAt: '2026-08-13T00:00:00Z',
        }}
        isActive={false}
        hasActiveChat={false}
        isRenaming={false}
        newTitle=""
        inputRef={createRef<HTMLInputElement>()}
        onSelect={vi.fn()}
        onStartRename={vi.fn()}
        onRename={vi.fn()}
        onCancelRename={vi.fn()}
        onDelete={vi.fn()}
        onTitleChange={vi.fn()}
        onRegenerateTitle={onRegenerateTitle}
        actionError="Title generation failed"
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Regenerate conversation title' }),
    );
    expect(onRegenerateTitle).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert').textContent).toBe(
      'Title generation failed',
    );
  });

  it('copies the durable conversation id with confirmation', async () => {
    const writeText = clipboardWrites();
    renderItem(true, { id: 'conversation:debug-123' });

    fireEvent.click(screen.getByRole('button', { name: 'Copy thread ID' }));

    expect(writeText).toHaveBeenCalledWith('conversation:debug-123');
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy());
    expect(triggerHapticMock).toHaveBeenCalledWith('light');
    expect(screen.getByRole('status').textContent).toBe('Thread ID copied.');
  });

  // archive#3341: "Copied" and the haptic used to fire for a write that never
  // resolved — including the insecure-origin case where there is no clipboard.
  it('a refused write never claims a copy and never buzzes', async () => {
    clipboardRefuses();
    renderItem(true, { id: 'conversation:debug-123' });

    fireEvent.click(screen.getByRole('button', { name: 'Copy thread ID' }));

    await waitFor(() => expect(screen.getByText("Can't copy")).toBeTruthy());
    expect(screen.queryByText('Copied')).toBeNull();
    expect(triggerHapticMock).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain(
      'refused clipboard access',
    );
  });

  it('an insecure origin with no clipboard API never claims a copy', async () => {
    clipboardAbsent();
    renderItem(true, { id: 'conversation:debug-123' });

    fireEvent.click(screen.getByRole('button', { name: 'Copy thread ID' }));

    await waitFor(() => expect(screen.getByText("Can't copy")).toBeTruthy());
    expect(screen.queryByText('Copied')).toBeNull();
    expect(triggerHapticMock).not.toHaveBeenCalled();
  });

  it('MED-2: an ACP-type conversation with a resolved engine renders the engine name, never the literal "ACP"', () => {
    renderItem(true, {
      agentType: 'acp',
      agentEngine: { name: 'Kiro' },
    });

    expect(screen.getByText('Kiro')).toBeTruthy();
    expect(screen.queryByText('ACP')).toBeNull();
  });

  it('MED-2: an ACP-type conversation with no resolvable engine renders no pill at all', () => {
    renderItem(true, {
      agentType: 'acp',
      agentEngine: null,
    });

    expect(screen.queryByText('ACP')).toBeNull();
  });

  it('round-3: a persisted claude-bound agent conversation shows a "Claude Code" chip alongside its Global badge', () => {
    renderItem(true, {
      agentType: 'global',
      agentEngine: { name: 'Claude Code' },
    });

    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('Global')).toBeTruthy();
  });

  it('round-3: a Station agent conversation shows a "Station" chip alongside its Global badge', () => {
    renderItem(true, {
      agentType: 'global',
      agentEngine: { name: 'Station' },
    });

    expect(screen.getByText('Station')).toBeTruthy();
    expect(screen.getByText('Global')).toBeTruthy();
  });

  it('renders the owning Project identity when History supplies it', () => {
    render(
      <SessionConversationItem
        conversation={{
          id: 'thread-project',
          agentSlug: 'claude',
          projectSlug: 'alpha',
          title: 'Project conversation',
          updatedAt: '2026-08-11T00:00:00Z',
        }}
        projectLabel="Alpha Project"
        isActive={false}
        hasActiveChat={false}
        isRenaming={false}
        newTitle=""
        inputRef={createRef<HTMLInputElement>()}
        onSelect={vi.fn()}
        onStartRename={vi.fn()}
        onRename={vi.fn()}
        onCancelRename={vi.fn()}
        onDelete={vi.fn()}
        onTitleChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Alpha Project').classList).toContain(
      'session-item__badge--project',
    );
  });

  it('round-3: an agent whose engine cannot be honestly resolved renders no chip, but its Layout badge still renders', () => {
    renderItem(true, {
      agentType: 'layout',
      agentContext: 'my-workspace',
      agentEngine: null,
    });

    expect(screen.getByText('Layout')).toBeTruthy();
    expect(screen.queryByText('Station')).toBeNull();
    expect(screen.queryByText('Claude Code')).toBeNull();
  });

  it('keyboard-activating a control inside the row does not also open the row', () => {
    const onSelect = vi.fn();
    const onOpenForkSource = vi.fn();
    render(
      <SessionConversationItem
        conversation={{
          id: 'target',
          agentSlug: 'codex',
          title: 'Fork target',
          forkProvenance: {
            forkedFrom: {
              sourceConversationId: 'source',
              targetConversationId: 'target',
              targetAgent: 'codex',
              forkedAt: '2026-08-11T00:00:00Z',
            },
            forkedTo: [],
          },
          updatedAt: '2026-08-11T00:00:00Z',
        }}
        isActive={false}
        hasActiveChat={false}
        isRenaming={false}
        newTitle=""
        inputRef={createRef<HTMLInputElement>()}
        onSelect={onSelect}
        onStartRename={vi.fn()}
        onRename={vi.fn()}
        onCancelRename={vi.fn()}
        onDelete={vi.fn()}
        onOpenForkSource={onOpenForkSource}
        resolveConversationTitle={(id) => ({ source: 'Source title' })[id]}
        onTitleChange={vi.fn()}
      />,
    );

    // The provenance link is a child of the row's own role="button" surface,
    // so its keydown bubbles to the row. Activating it must not also select
    // the conversation.
    fireEvent.keyDown(
      screen.getByRole('button', { name: 'Forked from Source title' }),
      { key: 'Enter' },
    );
    expect(onSelect).not.toHaveBeenCalled();

    // Positive control: the row itself still activates from the keyboard.
    fireEvent.keyDown(
      screen.getByRole('button', { name: 'Open conversation Fork target' }),
      { key: 'Enter' },
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('renders fork provenance in both directions from the immutable fact fields', () => {
    const onOpenForkSource = vi.fn();
    render(
      <SessionConversationItem
        conversation={{
          id: 'target',
          agentSlug: 'codex',
          title: 'Fork target',
          updatedAt: '2026-08-11T00:00:00Z',
          forkProvenance: {
            forkedFrom: {
              sourceConversationId: 'source',
              targetConversationId: 'target',
              targetAgent: 'codex',
              forkedAt: '2026-08-11T00:00:00Z',
            },
            forkedTo: [
              {
                sourceConversationId: 'target',
                targetConversationId: 'child',
                targetAgent: 'claude',
                forkedAt: '2026-08-11T01:00:00Z',
              },
            ],
          },
        }}
        isActive={false}
        hasActiveChat={false}
        isRenaming={false}
        newTitle=""
        inputRef={createRef<HTMLInputElement>()}
        onSelect={vi.fn()}
        onStartRename={vi.fn()}
        onRename={vi.fn()}
        onCancelRename={vi.fn()}
        onDelete={vi.fn()}
        onOpenForkSource={onOpenForkSource}
        resolveConversationTitle={(id) =>
          ({ source: 'Source title', child: 'Child title' })[id]
        }
        onTitleChange={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Forked from Source title' }),
    );
    expect(onOpenForkSource).toHaveBeenCalledWith('source');
    expect(
      screen.getByText('Agent: codex · 2026-08-11T00:00:00Z'),
    ).toBeTruthy();
    expect(
      screen.getByText('Child title · Agent: claude · 2026-08-11T01:00:00Z'),
    ).toBeTruthy();
  });

  it('renders no fork provenance when the read model has none', () => {
    renderItem();

    expect(screen.queryByText(/Forked from/)).toBeNull();
    expect(screen.queryByText('Forked to')).toBeNull();
  });

  it('renders unresolved fork references as honest non-interactive fallbacks', () => {
    render(
      <SessionConversationItem
        conversation={{
          id: 'source',
          agentSlug: 'station',
          updatedAt: '2026-08-11T00:00:00Z',
          forkProvenance: {
            forkedFrom: {
              sourceConversationId: 'missing-parent',
              targetConversationId: 'source',
              targetAgent: 'station',
              forkedAt: '2026-08-11T00:00:00Z',
            },
            forkedTo: [
              {
                sourceConversationId: 'source',
                targetConversationId: 'missing-child',
                targetAgent: 'codex',
                forkedAt: '2026-08-11T01:00:00Z',
              },
            ],
          },
        }}
        isActive={false}
        hasActiveChat={false}
        isRenaming={false}
        newTitle=""
        inputRef={createRef<HTMLInputElement>()}
        onSelect={vi.fn()}
        onStartRename={vi.fn()}
        onRename={vi.fn()}
        onCancelRename={vi.fn()}
        onDelete={vi.fn()}
        onOpenForkSource={vi.fn()}
        resolveConversationTitle={() => undefined}
        onTitleChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Forked from earlier conversation (unavailable)'),
    ).toBeTruthy();
    expect(screen.getByText(/Forked to/).parentElement?.textContent).toContain(
      'earlier conversation (unavailable)',
    );
    expect(screen.queryByRole('button', { name: /Forked from/ })).toBeNull();
  });
});
