/**
 * @vitest-environment jsdom
 *
 * station#2693: the agent editor's Tools tab points at the workflow
 * management UI, not at a CLI command. The SDK hooks are context-mocked
 * here; what this file proves is the SECTION's behavior — open, edit,
 * dirty-guarded transitions, create, delete — against the hook contracts
 * (`packages/sdk/src/query-domains/workspaceWorkflows.ts`), which carry
 * their own tests.
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { AgentEditorWorkflows } from '../views/agent-editor/AgentEditorWorkflows';

const WORKFLOWS = [
  { id: 'triage.ts', label: 'Triage', lastModified: '2026-09-24T00:00:00Z' },
  {
    id: 'summarize.ts',
    label: 'Summarize',
    lastModified: '2026-09-23T00:00:00Z',
  },
];
const CONTENTS: Record<string, string> = {
  'triage.ts': 'export const steps = ["triage"];',
  'summarize.ts': 'export const steps = ["summarize"];',
};

const updateMutate = vi.fn();
const createMutate = vi.fn();
const deleteMutate = vi.fn();
const updateSucceeds = true;
let createSucceeds = true;
const deleteSucceeds = true;

vi.mock('@kontourai/station-sdk', () => ({
  useAgentWorkflowsQuery: (slug: string | undefined) => ({
    data: slug ? WORKFLOWS : undefined,
    isLoading: false,
    error: null,
  }),
  useWorkflowContentQuery: (_slug: string | undefined, id: string | null) => ({
    data: id ? CONTENTS[id] : undefined,
    isLoading: false,
    error: null,
  }),
  useUpdateWorkflowMutation: (
    _slug: string,
    options?: {
      onSuccess?: (d: undefined, v: unknown) => void;
      onError?: (e: Error) => void;
    },
  ) => ({
    mutate: (variables: unknown) => {
      updateMutate(variables);
      if (updateSucceeds) options?.onSuccess?.(undefined, variables);
      else options?.onError?.(new Error('refused'));
    },
    isPending: false,
  }),
  useCreateWorkflowMutation: (
    _slug: string,
    options?: {
      onSuccess?: (d: undefined, v: unknown) => void;
      onError?: (e: Error) => void;
    },
  ) => ({
    mutate: (variables: unknown) => {
      createMutate(variables);
      if (createSucceeds) options?.onSuccess?.(undefined, variables);
      else options?.onError?.(new Error('refused'));
    },
    isPending: false,
  }),
  useDeleteWorkflowMutation: (
    _slug: string,
    options?: {
      onSuccess?: (d: void, v: string) => void;
      onError?: (e: Error) => void;
    },
  ) => ({
    mutate: (workflowId: string) => {
      deleteMutate(workflowId);
      if (deleteSucceeds) options?.onSuccess?.(undefined, workflowId);
      else options?.onError?.(new Error('refused'));
    },
    isPending: false,
  }),
}));

function renderSection(slug = 'writer', locked = false) {
  return render(<AgentEditorWorkflows slug={slug} locked={locked} />);
}

describe('AgentEditorWorkflows', () => {
  test('lists the agent workflow files with their ids', () => {
    renderSection();
    expect(screen.getByText('Triage')).toBeTruthy();
    expect(screen.getByText('Summarize')).toBeTruthy();
    expect(screen.getByText('triage.ts')).toBeTruthy();
  });

  test('an unsaved agent offers no list and says what it needs', () => {
    renderSection('');
    expect(screen.queryByText('Triage')).toBeNull();
    expect(
      screen.getByText(/Save the agent to manage its workflow files/),
    ).toBeTruthy();
  });

  test('opening a workflow loads its content into an editable field', () => {
    renderSection();
    fireEvent.click(screen.getByText('Triage'));
    const textarea = screen.getByLabelText('Content') as HTMLTextAreaElement;
    expect(textarea.value).toBe(CONTENTS['triage.ts']);
  });

  test('edits enable Save and a save sends the drafted content', async () => {
    renderSection();
    fireEvent.click(screen.getByText('Triage'));
    const textarea = screen.getByLabelText('Content');
    const save = screen.getByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(textarea, {
      target: { value: 'export const steps = ["edited"];' },
    });
    expect(
      (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({
        workflowId: 'triage.ts',
        content: 'export const steps = ["edited"];',
      }),
    );
    // A completed save leaves the section clean: the dirty baseline moved to
    // the saved content, so Save disables again and no later transition is
    // nagged with the discard prompt.
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
  });

  test('a dirty edit switching workflows asks before discarding', () => {
    renderSection();
    fireEvent.click(screen.getByText('Triage'));
    fireEvent.change(screen.getByLabelText('Content'), {
      target: { value: 'export const steps = ["edited"];' },
    });
    fireEvent.click(screen.getByText('Summarize'));
    expect(screen.getByText('Unsaved Changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    // The discard completed the switch: the other file's content is showing.
    expect(
      (screen.getByLabelText('Content') as HTMLTextAreaElement).value,
    ).toBe(CONTENTS['summarize.ts']);
  });

  test('a clean selection switch asks nothing', () => {
    renderSection();
    fireEvent.click(screen.getByText('Triage'));
    fireEvent.click(screen.getByText('Summarize'));
    expect(screen.queryByText('Unsaved Changes')).toBeNull();
    expect(
      (screen.getByLabelText('Content') as HTMLTextAreaElement).value,
    ).toBe(CONTENTS['summarize.ts']);
  });

  test('create sends the trimmed filename and content and opens the new file', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: '+ Add workflow' }));
    fireEvent.change(screen.getByLabelText('Filename'), {
      target: { value: ' draft.ts ' },
    });
    fireEvent.change(screen.getByLabelText('Content'), {
      target: { value: 'export const steps = [];' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create workflow' }));
    expect(createMutate).toHaveBeenCalledWith({
      filename: 'draft.ts',
      content: 'export const steps = [];',
    });
    // The created file is opened for editing.
    expect(
      (screen.getByLabelText('Content') as HTMLTextAreaElement).value,
    ).toBe('export const steps = [];');
  });

  test('delete asks, then sends the workflow id', () => {
    renderSection();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    expect(screen.getByText('Delete workflow?')).toBeTruthy();
    // The Dialog portals outside the ConfirmModal wrapper, and its confirm
    // shares the row buttons' "Delete" name — scope by the dialog itself.
    const dialog = screen
      .getAllByRole('dialog')
      .find((candidate) => candidate.textContent?.includes('Delete workflow?'));
    if (!dialog) throw new Error('the confirm dialog did not mount');
    fireEvent.click(
      within(dialog as HTMLElement).getByRole('button', { name: 'Delete' }),
    );
    expect(deleteMutate).toHaveBeenCalledWith('triage.ts');
  });

  test('a server refusal surfaces verbatim', () => {
    createSucceeds = false;
    try {
      renderSection();
      fireEvent.click(screen.getByRole('button', { name: '+ Add workflow' }));
      fireEvent.change(screen.getByLabelText('Filename'), {
        target: { value: 'draft.ts' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create workflow' }));
      expect(screen.getByRole('alert').textContent).toBe('refused');
    } finally {
      createSucceeds = true;
    }
  });
});
