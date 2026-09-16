/**
 * #2060 — the project layout routes serve project-owned Layouts only.
 *
 * The acceptance criterion ("a principal-owned layout … is not listed by any
 * project's layout route") is asserted through the real HTTP handler rather
 * than through `listLayouts`, because the route is what a client reaches and
 * the route is where a future filter would be forgotten.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LayoutMetadata } from '@kontourai/station-contracts/layout';
import { INSTANCE_LAYOUT_OWNER } from '@kontourai/station-contracts/layout';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  projectOps: { add: vi.fn() },
}));

const { createProjectRoutes } = await import('../projects.js');
const { FileStorageAdapter } = await import(
  '../../../domain/file-storage-adapter.js'
);
const { ProjectService } = await import(
  '../../../services/projects/project-service.js'
);

const NOW = '2026-01-01T00:00:00.000Z';
const alice = humanPrincipal('oidc', 'alice', 'Alice');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function seeded() {
  const home = mkdtempSync(join(tmpdir(), 'station-layout-owner-route-'));
  tempDirs.push(home);
  const storage = new FileStorageAdapter(home);
  const projectService = new ProjectService(storage);
  const app = createProjectRoutes(projectService as any, storage as any, home, {
    listAgents: async () => [],
  });
  await storage.createProject({
    id: 'project-1',
    slug: 'demo',
    name: 'Demo',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await storage.createProject({
    id: 'project-2',
    slug: 'other',
    name: 'Other',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { home, storage, app };
}

function board(slug: string) {
  return {
    id: `board-${slug}`,
    owner: { kind: 'principal', principal: alice } as const,
    slug,
    type: 'coding',
    name: 'A Board',
    config: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('project layout routes and non-project owners', () => {
  test('no project route lists a principal- or instance-owned layout', async () => {
    const { storage, app } = await seeded();
    await storage.createOwnedLayout(
      { kind: 'principal', principal: alice },
      board('my-board'),
    );
    await storage.createOwnedLayout(INSTANCE_LAYOUT_OWNER, {
      ...board('shared'),
      id: 'instance-1',
      owner: INSTANCE_LAYOUT_OWNER,
    });
    // One project owns a Layout, so a green result cannot come from the route
    // returning nothing at all.
    await storage.createLayout('demo', {
      id: 'layout-1',
      projectSlug: 'demo',
      slug: 'coding',
      type: 'coding',
      name: 'Coding',
      config: {},
      createdAt: NOW,
      updatedAt: NOW,
    });

    for (const [slug, expected] of [
      ['demo', ['coding']],
      ['other', []],
    ] as const) {
      const res = await app.request(`/${slug}/layouts`);
      expect(res.status).toBe(200);
      const body = await json<{ data: LayoutMetadata[] }>(res);
      expect(body.data.map((layout) => layout.slug)).toEqual(expected);
    }

    // And neither is readable by slug through a project route.
    expect((await app.request('/demo/layouts/my-board')).status).toBe(404);
    expect((await app.request('/other/layouts/shared')).status).toBe(404);
  });

  test('a create body naming an owner does not relocate the new layout', async () => {
    const { home, app } = await seeded();
    const res = await app.request('/demo/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'coding',
        name: 'Coding',
        type: 'coding',
        owner: { kind: 'principal', principal: alice },
      }),
    });
    expect(res.status).toBe(201);
    const persisted = JSON.parse(
      readFileSync(
        join(home, 'projects', 'demo', 'layouts', 'coding.json'),
        'utf8',
      ),
    );
    expect(persisted.owner).toBeUndefined();
    expect(persisted.projectSlug).toBe('demo');
  });

  test('an update body naming an owner does not relocate a stored layout', async () => {
    const { home, storage, app } = await seeded();
    await storage.createLayout('demo', {
      id: 'layout-1',
      projectSlug: 'demo',
      slug: 'coding',
      type: 'coding',
      name: 'Coding',
      config: {},
      createdAt: NOW,
      updatedAt: NOW,
    });
    const res = await app.request('/demo/layouts/coding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Renamed',
        owner: { kind: 'instance' },
      }),
    });
    expect(res.status).toBe(200);
    const persisted = JSON.parse(
      readFileSync(
        join(home, 'projects', 'demo', 'layouts', 'coding.json'),
        'utf8',
      ),
    );
    expect(persisted.owner).toBeUndefined();
    expect(persisted.name).toBe('Renamed');
    expect(persisted.projectSlug).toBe('demo');
  });
});
