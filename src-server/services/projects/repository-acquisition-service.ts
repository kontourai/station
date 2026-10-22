import { mkdirSync } from 'node:fs';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { normalizeGitOrigin } from '@kontourai/station-contracts/git-remote-identity';
import type {
  ProjectRepositorySource,
  RepositoryAcquisition,
  RepositoryAcquisitionRequest,
} from '@kontourai/station-contracts/project';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';
import { execGit, isLocalGitSource } from '../../utils/git-exec.js';
import { JsonFileStore } from '../infra/json-store.js';
import { readCheckoutRemotes } from './checkout-remote-reader.js';
import { requireProjectRepository } from './git-read-repository.js';
import { checkRepositoryConfig } from './git-repository-config.js';

export const repositoryAcquisitionRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    sourceUrl: z.string().trim().min(1).max(2048),
    sourceRef: z.string().min(1).max(256).optional(),
    subdirectory: z.string().min(1).max(1024).optional(),
  })
  .strict();

const recordSchema = z
  .object({
    schemaVersion: z.literal(1),
    request: repositoryAcquisitionRequestSchema,
    phase: z.enum(['acquiring', 'ready', 'failed', 'cancelled']),
    attempt: z.number().int().positive(),
    checkoutPath: z.string().min(1),
    workingDirectory: z.string().min(1).optional(),
    resolvedCommit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
    canonicalRemote: z.string().min(1).optional(),
    error: z.string().max(256).optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export class RepositoryAcquisitionConflict extends Error {}
export class RepositoryAcquisitionInputError extends Error {}

function validateSource(request: RepositoryAcquisitionRequest): void {
  const source = request.sourceUrl;
  if (
    request.subdirectory &&
    (request.subdirectory
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.toLowerCase() === '.git',
      ) ||
      Array.from(request.subdirectory).some(
        (character) =>
          character === '\\' ||
          character === ':' ||
          character.charCodeAt(0) < 32 ||
          character.charCodeAt(0) === 127,
      ))
  )
    throw new RepositoryAcquisitionInputError(
      'Choose a repository-relative subdirectory without traversal or special characters.',
    );
  if (
    Array.from(source).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new RepositoryAcquisitionInputError(
      'Repository source contains control characters.',
    );
  if (isLocalGitSource(source)) {
    if (!isAbsolute(source))
      throw new RepositoryAcquisitionInputError(
        'A local mirror must use an absolute path.',
      );
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new RepositoryAcquisitionInputError('Repository URL is malformed.');
    }
    if (
      !['https:', 'ssh:'].includes(url.protocol) ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol === 'https:' && url.username) ||
      !url.hostname ||
      url.pathname === '/'
    ) {
      throw new RepositoryAcquisitionInputError(
        'Use an HTTPS or SSH repository URL without embedded credentials, query or fragment.',
      );
    }
  } else if (
    !/^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9.-]+:[a-zA-Z0-9._/-]+$/.test(source)
  ) {
    throw new RepositoryAcquisitionInputError(
      'Use an HTTPS or SSH repository URL, or an absolute local mirror path.',
    );
  }
  if (
    request.sourceRef &&
    (request.sourceRef.startsWith('-') ||
      Array.from(request.sourceRef).some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      ))
  ) {
    throw new RepositoryAcquisitionInputError(
      'Choose a branch or tag without whitespace or a leading dash.',
    );
  }
}

async function workingDirectory(
  record: RepositoryAcquisition,
): Promise<string> {
  const directory = record.request.subdirectory
    ? resolve(record.checkoutPath, record.request.subdirectory)
    : record.checkoutPath;
  const actual = await realpath(directory);
  const expected = resolve(
    await realpath(record.checkoutPath),
    record.request.subdirectory ?? '.',
  );
  if (actual !== expected || !(await lstat(directory)).isDirectory())
    throw new Error(
      'Repository subdirectory must be a real directory within the checkout.',
    );
  return directory;
}

/** Domain receipt owns clone outcome; Activity may project it but cannot replace it. */
export class RepositoryAcquisitionService {
  private readonly root: string;

  constructor(homeDir: string) {
    this.root = join(homeDir, 'repository-acquisitions');
  }

  private store(id: string) {
    z.string().uuid().parse(id);
    return new JsonFileStore<RepositoryAcquisition | null>(
      join(this.root, id, 'operation.json'),
      null,
      { onCorruption: 'throw', durableAtomicWrite: true, maxReadBytes: 16384 },
    );
  }

  private cancellation(id: string) {
    z.string().uuid().parse(id);
    return new JsonFileStore<{ cancelledAt: string } | null>(
      join(this.root, id, 'cancellation.json'),
      null,
      { onCorruption: 'throw', durableAtomicWrite: true, maxReadBytes: 2048 },
    );
  }

  async cancel(id: string): Promise<RepositoryAcquisition | null> {
    z.string().uuid().parse(id);
    if (!this.get(id)) return null;
    const release = await acquireFileMutationLockAsync(
      join(this.root, id, 'publication.mutation'),
    );
    try {
      const current = this.get(id);
      if (!current) return null;
      if (current.phase === 'ready')
        throw new RepositoryAcquisitionConflict(
          'A verified checkout is already available. Choose another source to set it aside; existing files are preserved.',
        );
      if (current.phase !== 'cancelled')
        this.cancellation(id).write({ cancelledAt: new Date().toISOString() });
      return this.get(id);
    } finally {
      await release();
    }
  }

  private async publish(
    record: RepositoryAcquisition,
  ): Promise<RepositoryAcquisition> {
    const id = record.request.requestId;
    const release = await acquireFileMutationLockAsync(
      join(this.root, id, 'publication.mutation'),
    );
    try {
      const current = this.get(id);
      if (current?.phase === 'cancelled') return current;
      this.store(id).write(record);
      return record;
    } finally {
      await release();
    }
  }

  get(id: string): RepositoryAcquisition | null {
    const value = this.store(id).read();
    if (value === null) return null;
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success)
      throw new Error('Repository acquisition receipt is corrupt.');
    const record = parsed.data;
    validateSource(record.request);
    if (
      record.request.requestId !== id ||
      record.checkoutPath !== join(this.root, id, `checkout-${record.attempt}`)
    ) {
      throw new Error(
        'Repository acquisition receipt does not match its owned directory.',
      );
    }
    if (
      record.phase === 'ready' &&
      (!record.resolvedCommit || !record.canonicalRemote)
    ) {
      throw new Error('Ready repository receipt is incomplete.');
    }
    const cancellation = this.cancellation(id).read();
    if (cancellation) {
      const { cancelledAt } = z
        .object({ cancelledAt: z.string().datetime() })
        .strict()
        .parse(cancellation);
      return { ...record, phase: 'cancelled', updatedAt: cancelledAt };
    }
    return record;
  }

  async projectSource(
    id: string,
    directory?: string,
  ): Promise<{
    workingDirectory: string;
    repositorySource: ProjectRepositorySource;
  }> {
    const record = this.get(id);
    if (
      record?.phase !== 'ready' ||
      !record.resolvedCommit ||
      !record.canonicalRemote
    ) {
      throw new RepositoryAcquisitionConflict(
        'Acquire and verify the repository before creating the Project.',
      );
    }
    const selectedDirectory = await workingDirectory(record).catch(() => {
      throw new RepositoryAcquisitionConflict(
        'The selected repository subdirectory is unavailable. Reacquire or choose a folder explicitly.',
      );
    });
    if (directory && resolve(directory) !== selectedDirectory) {
      throw new RepositoryAcquisitionConflict(
        'The selected directory no longer matches this acquisition.',
      );
    }
    try {
      const repository = await requireProjectRepository(
        record.checkoutPath,
        record.checkoutPath,
      );
      const checkout = await lstat(record.checkoutPath);
      if (
        !checkout.isDirectory() ||
        checkout.isSymbolicLink() ||
        repository.top !== (await realpath(record.checkoutPath))
      )
        throw new Error('Checkout root changed.');
      const config = await checkRepositoryConfig(record.checkoutPath, 'read');
      if (!config.ok) throw new Error('Checkout configuration was refused.');
      const options = {
        cwd: record.checkoutPath,
        timeout: 10000,
        env: { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' },
      };
      const commit = (
        await execGit(['rev-parse', '--verify', 'HEAD^{commit}'], options)
      ).stdout.trim();
      const indexDirectory = await mkdtemp(
        join(tmpdir(), 'station-acquisition-index-'),
      );
      let status: string;
      try {
        // A fresh index does not inherit assume-unchanged or skip-worktree bits.
        const indexedOptions = {
          ...options,
          env: {
            ...options.env,
            GIT_INDEX_FILE: join(indexDirectory, 'index'),
          },
        };
        await execGit(['read-tree', record.resolvedCommit], indexedOptions);
        status = (
          await execGit(
            [
              'status',
              '--porcelain=v1',
              '--untracked-files=normal',
              '--ignored=matching',
            ],
            indexedOptions,
          )
        ).stdout;
      } finally {
        await rm(indexDirectory, { recursive: true, force: true });
      }
      const remotes = await readCheckoutRemotes(record.checkoutPath);
      if (
        commit !== record.resolvedCommit ||
        status.trim() ||
        !remotes.ok ||
        !remotes.remotes.some(
          (remote) =>
            remote.name === 'origin' &&
            normalizeGitOrigin(remote.url) === record.canonicalRemote,
        )
      ) {
        throw new Error('Checkout no longer matches acquisition.');
      }
    } catch {
      throw new RepositoryAcquisitionConflict(
        'The acquired working copy changed or could not be verified. Reacquire it, or choose the folder explicitly. Existing files were preserved.',
      );
    }
    return {
      workingDirectory: selectedDirectory,
      repositorySource: {
        acquisitionId: record.request.requestId,
        attempt: record.attempt,
        sourceUrl: record.request.sourceUrl,
        ...(record.request.sourceRef
          ? { sourceRef: record.request.sourceRef }
          : {}),
        canonicalRemote: record.canonicalRemote,
        resolvedCommit: record.resolvedCommit,
        acquiredAt: record.updatedAt,
        ...(record.request.subdirectory
          ? { subdirectory: record.request.subdirectory }
          : {}),
      },
    };
  }

  async acquire(
    raw: RepositoryAcquisitionRequest,
    retry = false,
  ): Promise<RepositoryAcquisition> {
    const request = repositoryAcquisitionRequestSchema.parse(raw);
    validateSource(request);
    const directory = join(this.root, request.requestId);
    mkdirSync(directory, { recursive: true });
    const release = await acquireFileMutationLockAsync(
      join(directory, 'operation.mutation'),
    );
    try {
      const previous = this.get(request.requestId);
      if (previous && !isDeepStrictEqual(previous.request, request)) {
        throw new RepositoryAcquisitionConflict(
          'This request ID already names a different repository or ref.',
        );
      }
      if (
        previous &&
        (previous.phase === 'ready' || previous.phase === 'cancelled' || !retry)
      )
        return previous;
      const attempt = (previous?.attempt ?? 0) + 1;
      const checkoutPath = join(directory, `checkout-${attempt}`);
      const acquiring: RepositoryAcquisition = {
        schemaVersion: 1,
        request,
        phase: 'acquiring',
        attempt,
        checkoutPath,
        updatedAt: new Date().toISOString(),
      };
      const admitted = await this.publish(acquiring);
      if (admitted.phase === 'cancelled') return admitted;
      let ready: RepositoryAcquisition;
      try {
        const args = [
          '-c',
          'core.protectHFS=true',
          '-c',
          'core.protectNTFS=true',
          'clone',
          '--no-checkout',
          '--no-local',
        ];
        if (request.sourceRef) args.push('--branch', request.sourceRef);
        args.push('--', request.sourceUrl, checkoutPath);
        await execGit(args, {
          cwd: directory,
          timeout: 120000,
          hardening: { allowFileProtocol: isLocalGitSource(request.sourceUrl) },
        });
        const afterClone = this.get(request.requestId);
        if (afterClone?.phase === 'cancelled') return afterClone;
        const remotes = await readCheckoutRemotes(checkoutPath);
        const canonicalRemote = normalizeGitOrigin(request.sourceUrl);
        if (
          !remotes.ok ||
          !remotes.remotes.some(
            (remote) =>
              remote.name === 'origin' &&
              normalizeGitOrigin(remote.url) === canonicalRemote,
          )
        ) {
          throw new Error('Clone identity did not verify.');
        }
        const commit = (
          await execGit(['rev-parse', '--verify', 'HEAD^{commit}'], {
            cwd: checkoutPath,
            timeout: 10000,
          })
        ).stdout.trim();
        if (!/^[a-f0-9]{40,64}$/.test(commit))
          throw new Error('Commit could not be resolved.');
        const config = await checkRepositoryConfig(checkoutPath, 'read');
        if (!config.ok) throw new Error('Checkout configuration was refused.');
        await execGit(['checkout', '--detach', commit, '--'], {
          cwd: checkoutPath,
          timeout: 30000,
          // Acquisition materializes bytes; installed filters require separate setup consent.
          env: { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' },
        });
        const selectedDirectory = await workingDirectory(acquiring);
        ready = {
          ...acquiring,
          phase: 'ready',
          workingDirectory: selectedDirectory,
          resolvedCommit: commit,
          canonicalRemote,
          updatedAt: new Date().toISOString(),
        };
      } catch {
        const failed: RepositoryAcquisition = {
          ...acquiring,
          phase: 'failed',
          error:
            'Repository acquisition failed. Check source access and the requested branch or tag, then retry explicitly.',
          updatedAt: new Date().toISOString(),
        };
        return await this.publish(failed);
      }
      // A publication failure must preserve uncertainty about the completed clone.
      return await this.publish(ready);
    } finally {
      await release();
    }
  }
}
