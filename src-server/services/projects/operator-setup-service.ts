import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { OperatorSetupReceipt } from '@kontourai/station-contracts/project';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';
import { childProcessEnvironment } from '../../utils/child-process-environment.js';
import { execGit } from '../../utils/git-exec.js';
import { runInProcessGroup } from '../../utils/process-group-exec.js';
import { JsonFileStore } from '../infra/json-store.js';
import { readProjectRepository } from './git-read-repository.js';

export const operatorSetupPreviewSchema = z
  .object({
    id: z.string().uuid(),
    expectedProjectId: z.string().min(1),
    command: z.string().trim().min(1).max(4096),
    timeoutSeconds: z.number().int().min(1).max(600).default(30),
    inputPaths: z.array(z.string().min(1).max(512)).min(1).max(32),
  })
  .strict();

const receiptSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().min(1),
    projectSlug: z.string().min(1),
    cwd: z.string().min(1),
    command: z.string().min(1).max(4096),
    timeoutSeconds: z.number().int().min(1).max(600),
    inputs: z
      .array(
        z
          .object({
            path: z.string().min(1).max(512),
            sha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    phase: z.enum(['previewed', 'running', 'succeeded', 'failed']),
    updatedAt: z.string().datetime(),
    exitCode: z.number().int().optional(),
    observedDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export class OperatorSetupConflict extends Error {}
type Preview = z.input<typeof operatorSetupPreviewSchema>;
type Context = { projectId: string; cwd: string };
const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

/** The command is trusted operator code, bounded in time/output, not sandboxed. */
export class OperatorSetupService {
  private readonly active = new Set<string>();
  constructor(
    private readonly home: string,
    private readonly resolveContext: (slug: string) => Promise<Context>,
    private readonly projectId: (slug: string) => string,
  ) {}

  private store(id: string) {
    z.string().uuid().parse(id);
    return new JsonFileStore<OperatorSetupReceipt | null>(
      join(this.home, 'operator-setup', `${id}.json`),
      null,
      { onCorruption: 'throw', durableAtomicWrite: true, maxReadBytes: 65536 },
    );
  }

  private publish(receipt: OperatorSetupReceipt, reserve = 0) {
    if (
      Buffer.byteLength(JSON.stringify(receipt, null, 2), 'utf8') + reserve >
      65536
    )
      throw new OperatorSetupConflict(
        'Setup preview is too large to retain safely. Shorten the command or input list.',
      );
    this.store(receipt.id).write(receipt);
  }

  private read(id: string): OperatorSetupReceipt | null {
    const record = this.store(id).read();
    if (record === null) return null;
    const parsed = receiptSchema.parse(record);
    if (parsed.id !== id)
      throw new OperatorSetupConflict(
        'Setup receipt identity does not match its operation.',
      );
    return parsed;
  }

  private async observe(slug: string, expectedId: string, paths: string[]) {
    const context = await this.resolveContext(slug);
    if (context.projectId !== expectedId)
      throw new OperatorSetupConflict(
        'Project identity changed. Preview setup again.',
      );
    const cwd = await realpath(context.cwd);
    const inputs: OperatorSetupReceipt['inputs'] = [];
    let total = 0;
    for (const path of paths) {
      if (
        isAbsolute(path) ||
        path
          .split(/[\\/]/)
          .some(
            (p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git',
          )
      )
        throw new OperatorSetupConflict(
          'Choose execution-directory-relative input files without traversal or .git.',
        );
      const target = resolve(cwd, path);
      let sha256: string | null = null;
      try {
        const canonical = await realpath(target);
        const inside = relative(cwd, canonical);
        if (
          !inside ||
          inside === '..' ||
          inside.startsWith(`..${sep}`) ||
          isAbsolute(inside)
        )
          throw new OperatorSetupConflict(
            'Setup inputs must remain inside the execution root.',
          );
        const file = await open(
          canonical,
          constants.O_RDONLY |
            (constants.O_NOFOLLOW ?? 0) |
            (constants.O_NONBLOCK ?? 0),
        );
        try {
          const stat = await file.stat();
          total += stat.size;
          if (
            !stat.isFile() ||
            stat.size > 1024 * 1024 ||
            total > 8 * 1024 * 1024
          )
            throw new OperatorSetupConflict(
              'Setup inputs must be regular files, at most 1 MiB each and 8 MiB total.',
            );
          const bytes = Buffer.alloc(stat.size + 1);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead !== stat.size)
            throw new OperatorSetupConflict(
              'Setup input changed while reading. Preview again.',
            );
          sha256 = digest(bytes.subarray(0, bytesRead));
        } finally {
          await file.close();
        }
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
      inputs.push({ path, sha256 });
    }
    const source = await readProjectRepository(
      cwd,
      cwd,
      { timeoutMs: 10000 },
      async (repository) =>
        (
          await execGit(
            [...repository.repoArgs, 'rev-parse', '--verify', 'HEAD^{commit}'],
            { cwd: repository.top, timeout: 10000 },
          )
        ).stdout.trim(),
    );
    if (!source.ok)
      throw new OperatorSetupConflict(
        'Setup requires a readable verified repository.',
      );
    const current = await this.resolveContext(slug);
    if (
      current.projectId !== expectedId ||
      (await realpath(current.cwd)) !== cwd
    )
      throw new OperatorSetupConflict(
        'Project execution root changed. Preview setup again.',
      );
    return {
      cwd,
      inputs,
      sourceCommit: source.value,
      inputDigest: digest(
        JSON.stringify({ cwd, inputs, sourceCommit: source.value }),
      ),
    };
  }

  async preview(slug: string, raw: Preview, assertCurrent: () => void) {
    if (process.platform === 'win32')
      throw new OperatorSetupConflict(
        'Reviewed setup requires POSIX process groups on this host. Use the operator terminal on Windows.',
      );
    const request = operatorSetupPreviewSchema.parse(raw);
    const observed = await this.observe(
      slug,
      request.expectedProjectId,
      request.inputPaths,
    );
    await mkdir(dirname(storePath(this.home, request.id)), { recursive: true });
    const release = await acquireFileMutationLockAsync(
      join(this.home, 'operator-setup', 'registry.mutation'),
    );
    try {
      const existing = this.read(request.id);
      if (existing) {
        if (
          existing.projectId !== request.expectedProjectId ||
          existing.projectSlug !== slug ||
          existing.command !== request.command ||
          existing.timeoutSeconds !== request.timeoutSeconds ||
          existing.inputDigest !== observed.inputDigest
        )
          throw new OperatorSetupConflict(
            'This setup ID already names another preview. Create a new preview.',
          );
        assertCurrent();
        return this.get(slug, request.id, assertCurrent);
      }
      const directory = await opendir(join(this.home, 'operator-setup'));
      let count = 0;
      for await (const entry of directory) {
        if (entry.name.endsWith('.json') && ++count >= 1000)
          throw new OperatorSetupConflict(
            'The retained setup history limit was reached. No command was started.',
          );
      }
      const receipt: OperatorSetupReceipt = {
        id: request.id,
        projectId: request.expectedProjectId,
        projectSlug: slug,
        command: request.command,
        timeoutSeconds: request.timeoutSeconds,
        ...observed,
        phase: 'previewed',
        updatedAt: new Date().toISOString(),
      };
      assertCurrent();
      this.publish(receipt, 1024);
      return receipt;
    } finally {
      await release();
    }
  }

  async get(
    slug: string,
    id: string,
    assertCurrent: () => void,
  ): Promise<OperatorSetupReceipt> {
    const receipt = this.read(id);
    if (!receipt || receipt.projectSlug !== slug)
      throw new OperatorSetupConflict(
        'Setup preview not found for this Project.',
      );
    if (this.projectId(slug) !== receipt.projectId)
      throw new OperatorSetupConflict('Project identity changed.');
    assertCurrent();
    if (receipt.phase === 'running')
      return this.active.has(id) ? receipt : { ...receipt, phase: 'uncertain' };
    if (receipt.phase === 'failed') return receipt;
    let observed: Awaited<ReturnType<OperatorSetupService['observe']>>;
    try {
      observed = await this.observe(
        slug,
        receipt.projectId,
        receipt.inputs.map((i) => i.path),
      );
    } catch {
      assertCurrent();
      if (this.projectId(slug) !== receipt.projectId)
        throw new OperatorSetupConflict('Project identity changed.');
      return { ...receipt, phase: 'stale' };
    }
    assertCurrent();
    if (
      (receipt.phase === 'previewed' &&
        observed.inputDigest !== receipt.inputDigest) ||
      (receipt.phase === 'succeeded' &&
        observed.inputDigest !== receipt.observedDigest)
    )
      return { ...receipt, phase: 'stale' };
    return receipt;
  }

  async run(
    slug: string,
    id: string,
    assertCurrent: () => void,
  ): Promise<OperatorSetupReceipt> {
    const saved = this.read(id);
    if (!saved || saved.projectSlug !== slug)
      throw new OperatorSetupConflict(
        'Setup preview not found for this Project.',
      );
    const lock = join(
      this.home,
      'operator-setup',
      `project-${digest(saved.projectId)}.mutation`,
    );
    const release = await acquireFileMutationLockAsync(lock);
    try {
      const current = await this.get(slug, id, assertCurrent);
      if (current.phase !== 'previewed') return current;
      const running: OperatorSetupReceipt = {
        ...current,
        phase: 'running',
        updatedAt: new Date().toISOString(),
      };
      assertCurrent();
      this.publish(running, 1024);
      this.active.add(id);
      let phase: 'succeeded' | 'failed' = 'succeeded';
      let exitCode = 0;
      try {
        assertCurrent();
        await runInProcessGroup(
          process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
          process.platform === 'win32'
            ? ['/d', '/s', '/c', running.command]
            : ['-c', running.command],
          {
            cwd: running.cwd,
            env: childProcessEnvironment(),
            timeout: running.timeoutSeconds * 1000,
            maxBuffer: 1024 * 1024,
            retireDescendantsOnExit: true,
          },
        );
      } catch (error) {
        phase = 'failed';
        exitCode =
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'number'
            ? error.code
            : -1;
      }
      // Preserve observed completion even if the browser disconnects. Never replay a started effect.
      let observedDigest: string | undefined;
      try {
        observedDigest = (
          await this.observe(
            slug,
            current.projectId,
            current.inputs.map((i) => i.path),
          )
        ).inputDigest;
      } catch {
        /* Completion is real; freshness could not be established. */
      }
      const receipt: OperatorSetupReceipt = {
        ...running,
        phase,
        exitCode,
        ...(observedDigest ? { observedDigest } : {}),
        updatedAt: new Date().toISOString(),
      };
      this.publish(receipt);
      return receipt;
    } finally {
      this.active.delete(id);
      await release();
    }
  }
}

function storePath(home: string, id: string) {
  return join(home, 'operator-setup', `${id}.json`);
}
