import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type LayoutConfig,
  layoutPresentationDeclaration,
  layoutSubject,
} from '@kontourai/station-contracts/layout';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { afterEach, expect, test } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { layoutOwnerDirectory } from '../../../domain/layout-owner-storage.js';
import { ownedLayoutStore } from '../../../services/layouts/personal-layout-service.js';
import {
  ProjectMembershipRefusal,
  ProjectMembershipStore,
} from '../../../services/projects/project-membership-store.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { createProjectRoutes } from '../../projects/projects.js';
import { createPersonalLayoutRoutes } from '../personal-layouts.js';

const NOW = '2026-10-24T00:00:00.000Z';
const alice = humanPrincipal('oidc', 'alice', 'Alice');
const bob = humanPrincipal('oidc', 'bob', 'Bob');
const makeTempDir = trackTempDirs();
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const subject = { kind: 'project', projectSlug: 'p' } as const;
const inside = {
  id: 'inside',
  component: { kind: 'plugin-component', name: 'inside-view' },
};
const outside = {
  id: 'outside',
  component: { kind: 'plugin-component', name: 'outside-view' },
};
async function harness() {
  const home = makeTempDir('station-owner-subject-2996-');
  const store = new FileStorageAdapter(home);
  const project: ProjectConfig = {
    id: 'p-id',
    slug: 'p',
    name: 'Project',
    createdAt: NOW,
    updatedAt: NOW,
  };
  await store.createProject(project);
  const source: LayoutConfig = {
    id: 'shared-id',
    projectSlug: 'p',
    slug: 'shared',
    name: 'Shared',
    type: 'custom',
    config: { plugin: 'inside', tabs: [inside] },
    createdAt: NOW,
    updatedAt: NOW,
  };
  await store.createLayout('p', source);
  const hidden = new Set<string>();
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const members = new ProjectMembershipStore(db, 'station', () =>
    Date.parse(NOW),
  );
  const owner = humanPrincipal('oidc', 'owner', 'Owner');
  const scope = {
    stationId: 'station',
    localProjectId: 'p-id',
    localProjectSlug: 'p',
    portableProjectId: 'prj_p',
  };
  members.enable(scope, owner);
  for (const principal of [alice, bob]) {
    const email =
      principal.id === alice.id ? 'alice@example.test' : 'bob@example.test';
    const invite = members.invite(scope, owner, {
      email,
      role: 'contributor',
      expiresAt: '2026-10-25T00:00:00.000Z',
    });
    members.accept(invite.token, principal, [email]);
  }
  const setRole = (
    role: 'contributor' | 'admin',
    status: 'active' | 'revoked' = 'active',
  ) =>
    members.changeMember(
      scope,
      owner,
      alice.id,
      members.require(scope, alice, 'view').revision,
      { role, status },
    );

  const app = createPersonalLayoutRoutes(ownedLayoutStore(store), {
    resolvePrincipal: (c) =>
      c.req.header('x-principal') === 'bob' ? bob : alice,
    listAgents: async () => [],
    canSeePlugin: (_c, id) => !hidden.has(id),
    canUseProject: async (c, slug, action) => {
      if (slug !== scope.localProjectSlug) return false;
      try {
        members.require(
          scope,
          c.req.header('x-principal') === 'bob' ? bob : alice,
          action,
        );
        return true;
      } catch (error) {
        if (error instanceof ProjectMembershipRefusal) return false;
        throw error;
      }
    },
    componentPlugins: (name) =>
      name === 'inside-view'
        ? ['inside']
        : name === 'outside-view'
          ? ['outside']
          : [],
  });
  const request = (
    path: string,
    method = 'GET',
    body?: unknown,
    principal = 'alice',
  ) =>
    app.request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-principal': principal,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const projects = createProjectRoutes(new ProjectService(store), store, home, {
    listAgents: async () => [],
  });
  const policy = async (
    personalLayouts: NonNullable<ProjectConfig['personalLayouts']>,
    personalLayoutAllowedPlugins: string[] = [],
  ) => {
    const response = await projects.request('/p/layout-policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personalLayouts, personalLayoutAllowedPlugins }),
    });
    expect(response.status).toBe(200);
  };
  const create = (slug = 'mine', tabs = [inside]) =>
    request('/layouts', 'POST', {
      slug,
      name: slug,
      subject,
      config: { tabs },
    });
  return { home, store, source, hidden, setRole, request, policy, create };
}

test('personal Project layout list/fetch/update/delete/clone disclose nothing to a second principal', async () => {
  const { request, create, store } = await harness();
  expect((await create()).status).toBe(201);
  expect(
    (
      await readJson<{ data: { slug: string }[] }>(await request('/layouts'))
    ).data.map((r) => r.slug),
  ).toEqual(['mine']);
  expect(
    (
      await readJson<{ data: unknown[] }>(
        await request('/layouts', 'GET', undefined, 'bob'),
      )
    ).data,
  ).toEqual([]);
  for (const [method, suffix, body] of [
    ['GET', '', undefined],
    ['PUT', '', { name: 'stolen' }],
    ['DELETE', '', undefined],
    ['POST', '/clone', { slug: 'copy' }],
  ] as const) {
    const theirs = await request(`/layouts/mine${suffix}`, method, body, 'bob');
    const missing = await request(
      `/layouts/absent${suffix}`,
      method,
      body,
      'bob',
    );
    expect(theirs.status).toBe(404);
    expect(theirs.status).toBe(missing.status);
    expect(await theirs.text()).toBe(await missing.text());
  }
  expect(
    store.getOwnedLayout({ kind: 'principal', principal: alice }, 'mine').name,
  ).toBe('mine');
});

test('Project panes and allowed plugins constrain writes, updates and reads without deleting records', async () => {
  const { request, create, store, policy, hidden } = await harness();
  expect((await create()).status).toBe(201);
  expect((await create('outside', [outside])).status).toBe(400);
  await policy('allowed-plugins');
  expect((await create('outside', [outside])).status).toBe(400);
  await policy('allowed-plugins', ['outside']);
  expect((await create('outside', [outside])).status).toBe(201);
  hidden.add('outside');
  expect((await create('hidden', [outside])).status).toBe(400);
  expect(
    (await request('/layouts/mine', 'PUT', { config: { tabs: [outside] } }))
      .status,
  ).toBe(400);
  expect((await request('/layouts/outside')).status).toBe(404);
  expect(
    (
      await readJson<{ data: { slug: string }[] }>(await request('/layouts'))
    ).data.map((r) => r.slug),
  ).toEqual(['mine']);
  hidden.clear();
  await policy('project-panes');
  expect((await request('/layouts/outside')).status).toBe(404);
  expect(
    store.getOwnedLayout({ kind: 'principal', principal: alice }, 'outside')
      .config.tabs,
  ).toEqual([outside]);
  await policy('off');
  expect((await request('/layouts/mine')).status).toBe(404);
  expect((await create('disabled')).status).toBe(400);
  await policy('allowed-plugins', ['outside']);
  expect((await request('/layouts/outside')).status).toBe(200);
});

test('unknown or hidden plugin renderers cannot bypass policy via missing binding or alternative renderer', async () => {
  const { request, create, hidden, policy } = await harness();
  hidden.add('inside');
  expect((await create()).status).toBe(400);
  hidden.clear();
  await policy('allowed-plugins', ['inside', 'outside']);
  hidden.add('outside');
  expect(
    (
      await request('/layouts', 'POST', {
        slug: 'alternative',
        name: 'Alt',
        subject,
        config: {
          tabs: [
            {
              ...inside,
              alternativeRenderer: { component: outside.component },
            },
          ],
        },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request('/layouts', 'POST', {
        slug: 'unknown',
        name: 'Unknown',
        subject,
        config: { tabs: [{ id: 'x', component: 'never-installed' }] },
      })
    ).status,
  ).toBe(400);
});

test('clone keeps source bytes and identity; save as my layout clears subject; template open binds without writing', async () => {
  const { request, home, store, source, setRole } = await harness();
  const sourcePath = join(home, 'projects/p/layouts/shared.json');
  const bytes = readFileSync(sourcePath, 'utf8');
  const clone = await request('/layouts/clone-project', 'POST', {
    projectSlug: 'p',
    layoutSlug: 'shared',
    slug: 'copy',
  });
  expect(clone.status).toBe(201);
  const copied = (await readJson<{ data: LayoutConfig }>(clone)).data;
  expect(copied.id).not.toBe(source.id);
  expect(copied.subject).toEqual(subject);
  expect(copied.config).toEqual(source.config);
  const collision = await request('/layouts/copy/clone', 'POST', {
    slug: 'copy',
  });
  expect(collision.status).toBe(409);
  expect(await readJson(collision)).toEqual({
    success: false,
    error: "A Board named 'copy' already exists.",
  });
  expect(
    store.getOwnedLayout({ kind: 'principal', principal: alice }, 'copy').id,
  ).toBe(copied.id);

  expect(readFileSync(sourcePath, 'utf8')).toBe(bytes);
  const templateResponse = await request('/layouts/copy/clone', 'POST', {
    slug: 'template',
    asTemplate: true,
  });
  expect(templateResponse.status).toBe(201);
  const template = (await readJson<{ data: LayoutConfig }>(templateResponse))
    .data;
  expect(template.subject).toBeUndefined();
  const templatePath = join(
    layoutOwnerDirectory(home, { kind: 'principal', principal: alice }),
    'template.json',
  );
  const templateBytes = readFileSync(templatePath, 'utf8');
  const opened = await request('/layouts/template/open?projectSlug=p');
  expect(opened.status).toBe(200);
  expect((await readJson<{ data: LayoutConfig }>(opened)).data.subject).toEqual(
    subject,
  );
  expect(readFileSync(templatePath, 'utf8')).toBe(templateBytes);
  expect(store.listLayouts('p').map((l) => l.slug)).toEqual(['shared']);
  setRole('contributor', 'revoked');
  expect((await request('/layouts/copy')).status).toBe(404);
  expect((await request('/layouts/template/open?projectSlug=p')).status).toBe(
    404,
  );
  expect(
    (
      await request('/layouts/clone-project', 'POST', {
        projectSlug: 'p',
        layoutSlug: 'shared',
        slug: 'denied',
      })
    ).status,
  ).toBe(404);
});

test('promotion remains a move and requires manage layouts; personal coding records cannot declare primary Chat', async () => {
  const { request, create, store, setRole } = await harness();
  expect((await create()).status).toBe(201);
  expect(
    (await request('/layouts/mine/promote', 'POST', { projectSlug: 'p' }))
      .status,
  ).toBe(403);
  setRole('admin');
  expect(
    (
      await request(
        '/layouts/mine/promote',
        'POST',
        { projectSlug: 'p' },
        'alice',
      )
    ).status,
  ).toBe(200);
  expect((await request('/layouts/mine')).status).toBe(404);
  expect(store.getLayout('p', 'mine').subject).toBeUndefined();
  await store.createLayout('p', {
    ...store.getLayout('p', 'mine'),
    id: 'coding-id',
    slug: 'coding',
    type: 'coding',
    config: {},
  });
  const coding = await request('/layouts', 'POST', {
    slug: 'fake-coding',
    name: 'Fake',
    type: 'coding',
    subject,
  });
  expect(coding.status).toBe(201);
  const data = (
    await readJson<{
      data: LayoutConfig & { primary?: string; presentation?: string };
    }>(coding)
  ).data;
  expect(data.primary).toBeUndefined();
  expect(
    layoutPresentationDeclaration({ ...data, presentation: undefined }).primary,
  ).toBeUndefined();
  expect(data.presentation).toBe('tabs');
});

test("today's stored Board and Project shapes read and persist unchanged under subject derivation", async () => {
  const { home, store, source, request } = await harness();
  const board: LayoutConfig = {
    id: 'board-mine',
    owner: { kind: 'principal', principal: alice },
    slug: 'old.board',
    type: 'coding',
    name: 'My Board',
    config: { tabs: [{ id: 'a' }, { id: 'b' }] },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const path = join(
    layoutOwnerDirectory(home, { kind: 'principal', principal: alice }),
    'old.board.json',
  );
  mkdirSync(dirname(path), { recursive: true });
  const bytes = `${JSON.stringify(board, null, 2)}\n`;
  writeFileSync(path, bytes);
  const read = store.getOwnedLayout(
    { kind: 'principal', principal: alice },
    'old.board',
  );
  expect(read).toEqual(board);
  expect(layoutSubject(read)).toBeUndefined();
  expect(
    (
      await request('/layouts/old.board/clone', 'POST', {
        slug: 'old.board.copy',
        asTemplate: true,
      })
    ).status,
  ).toBe(201);
  expect(layoutSubject(store.getLayout('p', 'shared'))).toEqual(subject);
  expect(store.getLayout('p', 'shared')).toEqual(source);
  expect(
    (
      await readJson<{ data: LayoutConfig }>(
        await request('/layouts/old.board'),
      )
    ).data,
  ).toEqual(board);
  await store.mutateOwnedLayout(
    { kind: 'principal', principal: alice },
    'old.board',
    (current) => {
      if (!current) throw new Error('missing fixture');
      return current;
    },
  );
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(bytes));
});

test.each(['chat', 'tasks', 'review', 'session-board', 'coding'])(
  'subject-bound %s writes require a matching Project surface type',
  async (type) => {
    const { request, create, store, source, policy } = await harness();
    const input = {
      slug: 'surface',
      name: 'Surface',
      type,
      subject,
      config: {},
    };
    expect((await request('/layouts', 'POST', input)).status).toBe(400);
    await policy('allowed-plugins', ['inside']);
    expect((await request('/layouts', 'POST', input)).status).toBe(400);
    expect((await create()).status).toBe(201);
    expect((await request('/layouts/mine', 'PUT', { type })).status).toBe(400);
    expect(
      store.getOwnedLayout({ kind: 'principal', principal: alice }, 'mine')
        .type,
    ).toBe('custom');
    await store.createLayout('p', {
      ...source,
      id: 'surface-id',
      slug: 'surface',
      type,
      config: {},
    });
    expect((await request('/layouts', 'POST', input)).status).toBe(201);
    expect((await request('/layouts/mine', 'PUT', { type })).status).toBe(200);
    expect(
      (
        await request('/layouts/clone-project', 'POST', {
          projectSlug: 'p',
          layoutSlug: 'surface',
          slug: 'copy',
        })
      ).status,
    ).toBe(201);
  },
);

test.each(['chat', 'tasks', 'review', 'session-board', 'coding'])(
  'subject-bound %s reads hide a surface removed from the Project',
  async (type) => {
    const { request, store, source } = await harness();
    await store.createLayout('p', {
      ...source,
      id: 'surface-id',
      slug: 'surface',
      type,
      config: {},
    });
    expect(
      (
        await request('/layouts/clone-project', 'POST', {
          projectSlug: 'p',
          layoutSlug: 'surface',
          slug: 'mine',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request('/layouts/mine/clone', 'POST', {
          slug: 'template',
          asTemplate: true,
        })
      ).status,
    ).toBe(201);
    await store.deleteLayout('p', 'surface');
    const missing = await request('/layouts/absent');
    const body = await missing.text();
    for (const [path, method, input] of [
      ['/layouts/mine', 'GET', undefined],
      ['/layouts/mine', 'PUT', { name: 'Rename' }],
      ['/layouts/mine/clone', 'POST', { slug: 'copy' }],
      ['/layouts/template/open?projectSlug=p', 'GET', undefined],
    ] as const) {
      const response = await request(path, method, input);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(body);
    }
    const listed = await readJson<{ data: { slug: string }[] }>(
      await request('/layouts'),
    );
    expect(listed.data.map((layout) => layout.slug)).toEqual(['template']);
    expect(
      store.getOwnedLayout({ kind: 'principal', principal: alice }, 'mine')
        .type,
    ).toBe(type);
  },
);

test.each(
  ['chat', 'tasks', 'review', 'session-board'].flatMap((type) =>
    (['plugin', 'mcp', 'legacy-plugin'] as const).map((binding) => ({
      type,
      binding,
    })),
  ),
)(
  '$binding Project layout labeled $type cannot admit a personal built-in surface at write or read',
  async ({ type, binding }) => {
    const { request, store, source, hidden } = await harness();
    await store.deleteLayout('p', 'shared');
    const surface: LayoutConfig = {
      ...source,
      id: 'surface-id',
      slug: 'surface',
      type,
      config: {},
    };
    await store.createLayout('p', surface);
    const input = { slug: 'mine', name: 'Mine', type, subject, config: {} };
    expect((await request('/layouts', 'POST', input)).status).toBe(201);
    expect((await request('/layouts/mine')).status).toBe(200);

    await store.deleteLayout('p', 'surface');
    await store.createLayout('p', {
      ...surface,
      ...(binding === 'legacy-plugin'
        ? { config: { plugin: 'inside' } }
        : {
            catalogContribution: {
              id: 'inside:layout',
              version: '1.0.0',
              sourceIdentity: { id: 'inside', kind: 'local' },
              provenance:
                binding === 'plugin'
                  ? { origin: 'plugin', pluginId: 'inside' }
                  : { origin: 'mcp', mcpServerId: 'inside' },
            },
          }),
    });
    const missingBody = await (await request('/layouts/absent')).text();
    for (const visibility of ['visible', 'hidden']) {
      if (visibility === 'hidden') hidden.add('inside');
      expect
        .soft(
          (
            await request('/layouts', 'POST', {
              ...input,
              slug: `refused-${visibility}`,
            })
          ).status,
        )
        .toBe(400);
      const read = await request('/layouts/mine');
      expect.soft(read.status).toBe(404);
      expect.soft(await read.text()).toBe(missingBody);
      const listed = await readJson<{ data: { slug: string }[] }>(
        await request('/layouts'),
      );
      expect.soft(listed.data).toEqual([]);
    }
    expect(
      store.getOwnedLayout({ kind: 'principal', principal: alice }, 'mine')
        .config,
    ).toEqual({});
    await store.deleteLayout('p', 'surface');
    await store.createLayout('p', surface);
    expect((await request('/layouts/mine')).status).toBe(200);
  },
);

test.each(['contributor', 'admin'] as const)(
  'promotion gives identical not-found answers for every unavailable source as %s',
  async (role) => {
    const { request, create, policy, setRole, store } = await harness();
    expect((await create()).status).toBe(201);
    expect(
      (
        await request(
          '/layouts',
          'POST',
          { slug: 'other-person', name: 'Other' },
          'bob',
        )
      ).status,
    ).toBe(201);
    setRole(role);
    await policy('off');
    const responses = [];
    for (const slug of ['mine', 'absent', 'bad%3Aslug', 'other-person']) {
      const response = await request(`/layouts/${slug}/promote`, 'POST', {
        projectSlug: 'p',
      });
      expect(response.status).toBe(404);
      responses.push(await response.text());
    }
    expect(new Set(responses).size).toBe(1);
    expect(store.listLayouts('p').map((layout) => layout.slug)).toEqual([
      'shared',
    ]);
    expect(
      store.getOwnedLayout({ kind: 'principal', principal: alice }, 'mine')
        .slug,
    ).toBe('mine');
  },
);

test('promotion fails closed without Project authorization wiring', async () => {
  const { store } = await harness();
  const app = createPersonalLayoutRoutes(ownedLayoutStore(store), {
    resolvePrincipal: () => alice,
    listAgents: async () => [],
  });
  const input = { slug: 'board', name: 'Board' };
  expect(
    (
      await app.request('/layouts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(201);
  const response = await app.request('/layouts/board/promote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectSlug: 'p' }),
  });
  expect(response.status).toBe(403);
  expect(
    store.getOwnedLayout({ kind: 'principal', principal: alice }, 'board').name,
  ).toBe('Board');
  expect(store.listLayouts('p').map((layout) => layout.slug)).toEqual([
    'shared',
  ]);
});

test('only the owner can delete a policy-hidden personal layout', async () => {
  const { request, create, policy, store } = await harness();
  expect((await create()).status).toBe(201);
  await policy('off');
  const theirs = await request('/layouts/mine', 'DELETE', undefined, 'bob');
  const missing = await request('/layouts/absent', 'DELETE', undefined, 'bob');
  expect(theirs.status).toBe(404);
  expect(await theirs.text()).toBe(await missing.text());
  expect((await request('/layouts/mine')).status).toBe(404);
  expect((await request('/layouts/mine', 'DELETE')).status).toBe(200);
  expect(
    store.listOwnedLayouts({ kind: 'principal', principal: alice }),
  ).toEqual([]);
  expect(store.listLayouts('p').map((layout) => layout.slug)).toEqual([
    'shared',
  ]);
});
