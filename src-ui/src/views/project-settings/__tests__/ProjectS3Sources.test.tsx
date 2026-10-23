// @vitest-environment jsdom
import type {
  ProjectS3ObjectRead,
  ProjectS3Source,
} from '@kontourai/station-contracts/project';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ProjectS3Sources } from '../ProjectS3Sources';

const state = vi.hoisted(() => ({
  enabled: true,
  manage: true,
  capabilityError: false,
  capabilityFetching: false,
  sources: [] as ProjectS3Source[],
  attach: vi.fn(),
  disconnect: vi.fn(),
  refetch: vi.fn(),
  read: undefined as ProjectS3ObjectRead | undefined,
  readError: false,
  objectQuery: vi.fn(),
  sourcesQuery: vi.fn(),
  pageQuery: vi.fn(),
}));
const source: ProjectS3Source = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: 'project-a',
  displayName: 'Archive',
  accountId: '123456789012',
  region: 'us-west-2',
  bucket: 'fixture-archive',
  prefix: 'selected/',
  createdAt: '2026-10-22T00:00:00Z',
};
const authority = { apiBase: 'http://station.test', authorityKey: 'person-a' };
const props = { slug: 'research', projectId: 'project-a', authority };
vi.mock('@kontourai/station-sdk', () => ({
  useProjectS3CapabilitiesQuery: () => ({
    data: { enabled: state.enabled, canManage: state.manage },
    isError: state.capabilityError,
    isFetching: state.capabilityFetching,
  }),
  useProjectS3ProfilesQuery: () => ({
    data: { available: true, profiles: ['fixture-only'] },
  }),
  useProjectS3SourcesQuery: (...args: unknown[]) => {
    state.sourcesQuery(...args);
    return { data: state.sources, refetch: state.refetch };
  },
  useProjectS3ObjectsQuery: (...args: unknown[]) => {
    state.pageQuery(...args);
    return {
      data: {
        source,
        objects: [{ key: 'selected/note.md', etag: '"etag"', bytes: 5 }],
        continuationToken: 'next-page',
        truncated: true,
      },
      refetch: vi.fn(),
    };
  },
  useProjectS3ObjectQuery: (...args: unknown[]) => {
    state.objectQuery(...args);
    return {
      data: state.read,
      isError: state.readError,
      error: new Error('Object changed'),
    };
  },
  useAttachProjectS3SourceMutation: () => ({ mutateAsync: state.attach }),
  useDisconnectProjectS3SourceMutation: () => ({
    mutateAsync: state.disconnect,
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = state.manage = true;
  state.capabilityError = state.capabilityFetching = state.readError = false;
  state.sources = [];
  state.read = undefined;
  state.attach.mockResolvedValue(source);
  state.disconnect.mockResolvedValue(undefined);
  state.refetch.mockResolvedValue({ data: [] });
});

test('default-off hides S3 and never starts source or object queries', () => {
  state.enabled = false;
  const view = render(<ProjectS3Sources {...props} />);
  expect(view.container.textContent).toBe('');
  expect(state.sourcesQuery).not.toHaveBeenCalled();
  expect(state.pageQuery).not.toHaveBeenCalled();
  expect(state.objectQuery).not.toHaveBeenCalled();
});

test('attachment needs explicit Project sharing and captures the exact bucket-owner/profile/prefix selection', async () => {
  render(<ProjectS3Sources {...props} />);
  for (const [label, value] of [
    ['Source name', 'Archive'],
    ['Expected bucket-owner account ID', '123456789012'],
    ['AWS region', 'us-west-2'],
    ['Bucket name', 'fixture-archive'],
    ['Prefix (ending in /)', 'selected/'],
    ['AWS profile', 'fixture-only'],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const attach = screen.getByRole('button', { name: 'Attach S3 prefix' });
  expect(attach.hasAttribute('disabled')).toBe(true);
  fireEvent.click(attach);
  expect(state.attach).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(attach);
  await waitFor(() =>
    expect(state.attach).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedProjectId: 'project-a',
        profile: 'fixture-only',
        accountId: '123456789012',
        bucket: 'fixture-archive',
        prefix: 'selected/',
        shareWithProject: true,
      }),
    ),
  );
});

test('lost attachment response retains the same request identity for explicit continuation', async () => {
  state.attach.mockRejectedValue(new Error('Lost attachment response'));
  render(<ProjectS3Sources {...props} />);
  for (const [label, value] of [
    ['Source name', 'Archive'],
    ['Expected bucket-owner account ID', '123456789012'],
    ['AWS region', 'us-west-2'],
    ['Bucket name', 'fixture-archive'],
    ['Prefix (ending in /)', 'selected/'],
    ['AWS profile', 'fixture-only'],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Attach S3 prefix' }));
  await screen.findByText('Lost attachment response');
  const id = state.attach.mock.calls[0]![0].id;
  expect(state.attach).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh S3 sources' }));
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Attach S3 prefix' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Attach S3 prefix' }));
  await waitFor(() => expect(state.attach).toHaveBeenCalledTimes(2));
  expect(state.attach.mock.calls[1]![0].id).toBe(id);
});

test('permission loss disables an already-open disconnect confirmation', () => {
  state.sources = [source];
  const view = render(<ProjectS3Sources {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect S3 source' }));
  state.capabilityError = true;
  view.rerender(<ProjectS3Sources {...props} />);
  const dialog = screen.getByRole('dialog', { name: 'Disconnect S3 source?' });
  const confirm = within(dialog).getByRole('button', {
    name: 'Disconnect',
  });
  expect(confirm.hasAttribute('disabled')).toBe(true);
  fireEvent.click(confirm);
  expect(state.disconnect).not.toHaveBeenCalled();
});

test('a selected object is ETag-pinned and cached text is withheld on a fresh error', async () => {
  state.sources = [source];
  state.read = {
    source,
    object: {
      key: 'selected/note.md',
      etag: '"etag"',
      bytes: 5,
      sha256: 'a'.repeat(64),
    },
    text: 'Private selected text',
    citation: 's3://fixture-archive/selected/note.md?etag=etag',
    observedAt: '2026-10-22T00:00:00Z',
  };
  const view = render(<ProjectS3Sources {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Browse prefix' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Read selected/note.md' }),
  );
  expect(state.objectQuery).toHaveBeenLastCalledWith(
    authority,
    'research',
    source.id,
    { key: 'selected/note.md', etag: '"etag"' },
    true,
  );
  expect(screen.getByText('Private selected text')).toBeTruthy();
  state.readError = true;
  view.rerender(<ProjectS3Sources {...props} />);
  expect(screen.queryByText('Private selected text')).toBeNull();
  expect(screen.getByText(/Object changed/)).toBeTruthy();
});
