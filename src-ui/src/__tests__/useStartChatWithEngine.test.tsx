/**
 * @vitest-environment jsdom
 *
 * "Start a chat with <engine>" after Ready. New chat selects only an Agent
 * its lists already hold, and a just-made Agent (and its engine) reaches them
 * after the write answers, so the request waits for both rather than opening
 * New chat on "Your previous Agent is no longer available" (seen live).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OPEN_NEW_CHAT_EVENT } from '../lib/newChatIntent';

const state = vi.hoisted(() => ({
  agents: [] as Array<{ slug: string }>,
  pickerConnections: [] as Array<{ id: string }>,
  dockProject: null as string | null,
  materialize: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useMaterializeEngineAgentMutation: () => ({
    mutateAsync: state.materialize,
  }),
  useModelPickerCatalogQuery: () => ({
    data: { agentConnections: state.pickerConnections },
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => state.agents,
}));
vi.mock('../workspace-panes/useDockProject', () => ({
  useDockProject: () => ({
    projectSlug: state.dockProject,
    projectId: null,
    pending: false,
  }),
}));

import { useStartChatWithEngine } from '../components/acp-connections/useStartChatWithEngine';

let intents: unknown[] = [];
function listen(event: Event) {
  event.preventDefault();
  intents.push((event as CustomEvent).detail);
}

beforeEach(() => {
  intents = [];
  state.agents = [];
  state.pickerConnections = [];
  state.dockProject = null;
  state.materialize.mockReset();
  state.invalidate.mockReset();
  window.addEventListener(OPEN_NEW_CHAT_EVENT, listen);
});
afterEach(() => {
  window.removeEventListener(OPEN_NEW_CHAT_EVENT, listen);
  vi.useRealTimers();
});

describe('starting a chat with a just-connected engine', () => {
  test('waits until New chat can list the Agent, then opens it in the dock project', async () => {
    state.dockProject = 'lab-project';
    state.materialize.mockResolvedValue({
      data: { slug: 'lab', name: 'Lab Engine' },
      created: false,
    });
    const view = renderHook(() => useStartChatWithEngine());

    await act(() => view.result.current.start('lab', 'Lab Engine'));
    expect(state.materialize).toHaveBeenCalledWith('lab');
    expect(view.result.current.pending).toBe(true);

    // The Agent alone is not enough: its engine must be listed too.
    state.agents = [{ slug: 'lab' }];
    view.rerender();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(intents).toEqual([]);

    state.pickerConnections = [{ id: 'lab' }];
    view.rerender();
    await waitFor(() =>
      expect(intents).toEqual([
        { selection: { context: 'lab-project', agentSlug: 'lab' } },
      ]),
    );
    expect(view.result.current.pending).toBe(false);
    expect(view.result.current.notice).toBeNull();
  });

  test('without a dock project the chat opens without one; a Project-owned Agent opens in its Project', async () => {
    state.agents = [{ slug: 'lab' }, { slug: 'owned' }];
    state.pickerConnections = [{ id: 'lab' }, { id: 'owned' }];
    state.materialize.mockResolvedValueOnce({ data: { slug: 'lab' } });
    const view = renderHook(() => useStartChatWithEngine());
    await act(() => view.result.current.start('lab', 'Lab Engine'));
    await waitFor(() => expect(intents).toHaveLength(1));
    expect(intents[0]).toEqual({
      selection: { context: '__global__', agentSlug: 'lab' },
    });

    state.materialize.mockResolvedValueOnce({
      data: { slug: 'owned', project: 'other' },
    });
    await act(() => view.result.current.start('owned', 'Owned Engine'));
    await waitFor(() => expect(intents).toHaveLength(2));
    expect(intents[1]).toEqual({
      selection: { context: 'other', agentSlug: 'owned' },
    });
  });

  test('stops waiting after its bound and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.materialize.mockResolvedValue({ data: { slug: 'slow' } });
    const view = renderHook(() => useStartChatWithEngine());
    await act(() => view.result.current.start('slow', 'Slow Engine'));
    await act(async () => {
      vi.advanceTimersByTime(15_001);
    });
    expect(intents).toEqual([]);
    expect(view.result.current.pending).toBe(false);
    expect(view.result.current.notice).toBe(
      "Slow Engine's Agent is still starting. Try again in a moment.",
    );
    // It re-read both lists while it waited.
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ['agents'] });
    expect(state.invalidate).toHaveBeenCalledWith({
      queryKey: ['model-picker-catalog'],
    });
  });

  test('a failed find-or-create is said, and opens nothing', async () => {
    state.materialize.mockRejectedValue(new Error('engine not found'));
    const view = renderHook(() => useStartChatWithEngine());
    await act(() => view.result.current.start('gone', 'Gone Engine'));
    expect(view.result.current.notice).toContain(
      'Could not start a chat with Gone Engine',
    );
    expect(intents).toEqual([]);
  });
});
