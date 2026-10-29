// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectKnowledgeSources } from '../ProjectKnowledgeSources';

const state = vi.hoisted(() => ({ upload: vi.fn() }));
const root = {
  id: 'root:acme',
  registrationId: '11111111-1111-4111-8111-111111111111',
  projectId: 'project-acme',
  scope: { kind: 'project' as const, projectSlug: 'acme' },
  adapterId: 'kit-default-store',
  displayName: 'Notes',
  storeRoot: '/host/notes',
  createdAt: '2026-10-22T00:00:00Z',
};
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useImportKnowledgeDocumentsMutation: () => ({ mutateAsync: state.upload }),
  useResumeKnowledgeDocumentImportMutation: () => ({ mutateAsync: vi.fn() }),
  useKnowledgeDocumentImportQuery: () => ({ refetch: vi.fn() }),
  useKnowledgeSourceCapabilitiesQuery: () => ({
    data: { canManageSources: true },
  }),
  useKnowledgeAdaptersQuery: () => ({ data: [] }),
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  setClientCredentialResolver(() => ({
    origin: authority.apiBase,
    requestAuthority: { ...authority, isCurrent: () => true },
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url !== `${authority.apiBase}/api/knowledge/roots`)
        throw new Error(`Unexpected fixture request: ${url}`);
      return new Response(JSON.stringify({ success: true, data: [root] }));
    }),
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
const authority = {
  apiBase: 'http://station.test',
  authorityKey: 'a',
  draftRecoveryKey: 'stable-account',
};

async function prepareImport() {
  fireEvent.change(screen.getByLabelText('Destination store'), {
    target: { value: root.id },
  });
  const text = 'Unsubmitted confidential document';
  const file = new File([text], 'draft.md', { type: 'text/markdown' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode(text).buffer,
  });
  fireEvent.change(screen.getByLabelText('Documents'), {
    target: { files: [file] },
  });
  await screen.findByText(/SHA-256:/);
  return text;
}

test('a failed source refetch with retained query data preserves the preview and destination until an explicit import after recovery', async () => {
  setClientCredentialResolver(() => ({
    origin: authority.apiBase,
    requestAuthority: { ...authority, isCurrent: () => true },
  }));
  let failRoots = false;
  let failRead: (() => void) | undefined;
  const fetch = vi.fn(async (url: string) => {
    if (url !== `${authority.apiBase}/api/knowledge/roots`)
      throw new Error(`Unexpected fixture request: ${url}`);
    if (failRoots)
      return new Promise<Response>((resolve) => {
        failRead = () => resolve(new Response('Unavailable', { status: 503 }));
      });
    return new Response(JSON.stringify({ success: true, data: [root] }));
  });
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ProjectKnowledgeSources
        slug="acme"
        projectId="project-acme"
        authority={authority}
      />
    </QueryClientProvider>,
  );
  try {
    await screen.findByLabelText('Destination store');
    const text = await prepareImport();
    failRoots = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh sources' }));
    await waitFor(() => expect(failRead).toBeTypeOf('function'));
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Import 1 documents' })
          .hasAttribute('disabled'),
      ).toBe(true),
    );
    await act(async () => failRead!());
    await screen.findByRole('button', { name: 'Retry sources' });
    expect(
      client.getQueryData([
        'knowledge',
        'roots',
        authority.apiBase,
        authority.authorityKey,
      ]),
    ).toEqual([root]);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText(root.displayName)).toBeNull();
    expect(screen.queryByText(root.storeRoot)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    const submit = screen.getByRole('button', { name: 'Import 1 documents' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(submit);
    expect(state.upload).not.toHaveBeenCalled();
    expect(Object.values(localStorage).join('')).not.toContain(text);
    failRoots = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry sources' }));
    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false));
    expect(screen.getByLabelText('Destination store')).toHaveProperty(
      'value',
      root.id,
    );
    fireEvent.click(submit);
    await waitFor(() => expect(state.upload).toHaveBeenCalledTimes(1));
    expect(state.upload.mock.calls[0][0]).toMatchObject({
      expectedRoot: root,
      documents: [
        {
          filename: 'draft.md',
          contentBase64: Buffer.from(text).toString('base64'),
        },
      ],
    });
  } finally {
    view.unmount();
    client.clear();
  }
});

test.each([
  {
    label: 'live authority',
    authority: { ...authority, authorityKey: 'b' },
    projectId: 'project-acme',
  },
  {
    label: 'Station',
    authority: { ...authority, apiBase: 'http://other.test' },
    projectId: 'project-acme',
  },
  { label: 'Project', authority, projectId: 'project-other' },
])('a changed $label retires an unsubmitted importer draft', async (next) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = render(
    <ProjectKnowledgeSources
      slug="acme"
      projectId="project-acme"
      authority={authority}
    />,
    { wrapper },
  );
  await screen.findByLabelText('Destination store');
  const text = await prepareImport();
  view.rerender(
    <ProjectKnowledgeSources
      slug="acme"
      projectId={next.projectId}
      authority={next.authority}
    />,
  );
  expect(screen.queryByText(text)).toBeNull();
  expect(screen.queryByText(/SHA-256:/)).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Import 1 documents' }),
  ).toBeNull();
  expect(state.upload).not.toHaveBeenCalled();
  view.rerender(
    <ProjectKnowledgeSources
      slug="acme"
      projectId="project-acme"
      authority={authority}
    />,
  );
  await screen.findByLabelText('Destination store');
  expect(screen.getByLabelText('Destination store')).toHaveProperty(
    'value',
    '',
  );
  expect(screen.queryByText(text)).toBeNull();
});
