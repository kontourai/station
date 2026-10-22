// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import type {
  KnowledgeDocumentImportReceipt,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectDocumentImport } from '../ProjectDocumentImport';

const state = vi.hoisted(() => ({
  upload: vi.fn(),
  resume: vi.fn(),
  refetch: vi.fn(),
  data: undefined as KnowledgeDocumentImportReceipt | undefined,
  error: false,
  fetching: false,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useImportKnowledgeDocumentsMutation: () => ({ mutateAsync: state.upload }),
  useResumeKnowledgeDocumentImportMutation: () => ({
    mutateAsync: state.resume,
  }),
  useKnowledgeDocumentImportQuery: () => ({
    data: state.data,
    isError: state.error,
    isFetching: state.fetching,
    refetch: state.refetch,
  }),
}));
const authority = { apiBase: 'http://station.test', authorityKey: 'person-a' };
const root: KnowledgeStoreRoot = {
  id: 'root:research',
  scope: { kind: 'project', projectSlug: 'research' },
  projectId: 'project-research',
  registrationId: '11111111-1111-4111-8111-111111111111',
  adapterId: 'kit-default-store',
  storeRoot: '/test/store',
  displayName: 'Research',
  createdAt: '2026-10-22T00:00:00Z',
};
const key = `station.document-import:${JSON.stringify([authority.apiBase, authority.authorityKey, root.projectId])}`;
const props = {
  projectId: root.projectId!,
  roots: [root],
  authority,
  canManage: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.data = undefined;
  state.error = state.fetching = false;
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function file(text: string, name = 'research.md') {
  const bytes = new TextEncoder().encode(text);
  const file = new File([text], name, { type: 'text/markdown' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => bytes.buffer,
  });
  return file;
}
function saved() {
  localStorage.setItem(
    key,
    JSON.stringify({
      requestId: '22222222-2222-4222-8222-222222222222',
      rootId: root.id,
      registrationId: root.registrationId,
      files: [{ filename: 'research.md', sha256: 'a'.repeat(64) }],
    }),
  );
  state.data = {
    requestId: '22222222-2222-4222-8222-222222222222',
    rootId: root.id,
    registrationId: root.registrationId!,
    phase: 'uncertain',
    documents: [
      {
        filename: 'research.md',
        bytes: 10,
        sha256: 'a'.repeat(64),
        recordId: 'document-saved-0',
        phase: 'uncertain',
        originalAvailable: true,
      },
    ],
  };
}

test('preview precedes upload and lost acknowledgement retains only a recovery pointer without automatic resend', async () => {
  state.upload.mockImplementation(async () => {
    expect(localStorage.getItem(key)).toContain('requestId');
    throw new Error('Connection lost');
  });
  const view = render(<ProjectDocumentImport {...props} />);
  fireEvent.change(screen.getByLabelText('Destination store'), {
    target: { value: root.id },
  });
  const text = '\ufeff\nOriginal confidential source\r\n';
  fireEvent.change(screen.getByLabelText('Documents'), {
    target: { files: [file(text)] },
  });
  await screen.findByText(/SHA-256:/);
  expect(state.upload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Import 1 documents' }));
  await screen.findByText('Connection lost');
  expect(state.upload).toHaveBeenCalledTimes(1);
  expect(state.upload.mock.calls[0]?.[0]).toMatchObject({
    expectedRoot: root,
    documents: [
      {
        filename: 'research.md',
        contentBase64: Buffer.from(text).toString('base64'),
      },
    ],
  });
  const retained = localStorage.getItem(key)!;
  expect(retained).not.toContain('Original confidential');
  expect(retained).not.toContain('contentBase64');
  view.unmount();
  render(<ProjectDocumentImport {...props} />);
  expect(screen.getByText(/Saved import:/)).toBeTruthy();
  expect(state.upload).toHaveBeenCalledTimes(1);
  expect(state.resume).not.toHaveBeenCalled();
});

test('uncertain retry needs explicit confirmation and cannot dispatch after permission loss', async () => {
  saved();
  const view = render(<ProjectDocumentImport {...props} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Review uncertain retry' }),
  );
  expect(state.resume).not.toHaveBeenCalled();
  view.rerender(<ProjectDocumentImport {...props} canManage={false} />);
  const confirm = screen.getByRole('button', {
    name: 'Retry missing documents',
  });
  expect(confirm.hasAttribute('disabled')).toBe(true);
  fireEvent.click(confirm);
  expect(state.resume).not.toHaveBeenCalled();
  view.rerender(<ProjectDocumentImport {...props} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry missing documents' }),
  );
  await waitFor(() =>
    expect(state.resume).toHaveBeenCalledWith({
      expectedRoot: root,
      requestId: state.data!.requestId,
      retryUncertain: true,
    }),
  );
});

test('replacement registration cannot resume and setting aside preserves server records', () => {
  saved();
  render(
    <ProjectDocumentImport
      {...props}
      roots={[
        { ...root, registrationId: '33333333-3333-4333-8333-333333333333' },
      ]}
    />,
  );
  expect(
    screen
      .getByRole('button', { name: 'Review uncertain retry' })
      .hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Set aside' }));
  expect(localStorage.getItem(key)).toBeNull();
  expect(state.upload).not.toHaveBeenCalled();
  expect(state.resume).not.toHaveBeenCalled();
});
