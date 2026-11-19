import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  PROJECT_LIBRARY_LIST_MAX_UPLOADS,
  PROJECT_LIBRARY_UPLOAD_MAX_BYTES,
  type ProjectLibraryUpload,
  projectLibraryUploadPath,
} from '@kontourai/station-contracts/project-library';
import { isCanonicalPathStrictlyWithin } from '../../utils/path-containment.js';

/** A path the Library refuses: invalid, hidden, `node_modules`, or a link. */
export class ProjectLibraryPathError extends Error {}
export class ProjectLibraryNotFoundError extends Error {}
export class ProjectLibraryTooLargeError extends Error {}

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/;
const MEDIA_TYPES: Record<string, string> = {
  csv: 'text/csv',
  gif: 'image/gif',
  htm: 'text/html',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  webp: 'image/webp',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
};

function projectLibraryMediaType(relativePath: string): string {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return MEDIA_TYPES[extension] ?? 'application/octet-stream';
}

/**
 * The owner of files people add to a Project's Library (#5067). Each Project
 * has one folder under the Station home; the folder is the only copy. Nothing
 * here follows a symbolic link: a link inside the folder is neither listed nor
 * read, and a write never lands through one.
 */
export class ProjectLibraryUploads {
  private readonly root: string;

  constructor(input: { homeDir: string }) {
    this.root = join(resolve(input.homeDir), 'project-library');
  }

  /** The Project's Library folder, whether or not it exists yet. */
  folderFor(projectId: string): string {
    if (!PROJECT_ID.test(projectId))
      throw new ProjectLibraryPathError('Invalid Project id');
    return join(this.root, projectId);
  }

  async list(
    projectId: string,
  ): Promise<{ uploads: ProjectLibraryUpload[]; truncated: boolean }> {
    const folder = this.folderFor(projectId);
    const uploads: ProjectLibraryUpload[] = [];
    let truncated = false;
    const walk = async (directory: string, prefix: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (truncated) return;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        // Temporary writes and anything hidden or vendored stay out.
        if (!projectLibraryUploadPath(relativePath).ok) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute, relativePath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (uploads.length >= PROJECT_LIBRARY_LIST_MAX_UPLOADS) {
          truncated = true;
          return;
        }
        const info = await lstat(absolute).catch(() => undefined);
        if (!info?.isFile()) continue;
        uploads.push({
          kind: 'upload',
          relativePath,
          byteLength: info.size,
          mediaType: projectLibraryMediaType(relativePath),
          modifiedAt: info.mtime.toISOString(),
        });
      }
    };
    await walk(folder, '');
    return { uploads, truncated };
  }

  async write(
    projectId: string,
    relativePath: string,
    bytes: Uint8Array,
  ): Promise<ProjectLibraryUpload> {
    const path = this.parse(relativePath);
    if (bytes.byteLength > PROJECT_LIBRARY_UPLOAD_MAX_BYTES)
      throw new ProjectLibraryTooLargeError('Upload is too large');
    const folder = this.folderFor(projectId);
    const target = join(folder, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    // The parent chain must resolve inside the folder: a directory someone
    // replaced with a link would otherwise carry the write elsewhere.
    await this.assertInside(folder, dirname(target), true);
    const existing = await lstat(target).catch(() => undefined);
    if (existing && !existing.isFile())
      throw new ProjectLibraryPathError('Upload path is not a file');
    const temporary = join(dirname(target), `.upload-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx');
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    const info = await lstat(target);
    return {
      kind: 'upload',
      relativePath: path,
      byteLength: info.size,
      mediaType: projectLibraryMediaType(path),
      modifiedAt: info.mtime.toISOString(),
    };
  }

  async read(
    projectId: string,
    relativePath: string,
  ): Promise<{ upload: ProjectLibraryUpload; bytes: Buffer }> {
    const path = this.parse(relativePath);
    const folder = this.folderFor(projectId);
    const target = join(folder, ...path.split('/'));
    const info = await lstat(target).catch(() => undefined);
    if (!info?.isFile())
      throw new ProjectLibraryNotFoundError('Library file not found');
    await this.assertInside(folder, target, false);
    if (info.size > PROJECT_LIBRARY_UPLOAD_MAX_BYTES)
      throw new ProjectLibraryTooLargeError('Library file is too large');
    const handle = await open(target, 'r');
    let bytes: Buffer;
    try {
      // The handle's own size, not the earlier lstat: a file replaced in
      // between is read as it is now, still bounded.
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > PROJECT_LIBRARY_UPLOAD_MAX_BYTES)
        throw new ProjectLibraryNotFoundError('Library file not found');
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    return {
      upload: {
        kind: 'upload',
        relativePath: path,
        byteLength: bytes.byteLength,
        mediaType: projectLibraryMediaType(path),
        modifiedAt: info.mtime.toISOString(),
      },
      bytes,
    };
  }

  async remove(projectId: string, relativePath: string): Promise<void> {
    const path = this.parse(relativePath);
    const folder = this.folderFor(projectId);
    const target = join(folder, ...path.split('/'));
    const info = await lstat(target).catch(() => undefined);
    if (!info?.isFile())
      throw new ProjectLibraryNotFoundError('Library file not found');
    await this.assertInside(folder, target, false);
    await unlink(target);
    // Folders a removal emptied go too, up to (not including) the Library.
    let directory = dirname(target);
    while (directory !== folder && directory.startsWith(`${folder}${sep}`)) {
      try {
        await rmdir(directory);
      } catch {
        break;
      }
      directory = dirname(directory);
    }
  }

  private parse(relativePath: string): string {
    const parsed = projectLibraryUploadPath(relativePath);
    if (!parsed.ok) throw new ProjectLibraryPathError(parsed.reason);
    return parsed.path;
  }

  private async assertInside(
    folder: string,
    candidate: string,
    allowRoot: boolean,
  ): Promise<void> {
    const [root, resolved] = await Promise.all([
      realpath(folder),
      realpath(candidate),
    ]).catch(() => {
      throw new ProjectLibraryNotFoundError('Library file not found');
    });
    if (resolved === root && allowRoot) return;
    if (!isCanonicalPathStrictlyWithin(root, resolved))
      throw new ProjectLibraryPathError('Library path leaves the Library');
  }
}
