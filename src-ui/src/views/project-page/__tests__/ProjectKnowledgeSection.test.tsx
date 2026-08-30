// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let rulesSearchData: unknown;
let rulesLoading = false;
let rulesError = false;
let rulesFailure: unknown;
const refetchRules = vi.fn();
const uploadKnowledge = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useKnowledgeSearchQuery: () => ({
    data: rulesSearchData,
    isLoading: rulesLoading,
    isError: rulesError,
    error: rulesFailure,
    refetch: refetchRules,
  }),
  useKnowledgeDocContentQuery: () => ({ data: undefined, isLoading: false }),
  useKnowledgeDeleteMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useKnowledgeBulkDeleteMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useKnowledgeScanMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
  uploadKnowledge,
}));

// Scoped to the container→RulesEditor wiring under test: the namespace
// config panel pulls in PathAutocomplete's own filesystem-browse query,
// which is unrelated to what this file verifies.
vi.mock('../ProjectKnowledgeNamespaceConfig', () => ({
  ProjectKnowledgeNamespaceConfig: () => null,
}));

import { ProjectKnowledgeSection } from '../ProjectKnowledgeSection';

function renderSection(
  props: Partial<React.ComponentProps<typeof ProjectKnowledgeSection>> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProjectKnowledgeSection
        apiBase="http://test.local"
        slug="demo"
        docs={[]}
        namespaces={[{ id: 'rules', label: 'Rules', behavior: 'inject' }]}
        {...props}
      />
    </QueryClientProvider>,
  );
}

/**
 * archive#771 (independent verifier finding): the presentational
 * `ProjectKnowledgeRulesEditor` test drives the error state through direct
 * props, and the only other importer of `ProjectKnowledgeSection` mocks it
 * to `<div/>` — nothing exercised the CONTAINER wiring that reads
 * `useKnowledgeSearchQuery`'s `isError`/`error` and threads them down as
 * `rulesError`/`rulesFailure`. A at those two prop lines
 * (rulesError={false}, rulesFailure={undefined}) came back green across
 * the whole corpus for exactly that reason.
 */
describe('ProjectKnowledgeSection — rules query error threading (#771)', () => {
  beforeEach(() => {
    rulesSearchData = undefined;
    rulesLoading = false;
    rulesError = false;
    rulesFailure = undefined;
    refetchRules.mockReset();
    uploadKnowledge.mockReset();
  });

  test('renders the rules editor error state, with the specific failure text, when the rules query errors with no cached data', () => {
    rulesError = true;
    rulesFailure = new Error('project rules unavailable');

    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Rules' }));

    expect(screen.getByText("Couldn't load project rules")).toBeTruthy();
    expect(screen.getByText('project rules unavailable')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchRules).toHaveBeenCalledTimes(1);
  });

  test('renders and retries a knowledge document list failure', () => {
    const onRetryDocs = vi.fn();
    renderSection({
      docsError: true,
      docsFailure: new Error('knowledge list unavailable'),
      onRetryDocs,
    });

    expect(screen.getByText("Couldn't load project knowledge")).toBeTruthy();
    expect(screen.getByText('knowledge list unavailable')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryDocs).toHaveBeenCalledTimes(1);
  });

  test('renders the specific error when an uploaded file fails', async () => {
    uploadKnowledge.mockRejectedValue(
      new Error('knowledge service unavailable'),
    );
    renderSection();

    const input = document.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'text', {
      value: () => Promise.resolve('hello'),
    });
    fireEvent.change(input!, {
      target: { files: [file] },
    });

    expect(await screen.findByText("Couldn't upload notes.md")).toBeTruthy();
    expect(
      screen.getByText('notes.md: knowledge service unavailable'),
    ).toBeTruthy();
    expect(
      screen
        .getByText('notes.md: knowledge service unavailable')
        .closest('[role="alert"]'),
    ).toBeTruthy();
  });
});
