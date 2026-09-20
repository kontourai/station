import { afterEach, expect, test, vi } from 'vitest';
import {
  getProject,
  getProjectView,
  listProjects,
  listProjectViews,
} from '../client/projects';

const member = {
  version: 'station.member-project/v1',
  kind: 'member-project',
  id: 'project-id',
  slug: 'shared',
  name: 'Shared',
  actions: ['view'],
} as const;

afterEach(() => vi.unstubAllGlobals());

function respond(data: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ success: true, data })),
  );
}

test('member-view helpers preserve the explicit safe projection', async () => {
  respond([member]);
  await expect(listProjectViews('https://station.example')).resolves.toEqual([
    member,
  ]);
  respond(member);
  await expect(
    getProjectView('https://station.example', 'shared'),
  ).resolves.toEqual(member);
});

test('legacy full-view helpers refuse a member projection', async () => {
  respond([member]);
  await expect(listProjects('https://station.example')).rejects.toThrow(
    'Full Project metadata is unavailable',
  );
  respond(member);
  await expect(getProject('https://station.example', 'shared')).rejects.toThrow(
    'Full Project configuration is unavailable',
  );
});

test.each([
  { ...member, version: 'station.member-project/v2' },
  { ...member, actions: ['not-an-action'] },
  { ...member, workingDirectory: '/private/marker' },
])(
  'member-view helpers reject malformed or future projections',
  async (value) => {
    respond([value]);
    await expect(listProjectViews('https://station.example')).rejects.toThrow(
      'unsupported member Project view',
    );
    respond(value);
    await expect(
      getProject('https://station.example', 'shared'),
    ).rejects.toThrow('unsupported member Project view');
  },
);
