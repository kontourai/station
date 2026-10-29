import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  isWalkthroughId,
  parseWalkthrough,
  WALKTHROUGH_LIMITS,
  type Walkthrough,
} from '@kontourai/station-contracts/walkthrough';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import type { ProjectFileTransactions } from '../../domain/project-file-transactions.js';
import { BROWSER_RECORD_MAX_ENCODED_BYTES } from '../../tools/station-browser-policy.js';
import {
  assertExistingPathInside,
  isCanonicalPathWithin,
} from '../../utils/path-containment.js';
import type { TaskReviewAccess } from '../orchestration/project-task-room-runtime.js';
import { TaskBrowserCaptureError } from '../projects/task-browser-capture.js';

function scopeKey(access: TaskReviewAccess): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        access.write.projectId,
        access.write.taskId,
        access.write.taskCreatedAt,
      ]),
    )
    .digest('hex');
}

async function location(path: string): Promise<string> {
  try {
    await lstat(path);
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await location(dirname(path)), basename(path));
  }
}

async function directory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Invalid Walkthrough storage directory');
}

async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error('Walkthrough file exceeds read bound');
    const data = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let size = 0;
    while (size < data.length) {
      const read = await file.read(data, size, data.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > maxBytes) throw new Error('Walkthrough file exceeds read bound');
    return data.subarray(0, size);
  } finally {
    await file.close();
  }
}

interface Stage {
  id: string;
  path: string;
  root: string;
  slug: string;
  project: ReturnType<ProjectFileTransactions['readProject']>;
}

/** Task clips share the Project Walkthrough root but not its project-wide list. */
export class TaskWalkthroughStore {
  constructor(
    private readonly deps: {
      files(): ProjectFileTransactions;
      projectSlugFor(identity: string): string | undefined;
      forbiddenRoots(): readonly string[];
    },
  ) {}

  private slug(access: TaskReviewAccess): string {
    if (!access.write.beforeCommit())
      throw new TaskBrowserCaptureError('not-found', 'Task not found.');
    const slug = this.deps.projectSlugFor(access.write.projectId);
    if (!slug)
      throw new TaskBrowserCaptureError('not-found', 'Task Project not found.');
    return slug;
  }

  private root(files: ProjectFileTransactions, slug: string) {
    const projectRoot = files.projectDirectory(slug);
    const root = join(projectRoot, 'walkthroughs', '.task-clips');
    assertExistingPathInside(projectRoot, root, 'Task Walkthrough storage');
    return root;
  }

  async stage(access: TaskReviewAccess, workspace: string): Promise<Stage> {
    const files = this.deps.files();
    const slug = this.slug(access);
    const project = files.readProject(slug, (value) => value);
    const root = this.root(files, slug);
    const storage = await location(root);
    for (const path of [workspace, ...this.deps.forbiddenRoots()]) {
      if (isCanonicalPathWithin(await location(path), storage))
        throw new TaskBrowserCaptureError(
          'capture-unavailable',
          'Task Walkthrough storage is inside a Project workspace.',
        );
    }
    await directory(dirname(root));
    await directory(root);
    this.root(files, slug);
    const id = randomUUID();
    const path = join(root, `.pending-${id}`);
    await mkdir(path, { mode: 0o700 });
    return { id, path, root, slug, project };
  }

  async publish(
    access: TaskReviewAccess,
    stage: Stage,
    manifest: Walkthrough,
    authorize: () => Promise<boolean>,
  ): Promise<void> {
    if (manifest.id !== stage.id)
      throw new Error('Walkthrough identity mismatch');
    const parsed = parseWalkthrough(manifest);
    const file = await open(join(stage.path, 'manifest.json'), 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(parsed));
      await file.sync();
    } finally {
      await file.close();
    }
    fsyncDirectorySync(stage.path);
    if (!stage.project.withCurrentRead)
      throw new Error('Project publication authority unavailable');
    await stage.project.withCurrentRead(async () => {
      if (this.slug(access) !== stage.slug) throw new Error('Project changed');
      const scope = join(stage.root, scopeKey(access));
      await directory(scope);
      fsyncDirectorySync(stage.root);
      if (!(await authorize()) || !access.write.beforeCommit())
        throw new TaskBrowserCaptureError('not-found', 'Task not found.');
      await rename(stage.path, join(scope, stage.id));
      fsyncDirectorySync(scope);
    });
  }

  async discard(stage: Stage): Promise<void> {
    await rm(stage.path, { recursive: true, force: true });
  }

  private async scope(access: TaskReviewAccess): Promise<string> {
    const files = this.deps.files();
    const slug = this.slug(access);
    const root = this.root(files, slug);
    for (const part of [dirname(root), root, join(root, scopeKey(access))]) {
      const stat = await lstat(part);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Invalid Walkthrough storage directory');
    }
    return join(root, scopeKey(access));
  }

  async get(access: TaskReviewAccess, id: string): Promise<Walkthrough | null> {
    if (!isWalkthroughId(id)) return null;
    try {
      const scope = await this.scope(access);
      const artifact = join(scope, id);
      const stat = await lstat(artifact);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Invalid Walkthrough artifact');
      const manifest = parseWalkthrough(
        JSON.parse(
          (
            await readBounded(
              join(artifact, 'manifest.json'),
              WALKTHROUGH_LIMITS.manifestBytes,
            )
          ).toString('utf8'),
        ),
      );
      if (
        manifest.id !== id ||
        !manifest.source.commit ||
        manifest.source.recording?.file !== 'recording.webm' ||
        manifest.source.recording.byteLength > BROWSER_RECORD_MAX_ENCODED_BYTES
      )
        throw new Error('Invalid Task Walkthrough');
      this.slug(access);
      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(
    access: TaskReviewAccess,
    limit = 25,
    cursor?: string,
  ): Promise<{ items: Walkthrough[]; nextCursor?: string }> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > WALKTHROUGH_LIMITS.listPage ||
      (cursor !== undefined && !isWalkthroughId(cursor))
    )
      throw new TaskBrowserCaptureError(
        'invalid-request',
        'Invalid Task Walkthrough page bounds.',
      );
    let names: string[];
    try {
      names = (await readdir(await this.scope(access)))
        .filter(isWalkthroughId)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { items: [] };
      throw error;
    }
    const page = names
      .filter((name) => !cursor || name > cursor)
      .slice(0, limit + 1);
    const manifests: Walkthrough[] = [];
    for (const id of page.slice(0, limit)) {
      const item = await this.get(access, id);
      if (!item) throw new Error('Task Walkthrough disappeared');
      manifests.push(item);
    }
    this.slug(access);
    return {
      items: manifests,
      ...(page.length > limit ? { nextCursor: page[limit - 1] } : {}),
    };
  }

  async video(access: TaskReviewAccess, id: string): Promise<Buffer | null> {
    const manifest = await this.get(access, id);
    if (!manifest?.source.recording) return null;
    const bytes = await readBounded(
      join(await this.scope(access), id, manifest.source.recording.file),
      manifest.source.recording.byteLength,
    );
    if (
      bytes.length !== manifest.source.recording.byteLength ||
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
        manifest.source.recording.digest
    )
      throw new Error('Task Walkthrough recording is corrupt');
    this.slug(access);
    return bytes;
  }

  async frame(
    access: TaskReviewAccess,
    id: string,
    frameId: string,
  ): Promise<Buffer | null> {
    const manifest = await this.get(access, id);
    const frame = manifest?.events.find(
      (event) => event.kind === 'frame' && event.frameId === frameId,
    );
    if (frame?.kind !== 'frame') return null;
    const bytes = await readBounded(
      join(await this.scope(access), id, frame.file),
      WALKTHROUGH_LIMITS.frameBytes,
    );
    this.slug(access);
    return bytes;
  }
}
