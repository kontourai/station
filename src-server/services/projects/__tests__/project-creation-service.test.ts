import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { ProjectCreationService } from '../project-creation-service.js';
import { ProjectService } from '../project-service.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'station-project-creation-'));
  roots.push(home);
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const storage = new FileStorageAdapter(home);
  const projects = new ProjectService(storage, undefined, async () => 'shared');
  const service = new ProjectCreationService(home, storage);
  const request = {
    name: 'Research',
    slug: 'research',
    workingDirectory: workspace,
  };
  return { home, storage, projects, service, request };
}

test('concurrent creation joins one reserved Project identity and restart returns the retained result', async () => {
  const f = fixture();
  const id = randomUUID();
  let publications = 0;
  const publish = async (projectId: string) => {
    publications += 1;
    return f.projects.createProject(f.request, projectId);
  };
  const [first, duplicate] = await Promise.all([
    f.service.create(id, f.request, publish),
    new ProjectCreationService(f.home, f.storage).create(
      id,
      f.request,
      publish,
    ),
  ]);
  expect(first.phase).toBe('created');
  expect(duplicate.project?.id).toBe(first.projectId);
  expect(publications).toBe(1);
  expect(f.storage.listProjects()).toHaveLength(1);
  const restarted = new ProjectCreationService(f.home, f.storage);
  expect(restarted.get(id)?.project?.id).toBe(first.projectId);
  await expect(
    restarted.create(id, { ...f.request, name: 'Changed' }, publish),
  ).rejects.toThrow('different Project inputs');
  expect(publications).toBe(1);
});

test('publication before a lost response is recovered without recreating, and deletion never replays the intent', async () => {
  const f = fixture();
  const id = randomUUID();
  let publications = 0;
  await expect(
    f.service.create(id, f.request, async (projectId) => {
      publications += 1;
      await f.projects.createProject(f.request, projectId);
      throw new Error('response lost after publication');
    }),
  ).rejects.toThrow('response lost');
  const restarted = new ProjectCreationService(f.home, f.storage);
  expect(restarted.get(id)?.phase).toBe('created');
  const recovered = await restarted.create(id, f.request, async () => {
    throw new Error('must not replay');
  });
  expect(recovered.project?.id).toBe(recovered.projectId);
  expect(publications).toBe(1);
  await f.projects.deleteProject('research');
  expect(restarted.get(id)?.phase).toBe('unavailable');
  expect(
    (
      await restarted.create(id, f.request, async () => {
        throw new Error('must not resurrect');
      })
    ).phase,
  ).toBe('unavailable');
  expect(f.storage.listProjects()).toHaveLength(0);
});

test('a held attempt without visible Project never silently retries or overwrites a corrupt intent', async () => {
  const f = fixture();
  const id = randomUUID();
  await expect(
    f.service.create(id, f.request, async () => {
      throw new Error('interrupted');
    }),
  ).rejects.toThrow('interrupted');
  expect(f.service.get(id)?.phase).toBe('uncertain');
  expect(
    (
      await f.service.create(id, f.request, async () => {
        throw new Error('unexpected retry');
      })
    ).phase,
  ).toBe('uncertain');
  const receipt = join(
    f.home,
    'project-creation-requests',
    id,
    'operation.json',
  );
  writeFileSync(receipt, '{broken');
  await expect(
    f.service.create(id, f.request, async () => {
      throw new Error('unexpected retry');
    }),
  ).rejects.toThrow();
  expect(readFileSync(receipt, 'utf8')).toBe('{broken');
});

test('a completed receipt cannot recreate a deleted Project or bind a replacement with the same slug', async () => {
  const f = fixture();
  const id = randomUUID();
  const created = await f.service.create(id, f.request, (projectId) =>
    f.projects.createProject(f.request, projectId),
  );
  await f.projects.deleteProject('research');
  const replacement = await f.projects.createProject(f.request);
  expect(replacement.id).not.toBe(created.projectId);
  const result = await f.service.create(id, f.request, async () => {
    throw new Error('must not replay');
  });
  expect(result.phase).toBe('unavailable');
  expect(result.project).toBeUndefined();
  expect(f.storage.getProject('research').id).toBe(replacement.id);
});
