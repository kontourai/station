/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
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
      {
        id: 'root:other',
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot: '/tmp/other',
        displayName: 'Other store',
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
    vi.resetAllMocks();
  });

  test('Save transcript is disabled until a root and transcript are present', () => {
    renderCaptureModal();
    const saveButton = screen.getByTestId(
      'mn-save-transcript',
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('mn-transcript'), {
      target: { value: 'Alice: hi' },
    });
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('mn-root-select'), {
      target: { value: 'root:personal' },
    });
    expect(saveButton.disabled).toBe(false);

    fireEvent.change(screen.getByTestId('mn-transcript'), {
      target: { value: '   ' },
    });
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

  test.each(['transcript', 'root'] as const)(
    'a late save cannot authorize compilation after changing the %s',
    async (changed) => {
      let completeSave!: (record: { id: string }) => void;
      createKnowledgeRecordMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeSave = resolve;
          }),
      );
      renderCaptureModal();
      fireEvent.change(screen.getByLabelText('Knowledge root'), {
        target: { value: 'root:personal' },
      });
      fireEvent.change(screen.getByLabelText('Transcript'), {
        target: { value: 'Original transcript' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save transcript' }));
      await waitFor(() =>
        expect(createKnowledgeRecordMock).toHaveBeenCalledOnce(),
      );

      fireEvent.change(
        screen.getByLabelText(
          changed === 'root' ? 'Knowledge root' : 'Transcript',
        ),
        {
          target: {
            value: changed === 'root' ? 'root:other' : 'Edited transcript',
          },
        },
      );
      await act(async () => {
        completeSave({ id: 'raw-original' });
      });
      await waitFor(() =>
        expect(
          screen
            .getByRole('button', { name: 'Save transcript' })
            .hasAttribute('disabled'),
        ).toBe(false),
      );

      expect(
        (screen.getByLabelText('Transcript') as HTMLTextAreaElement).value,
      ).toBe(changed === 'root' ? 'Original transcript' : 'Edited transcript');
      expect(
        (screen.getByLabelText('Knowledge root') as HTMLSelectElement).value,
      ).toBe(changed === 'root' ? 'root:other' : 'root:personal');
      expect(
        screen
          .getByRole('button', { name: 'Compile' })
          .hasAttribute('disabled'),
      ).toBe(true);
      expect(screen.queryByTestId('mn-raw-record')).toBeNull();
      expect(screen.queryByText(/Saved raw transcript/)).toBeNull();
    },
  );

  test('a completed compile keeps its submitted source without relabeling an edited draft', async () => {
    let completeCompile!: (value: unknown) => void;
    createKnowledgeRecordMock
      .mockResolvedValueOnce({ id: 'raw-original' })
      .mockResolvedValueOnce({ id: 'compiled-original' });
    invokeAgentMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeCompile = resolve;
        }),
    );
    renderCaptureModal();
    fireEvent.change(screen.getByLabelText('Knowledge root'), {
      target: { value: 'root:personal' },
    });
    fireEvent.change(screen.getByLabelText('Transcript'), {
      target: { value: 'Original transcript' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save transcript' }));
    await screen.findByTestId('mn-raw-record');
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    await waitFor(() => expect(invokeAgentMock).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText('Transcript'), {
      target: { value: 'New draft' },
    });
    await act(async () => {
      completeCompile({
        success: true,
        response: {
          title: 'Note',
          summary: 'Original summary',
          actionItems: [],
        },
      });
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Compiling…' })).toBeNull(),
    );

    expect(createKnowledgeRecordMock).toHaveBeenLastCalledWith(
      'http://localhost:3141',
      'root:personal',
      expect.objectContaining({
        links: [{ target_id: 'raw-original', kind: 'source' }],
      }),
    );
    expect(
      (screen.getByLabelText('Transcript') as HTMLTextAreaElement).value,
    ).toBe('New draft');
    expect(screen.queryByTestId('mn-compiled-record')).toBeNull();
    expect(screen.queryByText(/Compiled note compiled-original/)).toBeNull();
  });

  test('an unreadable upload reports failure and preserves the typed transcript', async () => {
    renderCaptureModal();
    fireEvent.change(screen.getByLabelText('Transcript'), {
      target: { value: 'Keep this draft' },
    });
    const file = new File(['unreadable'], 'meeting.txt', {
      type: 'text/plain',
    });
    Object.defineProperty(file, 'text', {
      value: vi
        .fn()
        .mockRejectedValueOnce(new Error('read refused'))
        .mockResolvedValueOnce('Recovered transcript'),
    });
    fireEvent.change(screen.getByTestId('mn-transcript-upload'), {
      target: { files: [file] },
    });
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Could not read transcript'),
    );
    expect(
      (screen.getByLabelText('Transcript') as HTMLTextAreaElement).value,
    ).toBe('Keep this draft');
    expect(
      (screen.getByLabelText('Upload transcript') as HTMLInputElement).value,
    ).toBe('');
    fireEvent.change(screen.getByLabelText('Upload transcript'), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Transcript') as HTMLTextAreaElement).value,
      ).toBe('Recovered transcript'),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('meeting.txt');
    expect(screen.getByRole('status').textContent).toContain(
      'Review the transcript before saving.',
    );

    let finishOlderRead!: (text: string) => void;
    const olderFile = new File(['older'], 'older.txt', { type: 'text/plain' });
    Object.defineProperty(olderFile, 'text', {
      value: () =>
        new Promise<string>((resolve) => {
          finishOlderRead = resolve;
        }),
    });
    fireEvent.change(screen.getByLabelText('Upload transcript'), {
      target: { files: [olderFile] },
    });
    fireEvent.change(screen.getByLabelText('Transcript'), {
      target: { value: 'Newer draft' },
    });
    const currentFile = new File(['current'], 'current.txt', {
      type: 'text/plain',
    });
    Object.defineProperty(currentFile, 'text', {
      value: () => Promise.resolve('Current uploaded draft'),
    });
    fireEvent.change(screen.getByLabelText('Upload transcript'), {
      target: { files: [currentFile] },
    });
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('current.txt'),
    );
    await act(async () => finishOlderRead('Stale uploaded draft'));
    expect(
      (screen.getByLabelText('Transcript') as HTMLTextAreaElement).value,
    ).toBe('Current uploaded draft');
    expect(screen.getByRole('status').textContent).toContain('current.txt');
    expect(screen.getByRole('status').textContent).not.toContain('older.txt');
  });

  test('a compiled note still displays its submitted source after the same draft is saved again', async () => {
    let completeCompile!: (value: unknown) => void;
    createKnowledgeRecordMock
      .mockResolvedValueOnce({ id: 'raw-original' })
      .mockResolvedValueOnce({ id: 'raw-second-save' })
      .mockResolvedValueOnce({ id: 'compiled-original' });
    invokeAgentMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeCompile = resolve;
        }),
    );
    renderCaptureModal();
    fireEvent.change(screen.getByLabelText('Knowledge root'), {
      target: { value: 'root:personal' },
    });
    fireEvent.change(screen.getByLabelText('Transcript'), {
      target: { value: 'Original transcript' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save transcript' }));
    await screen.findByTestId('mn-raw-record');
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    await waitFor(() => expect(invokeAgentMock).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Save transcript' }));
    await waitFor(() =>
      expect(screen.getByTestId('mn-raw-record').textContent).toContain(
        'raw-second-save',
      ),
    );
    await act(async () => {
      completeCompile({
        success: true,
        response: { title: 'Note', summary: 'Summary', actionItems: [] },
      });
    });
    const compiled = await screen.findByTestId('mn-compiled-record');
    expect(compiled.textContent).toContain('raw-original');
    expect(compiled.textContent).not.toContain('raw-second-save');
    expect(createKnowledgeRecordMock).toHaveBeenLastCalledWith(
      'http://localhost:3141',
      'root:personal',
      expect.objectContaining({
        links: [{ target_id: 'raw-original', kind: 'source' }],
      }),
    );
  });
});
