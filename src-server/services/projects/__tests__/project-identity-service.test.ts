import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type { ProjectPortableIdentity } from '@kontourai/station-contracts/project-identity';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import {
  FileStorageConflictError,
  type ProjectFileTransactionFaults,
} from '../../../domain/project-file-transactions.js';
import { parseProjectPortableIdentity } from '../../../domain/project-identity-record.js';
import { createProjectIdentityRoutes } from '../../../routes/projects/project-identity-routes.js';
import { execGit } from '../../../utils/git-exec.js';
import {
  type CheckoutRemoteReader,
  readCheckoutRemotes,
} from '../checkout-remote-reader.js';
import { ProjectIdentityService } from '../project-identity-service.js';
import {
  ProjectManifestStore,
  projectManifestPath,
} from '../project-manifest-store.js';
import { ProjectResourceResolver } from '../project-resource-resolver.js';
import { ProjectService } from '../project-service.js';

const roots: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'station-project-identity-'));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function identity(): ProjectPortableIdentity {
  return {
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
  };
}
function project(): ProjectConfig {
  return {
    id: 'local-project',
    slug: 'local',
    name: 'Local',
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  };
}
const readRemotes: CheckoutRemoteReader = async () => ({
  ok: true,
  remotes: [{ name: 'origin', url: 'alice@git.example:acme/repo.git' }],
});
function harness(
  options: {
    home?: string;
    faults?: ProjectFileTransactionFaults;
    reader?: CheckoutRemoteReader;
  } = {},
) {
  const home = options.home ?? directory();
  const storage = new FileStorageAdapter(home, options.faults);
  const reader = options.reader ?? readRemotes;
  const manifests = new ProjectManifestStore(home, storage, {
    readRemotes: reader,
  });
  const projects = new ProjectService(storage, manifests);
  const service = new ProjectIdentityService(
    projects,
    storage,
    manifests,
    reader,
    () => ({}),
  );
  return { home, storage, manifests, projects, service };
}

describe('portable Project attachment', () => {
  test('two isolated homes and real Git checkouts retain one portable identity and distinct local IDs and paths', async () => {
    const sourcePath = directory();
    const destinationPath = directory();
    for (const path of [sourcePath, destinationPath]) {
      await execGit(['init', '-q'], { cwd: path });
      await execGit(
        ['remote', 'add', 'origin', 'https://git.example/acme/repo.git'],
        { cwd: path },
      );
    }
    const source = harness({ reader: readCheckoutRemotes });
    const destination = harness({ reader: readCheckoutRemotes });
    const original = await source.projects.createProject({
      name: 'Source',
      slug: 'source',
      workingDirectory: sourcePath,
    });
    const snapshot = await source.service.read('source');
    expect(snapshot.identity.id).not.toBe(original.id);
    expect(JSON.stringify(snapshot.identity)).not.toContain(sourcePath);
    const attached = await destination.service.attach({
      name: 'Destination',
      slug: 'destination',
      workingDirectory: destinationPath,
      identity: snapshot.identity,
    });
    expect(attached.outcome).toBe('created');
    expect(attached.association.portableProjectId).toBe(snapshot.identity.id);
    expect(attached.association.localProjectId).not.toBe(original.id);
    expect(attached.association.localProjectSlug).toBe('destination');
    expect(attached.identity).toEqual(snapshot.identity);
    const resolver = new ProjectResourceResolver({
      homeDir: destination.home,
      source: destination.storage,
    });
    expect(await resolver.resolveProjectResource('destination')).toEqual({
      state: 'bound',
      resourceId: 'git.example/acme/repo',
      path: destinationPath,
    });
    await execGit(
      ['remote', 'set-url', 'origin', 'https://git.example/other/repo.git'],
      { cwd: destinationPath },
    );
    expect(await resolver.resolveProjectResource('destination')).toMatchObject({
      state: 'drifted',
      resourceId: 'git.example/acme/repo',
    });
  });

  test('concurrent identical requests reuse the existing local identity', async () => {
    const { service, storage } = harness();
    const input = { name: 'Local', slug: 'local', identity: identity() };
    const results = await Promise.all([
      service.attach(input),
      service.attach(input),
    ]);
    expect(results.map((value) => value.outcome).sort()).toEqual([
      'created',
      'existing',
    ]);
    expect(results[0].association).toEqual(results[1].association);
    expect(storage.listProjects()).toHaveLength(1);
  });

  test('an existing same-slug Project and its owned files are unchanged', async () => {
    const { service, projects, storage, home } = harness();
    const original = await projects.createProject({
      name: 'Local',
      slug: 'local',
    });
    const history = join(home, 'projects', 'local', 'owned-content.json');
    writeFileSync(history, '{"private":true}');
    const manifest = readFileSync(projectManifestPath(home, 'local'), 'utf8');
    await expect(
      service.attach({ name: 'Local', slug: 'local', identity: identity() }),
    ).rejects.toBeInstanceOf(FileStorageConflictError);
    expect(storage.getProject('local').id).toBe(original.id);
    expect(readFileSync(history, 'utf8')).toBe('{"private":true}');
    expect(readFileSync(projectManifestPath(home, 'local'), 'utf8')).toBe(
      manifest,
    );
  });

  test('identity reads do not backfill, and explicit preparation preserves the local Project ID', async () => {
    const { service, storage, home } = harness();
    await storage.createProject(project());
    await expect(service.read('local')).rejects.toThrow('no portable identity');
    expect(existsSync(projectManifestPath(home, 'local'))).toBe(false);
    const prepared = await service.prepare('local');
    expect(prepared.association.localProjectId).toBe('local-project');
    expect(prepared.association.portableProjectId).not.toBe('local-project');
    expect(await service.prepare('local')).toEqual(prepared);
    expect(await service.read('local')).toEqual(prepared);
  });

  test('a failure before directory publication leaves no visible partial Project', async () => {
    const home = directory();
    const { service, storage } = harness({
      home,
      faults: {
        afterProjectCreatePrepared: () => {
          expect(storage.listProjects()).toEqual([]);
          expect(existsSync(join(home, 'projects', 'local'))).toBe(false);
          throw new Error('injected before publication');
        },
      },
    });
    await expect(
      service.attach({ name: 'Local', slug: 'local', identity: identity() }),
    ).rejects.toThrow('publication is unavailable');
    expect(storage.listProjects()).toEqual([]);
    expect(existsSync(join(home, 'projects', 'local'))).toBe(false);
  });

  test('a post-commit fault reports the applied create and retry retains its identity', async () => {
    const { service } = harness({
      faults: {
        afterProjectCreateCommit: () => {
          throw new Error('lost acknowledgment');
        },
      },
    });
    const input = { name: 'Local', slug: 'local', identity: identity() };
    const first = await service.attach(input);
    expect(first.outcome).toBe('created');
    expect(await service.attach(input)).toEqual({
      ...first,
      outcome: 'existing',
    });
  });

  test('an occupied directory without a Project record is preserved', async () => {
    const { home, service } = harness();
    const occupied = join(home, 'projects', 'local');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'keep.txt'), 'keep');
    await expect(
      service.attach({ name: 'Local', slug: 'local', identity: identity() }),
    ).rejects.toBeInstanceOf(FileStorageConflictError);
    expect(readFileSync(join(occupied, 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(occupied, 'project.json'))).toBe(false);
  });

  test('a different checkout never publishes a Project', async () => {
    const { storage, service } = harness({
      reader: async () => ({
        ok: true,
        remotes: [{ name: 'origin', url: 'https://git.example/other/repo' }],
      }),
    });
    await expect(
      service.attach({
        name: 'Local',
        slug: 'local',
        workingDirectory: directory(),
        identity: identity(),
      }),
    ).rejects.toThrow('does not verifiably realize');
    expect(storage.listProjects()).toEqual([]);
  });

  test('an unavailable checkout observation never publishes a Project', async () => {
    const { storage, service } = harness({
      reader: async () => ({ ok: false, reason: 'git unavailable' }),
    });
    await expect(
      service.attach({
        name: 'Local',
        slug: 'local',
        workingDirectory: directory(),
        identity: identity(),
      }),
    ).rejects.toThrow('repository could not be verified');
    expect(storage.listProjects()).toEqual([]);
  });

  test('a corrupt existing sidecar is preserved rather than replaced during attachment', async () => {
    const { storage, service, home } = harness();
    await storage.createProject(project());
    const path = projectManifestPath(home, 'local');
    writeFileSync(path, '{broken');
    await expect(
      service.attach({ name: 'Local', slug: 'local', identity: identity() }),
    ).rejects.toMatchObject({
      code: 'file_storage_unavailable',
      cause: expect.objectContaining({
        name: 'ProjectManifestUnreadableError',
      }),
    });
    expect(readFileSync(path, 'utf8')).toBe('{broken');
    expect(storage.getProject('local').id).toBe('local-project');
  });

  test('incoming identity objects cannot change while waiting for the write lock', async () => {
    const config = project();
    const portable = identity();
    const { storage, manifests } = harness({
      faults: {
        afterLockAcquired: () => {
          config.name = 'Changed';
          portable.id = 'prj_changed';
        },
      },
    });
    await storage.createProjectWithIdentity(config, portable);
    expect(storage.getProject('local').name).toBe('Local');
    expect(manifests.readRecord('local')?.id).toBe('prj_shared');
  });

  test('unsupported atomic storage refuses before creating an ordinary Project', async () => {
    const { storage, service } = harness();
    Object.defineProperty(storage, 'createProjectWithIdentity', {
      value: undefined,
    });
    await expect(
      service.attach({ name: 'Local', slug: 'local', identity: identity() }),
    ).rejects.toThrow('cannot atomically attach');
    expect(storage.listProjects()).toEqual([]);
  });

  test('HTTP preparation and attachment use the service and preserve typed status/refusals', async () => {
    const { service, storage } = harness();
    const app = createProjectIdentityRoutes(service);
    await storage.createProject(project());
    expect((await app.request('/local/identity')).status).toBe(404);
    expect(
      (await app.request('/local/identity/prepare', { method: 'POST' })).status,
    ).toBe(200);
    const body = { name: 'Imported', slug: 'imported', identity: identity() };
    const request = () =>
      app.request('/attach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await request()).status).toBe(201);
    expect((await request()).status).toBe(200);
    const invalid = await app.request('/attach', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        identity: { ...identity(), schemaVersion: 2 },
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      success: false,
      code: 'project_identity_invalid',
    });
    expect(
      (
        await app.request('/attach', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, slug: '../escape' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (await createProjectIdentityRoutes(undefined).request('/local/identity'))
        .status,
    ).toBe(501);
  });

  test('HTTP conflict responses do not reflect internal exception text', async () => {
    const { service } = harness();
    vi.spyOn(service, 'attach').mockRejectedValue(
      new FileStorageConflictError('DO-NOT-EXPOSE-private-location'),
    );
    const response = await createProjectIdentityRoutes(service).request(
      '/attach',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Local',
          slug: 'local',
          identity: identity(),
        }),
      },
    );
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).not.toContain('DO-NOT-EXPOSE');
    expect(JSON.parse(body)).toMatchObject({
      success: false,
      code: 'file_storage_conflict',
    });
  });
});

describe('portable identity input boundary', () => {
  test.each([
    { ...identity(), schemaVersion: 2 },
    { ...identity(), path: '/private/checkout' },
    {
      ...identity(),
      repos: [{ ...identity().repos[0], credentials: 'private' }],
    },
    {
      ...identity(),
      repos: [
        {
          kind: 'git',
          id: 'git.example/acme/repo?token=private',
          canonicalRemote: 'git.example/acme/repo?token=private',
        },
      ],
    },
    {
      ...identity(),
      repos: [
        { kind: 'git', id: '/private/repo', canonicalRemote: '/private/repo' },
      ],
    },
  ])('refuses unknown versions or local/secret-bearing fields', (value) => {
    expect(() => parseProjectPortableIdentity(value)).toThrow();
  });
});
