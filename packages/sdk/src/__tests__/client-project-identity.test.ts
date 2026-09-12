import type { ProjectIdentityView } from '@kontourai/station-contracts/project-identity';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  attachProject,
  getProjectIdentity,
  prepareProjectIdentity,
} from '../client/index';

function view(): ProjectIdentityView {
  return {
    identity: {
      schemaVersion: 1,
      id: 'prj_shared',
      repos: [
        {
          kind: 'git',
          id: 'git.example/acme/repo',
          canonicalRemote: 'git.example/acme/repo',
        },
      ],
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    },
    association: {
      portableProjectId: 'prj_shared',
      localProjectId: 'local-id',
      localProjectSlug: 'local',
    },
  };
}
function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('Project identity client', () => {
  test('reads and explicitly prepares against the supplied environment', async () => {
    vi.mocked(fetch).mockResolvedValue(reply(view()));
    expect(
      await getProjectIdentity('https://station.example', 'local'),
    ).toEqual(view());
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'https://station.example/api/projects/local/identity',
    );
    vi.mocked(fetch).mockResolvedValue(reply(view()));
    expect(
      await prepareProjectIdentity('https://station.example', 'local'),
    ).toEqual(view());
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.method).toBe('POST');
  });

  test('attaches a typed snapshot and retains the receiver-local association', async () => {
    const input = { name: 'Local', slug: 'local', identity: view().identity };
    vi.mocked(fetch).mockResolvedValue(
      reply({ ...view(), outcome: 'created' }, 201),
    );
    expect(await attachProject('https://receiver.example', input)).toEqual({
      ...view(),
      outcome: 'created',
    });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'https://receiver.example/api/projects/attach',
    );
    expect(
      JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)),
    ).toEqual(input);
  });

  test('reads a local-only organizational resource without inventing a checkout', async () => {
    const data: ProjectIdentityView = {
      ...view(),
      identity: {
        ...view().identity,
        repos: [{ kind: 'local-only', id: 'local:scratch' }],
      },
    };
    vi.mocked(fetch).mockResolvedValue(reply(data));
    expect(
      await getProjectIdentity('https://station.example', 'local'),
    ).toEqual(data);
    expect(fetch).toHaveBeenCalledOnce();
  });

  test.each([
    { ...view(), identity: { ...view().identity, schemaVersion: 2 } },
    {
      ...view(),
      association: { ...view().association, portableProjectId: 'prj_other' },
    },
    {
      ...view(),
      association: { ...view().association, localProjectSlug: 'other' },
    },
    { ...view(), identity: { ...view().identity, path: '/private/checkout' } },
    {
      ...view(),
      identity: {
        ...view().identity,
        repos: [{ ...view().identity.repos[0], secret: 'private' }],
      },
    },
    null,
  ])(
    'refuses incompatible or mismatched identity without returning it',
    async (data) => {
      vi.mocked(fetch).mockResolvedValue(reply(data));
      await expect(
        getProjectIdentity('https://station.example', 'local'),
      ).rejects.toThrow('cannot validate');
    },
  );

  test('does not accept another portable Project or invent attachment completion', async () => {
    vi.mocked(fetch).mockResolvedValue(
      reply({ ...view(), outcome: 'created' }),
    );
    await expect(
      attachProject('https://station.example', {
        name: 'Local',
        slug: 'local',
        identity: { ...view().identity, id: 'prj_requested' },
      }),
    ).rejects.toThrow('cannot validate');
    vi.mocked(fetch).mockResolvedValue(reply({ ...view(), outcome: 'queued' }));
    await expect(
      attachProject('https://station.example', {
        name: 'Local',
        slug: 'local',
        identity: view().identity,
      }),
    ).rejects.toThrow('cannot validate');
  });

  test('an older or unavailable server is an error, never a local creation fallback', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'unsupported' }), {
        status: 501,
      }),
    );
    await expect(
      attachProject('https://station.example', {
        name: 'Local',
        slug: 'local',
        identity: view().identity,
      }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  test('captures the requested association before asynchronous credential or response work', async () => {
    let resolveResponse!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    vi.mocked(fetch).mockReturnValue(pendingResponse);
    const input = { name: 'Local', slug: 'local', identity: view().identity };
    const pending = attachProject('https://receiver.example', input);
    input.slug = 'other';
    input.identity.id = 'prj_other';
    resolveResponse(reply({ ...view(), outcome: 'created' }));
    expect(await pending).toEqual({ ...view(), outcome: 'created' });
    expect(
      JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)),
    ).toMatchObject({ slug: 'local', identity: { id: 'prj_shared' } });
  });
});
