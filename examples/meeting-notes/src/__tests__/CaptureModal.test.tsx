/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CaptureModal } from '../CaptureModal';

const invokeAgentMock = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  isRelevantKnowledgeRoot: (
    root: { scope: { kind: string; projectSlug?: string } },
    project: string | null,
  ) => root.scope.kind === 'personal' || root.scope.projectSlug === project,
  useApiBase: () => ({ apiBase: 'http://localhost:3141' }),
  useNavigation: () => ({ selectedProject: null }),
  useKnowledgeRootsQuery: () => ({
    isLoading: false,
    isError: false,
    data: [
      {
        id: 'root:personal',
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot: '/tmp/personal',
        displayName: 'Personal (default store)',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  }),
  invokeAgent: (...args: unknown[]) => invokeAgentMock(...args),
  // Explicitly absent, matching the real, verified SDK gap this plugin
  // defends against (see CaptureModal.tsx's module doc) — vitest's mock
  // proxy requires every accessed key to be present (even as undefined).
  useSTT: undefined,
}));

const createKnowledgeRecordMock = vi.fn();
vi.mock('@kontourai/station-sdk/client', () => ({
  createKnowledgeRecord: (...args: unknown[]) =>
    createKnowledgeRecordMock(...args),
  getKnowledgeRecord: vi.fn(),
}));

function renderCaptureModal() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CaptureModal />
    </QueryClientProvider>,
  );
}

describe('CaptureModal', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('Save transcript is disabled until a root and transcript are present', () => {
    renderCaptureModal();
    const saveButton = screen.getByTestId(
      'mn-save-transcript',
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  test('captures a raw record, then compiles a linked record with provenance', async () => {
    createKnowledgeRecordMock
      .mockResolvedValueOnce({ id: 'rec_raw_1' })
      .mockResolvedValueOnce({ id: 'rec_compiled_1' });
    invokeAgentMock.mockResolvedValue({
      success: true,
      response: {
        title: 'Weekly sync',
        summary: 'Discussed roadmap.',
        actionItems: ['Ship K5'],
      },
    });

    renderCaptureModal();

    fireEvent.change(screen.getByTestId('mn-root-select'), {
      target: { value: 'root:personal' },
    });
    fireEvent.change(screen.getByTestId('mn-transcript'), {
      target: { value: 'Alice: hi\nBob: hi' },
    });

    const saveButton = screen.getByTestId(
      'mn-save-transcript',
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(screen.getByTestId('mn-raw-record').textContent).toContain(
        'rec_raw_1',
      ),
    );
    expect(createKnowledgeRecordMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3141',
      'root:personal',
      expect.objectContaining({
        type: 'raw',
        body: 'Alice: hi\nBob: hi',
        provenance: { agent: 'station.meeting-notes.capture' },
      }),
    );

    const compileButton = screen.getByTestId('mn-compile') as HTMLButtonElement;
    expect(compileButton.disabled).toBe(false);
    fireEvent.click(compileButton);

    await waitFor(() =>
      expect(screen.getByTestId('mn-compiled-record').textContent).toContain(
        'rec_compiled_1',
      ),
    );
    expect(invokeAgentMock).toHaveBeenCalledWith(
      'compile',
      expect.stringContaining('Alice: hi\nBob: hi'),
      expect.objectContaining({ schema: expect.any(Object) }),
    );
    expect(createKnowledgeRecordMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3141',
      'root:personal',
      expect.objectContaining({
        type: 'compiled',
        title: 'Weekly sync',
        links: [{ target_id: 'rec_raw_1', kind: 'source' }],
        provenance: {
          agent: 'station.meeting-notes.compile',
          source_ids: ['rec_raw_1'],
        },
      }),
    );
  });

  test('surfaces a compile error via the notice region without crashing', async () => {
    createKnowledgeRecordMock.mockResolvedValueOnce({ id: 'rec_raw_2' });
    invokeAgentMock.mockRejectedValue(new Error('model unavailable'));

    renderCaptureModal();

    fireEvent.change(screen.getByTestId('mn-root-select'), {
      target: { value: 'root:personal' },
    });
    fireEvent.change(screen.getByTestId('mn-transcript'), {
      target: { value: 'Alice: hi' },
    });
    fireEvent.click(screen.getByTestId('mn-save-transcript'));

    await waitFor(() => screen.getByTestId('mn-raw-record'));
    fireEvent.click(screen.getByTestId('mn-compile'));

    await waitFor(() =>
      expect(screen.getByTestId('mn-notice').textContent).toContain(
        'model unavailable',
      ),
    );
    expect(screen.queryByTestId('mn-compiled-record')).toBeNull();
  });
});
