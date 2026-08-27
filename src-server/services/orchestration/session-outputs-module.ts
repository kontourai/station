import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { DeclaredOutputDescriptor } from '@kontourai/station-contracts/session-output-declaration';
import {
  SESSION_OUTPUTS_V1,
  type SessionOutputInspection,
  type SessionOutputItem,
  type SessionOutputsPage,
} from '@kontourai/station-contracts/session-outputs';
import { TASK_DECLARED_OUTPUT_KEEP_V1 } from '@kontourai/station-contracts/task-graph';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import {
  TaskDeclaredOutputKeepConflictError,
  TaskDeclaredOutputKeepDeletedError,
} from '../projects/task-graph-service.js';
import {
  TaskOutputConflictError,
  TaskOutputDeletedOperationError,
  type TaskOutputModule,
  TaskOutputUnavailableError,
} from '../projects/task-output-module.js';
import { isBoundedSafePng } from '../projects/workspace-file-preview-service.js';
import {
  bindGuardedDirectories,
  type GuardedDirectoryBinding,
  revalidateGuardedDirectories,
} from '../setup/guarded-setup-import-filesystem.js';
import type { DeclaredOutputDescriptorRow, EventStore } from './event-store.js';

export const SESSION_OUTPUTS_PAGE_MAX = 50;
export const SESSION_OUTPUTS_PAGE_MAX_BYTES = 64 * 1024;
const MAX_PREVIEW_TEXT_BYTES = 512 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN_MAX = 1_024;

type WorkspaceBinding = {
  root: string;
  rootDirectories: GuardedDirectoryBinding[];
};

export type SessionOutputsReadOutcome =
  | { status: 'found'; page: SessionOutputsPage }
  | { status: 'not-found' }
  | { status: 'unavailable' };
export type SessionOutputInspectOutcome =
  | { status: 'found'; inspection: SessionOutputInspection }
  | { status: 'not-found' }
  | { status: 'unavailable' };
export type SessionOutputKeepOutcome =
  | {
      status: 'kept';
      version: typeof TASK_DECLARED_OUTPUT_KEEP_V1;
      kind: 'workspace-file';
      outcome: 'kept' | 'already-kept';
      output: import('@kontourai/station-contracts').TaskOutputRecord;
    }
  | {
      status: 'kept';
      version: typeof TASK_DECLARED_OUTPUT_KEEP_V1;
      kind: 'pull-request';
      outcome: 'kept' | 'already-kept';
      reference: import('@kontourai/station-contracts').TaskKeptDeclaredPullRequest;
    }
  | { status: 'conflict' }
  | { status: 'deleted' }
  | { status: 'not-found' }
  | { status: 'unavailable' };

export interface SessionOutputsModule {
  list(input: {
    sessionId: string;
    cursor?: string;
    limit?: number;
    authority: SessionReadAuthority;
    current: () => boolean;
  }): Promise<SessionOutputsReadOutcome>;
  inspect(input: {
    sessionId: string;
    eventId: string;
    authority: SessionReadAuthority;
    current: () => boolean;
  }): Promise<SessionOutputInspectOutcome>;
  keep(input: {
    taskId: string;
    sessionId: string;
    eventId: string;
    operationId: string;
    taskWorkspace: string;
    authority: SessionReadAuthority;
    current: () => boolean;
    /** Route-owned Task/Project/workspace witness, rechecked under output lock. */
    canKeepForTask: () => boolean;
    outputs: TaskOutputModule;
    keepPullRequest: (input: {
      provider: string;
      host: string;
      repository: { owner: string; name: string };
      ref: string;
      nativeId: string;
      provenance: {
        sessionId: string;
        turnId: string;
        toolCallId: string;
        declarationId: string;
        eventId: string;
      };
    }) => Promise<
      import('@kontourai/station-contracts').TaskKeptDeclaredPullRequestOutcome
    >;
  }): Promise<SessionOutputKeepOutcome>;
}

function inside(root: string, child: string): boolean {
  const value = relative(root, child);
  return value !== '' && !value.startsWith('..') && !isAbsolute(value);
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max;
}

function parseDescriptor(value: unknown): DeclaredOutputDescriptor | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const descriptor = value as Record<string, unknown>;
  if (
    descriptor.kind === 'workspace-file' &&
    Object.keys(descriptor).every((key) =>
      ['kind', 'relativePath', 'digest', 'length', 'mediaType'].includes(key),
    ) &&
    bounded(descriptor.relativePath, 4096) &&
    !isAbsolute(descriptor.relativePath) &&
    !descriptor.relativePath.split(/[\\/]+/).includes('..') &&
    bounded(descriptor.digest, 64) &&
    SHA256.test(descriptor.digest) &&
    Number.isInteger(descriptor.length) &&
    (descriptor.length as number) >= 0 &&
    (descriptor.length as number) <= 5 * 1024 * 1024 &&
    (descriptor.mediaType === undefined || bounded(descriptor.mediaType, 160))
  )
    return {
      kind: 'workspace-file',
      relativePath: descriptor.relativePath,
      digest: descriptor.digest,
      length: descriptor.length as number,
      ...(typeof descriptor.mediaType === 'string'
        ? { mediaType: descriptor.mediaType }
        : {}),
    };
  if (
    descriptor.kind === 'pull-request' &&
    Object.keys(descriptor).every((key) =>
      ['kind', 'provider', 'host', 'repository', 'ref', 'nativeId'].includes(
        key,
      ),
    ) &&
    bounded(descriptor.provider, 128) &&
    bounded(descriptor.host, 512) &&
    bounded(descriptor.ref, 512) &&
    bounded(descriptor.nativeId, 512) &&
    descriptor.repository &&
    typeof descriptor.repository === 'object' &&
    !Array.isArray(descriptor.repository) &&
    Object.keys(descriptor.repository as object).every((key) =>
      ['owner', 'name'].includes(key),
    ) &&
    bounded((descriptor.repository as Record<string, unknown>).owner, 256) &&
    bounded((descriptor.repository as Record<string, unknown>).name, 256)
  )
    return {
      kind: 'pull-request',
      provider: descriptor.provider,
      host: descriptor.host,
      repository: {
        owner: (descriptor.repository as Record<string, string>).owner,
        name: (descriptor.repository as Record<string, string>).name,
      },
      ref: descriptor.ref,
      nativeId: descriptor.nativeId,
    };
  return undefined;
}

function item(row: DeclaredOutputDescriptorRow): SessionOutputItem | undefined {
  const descriptor = parseDescriptor(row.descriptor);
  if (
    !descriptor ||
    !bounded(row.eventId, 1024) ||
    !bounded(row.threadId, 1024) ||
    !bounded(row.turnId, 1024) ||
    !bounded(row.toolCallId, 1024) ||
    !bounded(row.declaredAt, 128)
  )
    return undefined;
  return {
    ref: { sessionId: row.threadId, eventId: row.eventId },
    turnId: row.turnId,
    toolCallId: row.toolCallId,
    declaredAt: row.declaredAt,
    ...(row.label && bounded(row.label, 240) ? { label: row.label } : {}),
    descriptor:
      descriptor.kind === 'workspace-file'
        ? descriptor
        : { ...descriptor, liveExternal: true },
  };
}

function authorityKey(authority: SessionReadAuthority): string {
  return `${authority.mode}:${authority.tenantExecutionContext?.tenantId ?? ''}:${authority.userId}`;
}

async function bindWorkspace(root: string): Promise<WorkspaceBinding> {
  const resolved = await realpath(root);
  return {
    root: resolved,
    rootDirectories: await bindGuardedDirectories(resolved),
  };
}

function jpegDimensions(
  bytes: Buffer,
): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    return undefined;
  for (let offset = 2; offset + 9 < bytes.length; ) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    if (marker === undefined) return undefined;
    if (marker === 0xd9 || marker === 0xda) break;
    const size = bytes.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > bytes.length) return undefined;
    if (marker >= 0xc0 && marker <= 0xc3) {
      const height = bytes.readUInt16BE(offset + 5),
        width = bytes.readUInt16BE(offset + 7);
      return width > 0 &&
        height > 0 &&
        width <= 8192 &&
        height <= 8192 &&
        width * height <= 16_000_000
        ? { width, height }
        : undefined;
    }
    offset += 2 + size;
  }
  return undefined;
}

async function inspectFile(
  workspace: WorkspaceBinding,
  descriptor: Extract<DeclaredOutputDescriptor, { kind: 'workspace-file' }>,
  base: SessionOutputItem,
): Promise<SessionOutputInspection> {
  await revalidateGuardedDirectories(workspace.root, workspace.rootDirectories);
  const target = resolve(workspace.root, descriptor.relativePath);
  if (!inside(workspace.root, target)) throw new Error('outside workspace');
  const parent = dirname(target);
  const parentDirectories = await bindGuardedDirectories(parent);
  const link = await lstat(target);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error('not regular');
  if (constants.O_NOFOLLOW === undefined) throw new Error('no no-follow');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.size !== descriptor.length ||
      before.size > 5 * 1024 * 1024
    )
      throw new Error('changed');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await file.stat();
    const final = await lstat(target);
    if (
      offset !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      final.isSymbolicLink() ||
      final.dev !== before.dev ||
      final.ino !== before.ino ||
      createHash('sha256').update(bytes).digest('hex') !== descriptor.digest
    )
      throw new Error('changed');
    await revalidateGuardedDirectories(parent, parentDirectories);
    await revalidateGuardedDirectories(
      workspace.root,
      workspace.rootDirectories,
    );
    if (isBoundedSafePng(bytes))
      return {
        version: SESSION_OUTPUTS_V1,
        item: base,
        kind: 'image',
        mediaType: 'image/png',
        data: bytes.toString('base64'),
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
      };
    const jpeg = jpegDimensions(bytes);
    if (jpeg)
      return {
        version: SESSION_OUTPUTS_V1,
        item: base,
        kind: 'image',
        mediaType: 'image/jpeg',
        data: bytes.toString('base64'),
        ...jpeg,
      };
    const declared = descriptor.mediaType?.toLowerCase() ?? '';
    if (
      !declared.includes('html') &&
      !declared.includes('svg') &&
      !declared.includes('pdf') &&
      bytes.length <= MAX_PREVIEW_TEXT_BYTES &&
      !bytes.some(
        (byte) => byte === 0 || byte < 0x08 || (byte > 0x0d && byte < 0x20),
      )
    ) {
      try {
        return {
          version: SESSION_OUTPUTS_V1,
          item: base,
          kind: 'text',
          text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        };
      } catch {
        /* inert metadata below */
      }
    }
    return { version: SESSION_OUTPUTS_V1, item: base, kind: 'metadata' };
  } finally {
    await file.close();
  }
}

export function createSessionOutputsModule(input: {
  eventStore?: Pick<
    EventStore,
    | 'listDeclaredOutputDescriptors'
    | 'readDeclaredOutputDescriptor'
    | 'readSessionByThread'
    | 'issueDeclaredOutputCursor'
    | 'readDeclaredOutputCursor'
  >;
  canReadSession: (
    sessionId: string,
    authority: SessionReadAuthority,
  ) => boolean;
  workspaceForSession: (sessionId: string) => string | undefined;
  pullRequestResolver?: {
    readCurrent(input: {
      provider: string;
      host: string;
      owner: string;
      repository: string;
      ref: string;
      nativeId: string;
      workingDirectory: string;
    }): Promise<Extract<
      DeclaredOutputDescriptor,
      { kind: 'pull-request' }
    > | null>;
  };
}): SessionOutputsModule {
  const permitted = (
    sessionId: string,
    authority: SessionReadAuthority,
    current: () => boolean,
  ) => current() && input.canReadSession(sessionId, authority);
  return {
    async list(request) {
      if (!permitted(request.sessionId, request.authority, request.current))
        return { status: 'not-found' };
      if (
        !input.eventStore ||
        (request.cursor && !bounded(request.cursor, TOKEN_MAX))
      )
        return { status: 'unavailable' };
      const cursor = request.cursor
        ? input.eventStore.readDeclaredOutputCursor(request.cursor)
        : undefined;
      const key = authorityKey(request.authority);
      if (
        (request.cursor && !cursor) ||
        (cursor &&
          (cursor.sessionId !== request.sessionId ||
            cursor.authority !== key ||
            !bounded(cursor.declarationId, 1024)))
      )
        return { status: 'unavailable' };
      try {
        const page = input.eventStore.listDeclaredOutputDescriptors({
          threadId: request.sessionId,
          highWater: cursor?.highWater,
          after: cursor
            ? { sequence: cursor.sequence, declarationId: cursor.declarationId }
            : undefined,
          limit: Math.min(
            request.limit ?? SESSION_OUTPUTS_PAGE_MAX,
            SESSION_OUTPUTS_PAGE_MAX,
          ),
        });
        if (!permitted(request.sessionId, request.authority, request.current))
          return { status: 'not-found' };
        const items: SessionOutputItem[] = [];
        let partial = false;
        let last = cursor
          ? { sequence: cursor.sequence, declarationId: cursor.declarationId }
          : undefined;
        let stoppedForBytes = false;
        for (const row of page.rows) {
          const candidate = item(row);
          if (!candidate) {
            partial = true;
            last = { sequence: row.sequence, declarationId: row.declarationId };
            continue;
          }
          const candidateItems = [...items, candidate];
          const candidateCursor = input.eventStore.issueDeclaredOutputCursor({
            sessionId: request.sessionId,
            authority: key,
            highWater: page.highWater,
            sequence: row.sequence,
            declarationId: row.declarationId,
          });
          const measured: SessionOutputsPage = {
            version: SESSION_OUTPUTS_V1,
            items: candidateItems,
            partial,
            cursor: candidateCursor,
          };
          if (
            Buffer.byteLength(JSON.stringify(measured), 'utf8') >
            SESSION_OUTPUTS_PAGE_MAX_BYTES
          ) {
            if (items.length === 0) return { status: 'unavailable' };
            stoppedForBytes = true;
            break;
          }
          items.push(candidate);
          last = { sequence: row.sequence, declarationId: row.declarationId };
        }
        const hasMore = stoppedForBytes || page.hasMore;
        const next =
          hasMore && last
            ? input.eventStore.issueDeclaredOutputCursor({
                sessionId: request.sessionId,
                authority: key,
                highWater: page.highWater,
                sequence: last.sequence,
                declarationId: last.declarationId,
              })
            : undefined;
        const result: SessionOutputsPage = {
          version: SESSION_OUTPUTS_V1,
          items,
          partial,
          ...(next ? { cursor: next } : {}),
        };
        return { status: 'found', page: result };
      } catch {
        return { status: 'unavailable' };
      }
    },
    async inspect(request) {
      if (
        !permitted(request.sessionId, request.authority, request.current) ||
        !input.eventStore
      )
        return { status: 'not-found' };
      try {
        const row = input.eventStore.readDeclaredOutputDescriptor(
          request.sessionId,
          request.eventId,
        );
        const candidate = row && item(row);
        if (
          !row ||
          !candidate ||
          candidate.ref.eventId !== request.eventId ||
          !permitted(request.sessionId, request.authority, request.current)
        )
          return { status: 'not-found' };
        if (candidate.descriptor.kind === 'pull-request')
          return {
            status: 'found',
            inspection: {
              version: SESSION_OUTPUTS_V1,
              item: candidate,
              kind: 'metadata',
            },
          };
        const root = input.workspaceForSession(request.sessionId);
        if (!root) return { status: 'unavailable' };
        const workspace = await bindWorkspace(root);
        const inspection = await inspectFile(
          workspace,
          candidate.descriptor,
          candidate,
        );
        return permitted(request.sessionId, request.authority, request.current)
          ? { status: 'found', inspection }
          : { status: 'not-found' };
      } catch {
        return { status: 'unavailable' };
      }
    },
    async keep(request) {
      if (
        !permitted(request.sessionId, request.authority, request.current) ||
        !request.canKeepForTask() ||
        !input.eventStore
      )
        return { status: 'not-found' };
      try {
        const row = input.eventStore.readDeclaredOutputDescriptor(
          request.sessionId,
          request.eventId,
        );
        const candidate = row && item(row);
        // The durable row and its owner-issued event id are the association;
        // never accept a syntactically similar descriptor supplied by a route.
        if (
          !row ||
          !candidate ||
          candidate.ref.sessionId !== request.sessionId ||
          candidate.ref.eventId !== request.eventId ||
          !permitted(request.sessionId, request.authority, request.current) ||
          !request.canKeepForTask()
        )
          return { status: 'not-found' };
        const root = input.workspaceForSession(request.sessionId);
        // Both owners must still name the same workspace. A Task cannot use a
        // Session declaration as a cross-project file capability.
        if (!root || resolve(root) !== resolve(request.taskWorkspace))
          return { status: 'not-found' };
        const descriptor = candidate.descriptor;
        if (descriptor.kind === 'pull-request') {
          const current = await input.pullRequestResolver?.readCurrent({
            provider: descriptor.provider,
            host: descriptor.host,
            owner: descriptor.repository.owner,
            repository: descriptor.repository.name,
            ref: descriptor.ref,
            nativeId: descriptor.nativeId,
            workingDirectory: root,
          });
          if (
            !current ||
            JSON.stringify(current) !==
              JSON.stringify({
                kind: 'pull-request',
                provider: descriptor.provider,
                host: descriptor.host,
                repository: descriptor.repository,
                ref: descriptor.ref,
                nativeId: descriptor.nativeId,
              }) ||
            !permitted(request.sessionId, request.authority, request.current) ||
            !request.canKeepForTask()
          )
            return { status: 'not-found' };
          const result = await request.keepPullRequest({
            provider: descriptor.provider,
            host: descriptor.host,
            repository: { ...descriptor.repository },
            ref: descriptor.ref,
            nativeId: descriptor.nativeId,
            provenance: {
              sessionId: request.sessionId,
              turnId: candidate.turnId,
              toolCallId: candidate.toolCallId,
              declarationId: row.declarationId,
              eventId: request.eventId,
            },
          });
          return permitted(
            request.sessionId,
            request.authority,
            request.current,
          ) && request.canKeepForTask()
            ? {
                status: 'kept',
                version: TASK_DECLARED_OUTPUT_KEEP_V1,
                kind: 'pull-request',
                outcome: result.outcome,
                reference: result.reference,
              }
            : { status: 'not-found' };
        }
        const kept = await request.outputs.createDeclared(request.taskId, {
          operationId: request.operationId,
          title: candidate.label ?? basename(descriptor.relativePath),
          sourceWorkspace: root,
          relativePath: descriptor.relativePath,
          digest: descriptor.digest,
          length: descriptor.length,
          ...(descriptor.mediaType
            ? { declaredMediaType: descriptor.mediaType }
            : {}),
          fingerprintContext: JSON.stringify({
            sessionId: request.sessionId,
            eventId: request.eventId,
            turnId: candidate.turnId,
            toolCallId: candidate.toolCallId,
            descriptor,
          }),
          isAuthorized: () =>
            permitted(request.sessionId, request.authority, request.current) &&
            request.canKeepForTask(),
        });
        return permitted(
          request.sessionId,
          request.authority,
          request.current,
        ) && request.canKeepForTask()
          ? {
              status: 'kept',
              version: TASK_DECLARED_OUTPUT_KEEP_V1,
              kind: 'workspace-file',
              outcome: kept.outcome,
              output: kept.output,
            }
          : { status: 'not-found' };
      } catch (error) {
        // The public route deliberately collapses source absence, changed
        // bytes, revoked owner access and hostile paths to the candidate's
        // ordinary non-disclosure outcome. Storage faults remain retryable.
        // Error classes are themselves sensitive capability facts. Recheck
        // the request lease and the exact durable candidate synchronously
        // before classifying them; there is no await after this decision.
        const currentRow = input.eventStore?.readDeclaredOutputDescriptor(
          request.sessionId,
          request.eventId,
        );
        const currentCandidate = currentRow && item(currentRow);
        if (
          !permitted(request.sessionId, request.authority, request.current) ||
          !request.canKeepForTask() ||
          !currentCandidate ||
          currentCandidate.ref.sessionId !== request.sessionId ||
          currentCandidate.ref.eventId !== request.eventId
        )
          return { status: 'not-found' };
        if (
          error instanceof TaskOutputConflictError ||
          error instanceof TaskDeclaredOutputKeepConflictError
        )
          return { status: 'conflict' };
        if (
          error instanceof TaskOutputDeletedOperationError ||
          error instanceof TaskDeclaredOutputKeepDeletedError
        )
          return { status: 'deleted' };
        return error instanceof TaskOutputUnavailableError
          ? { status: 'unavailable' }
          : { status: 'not-found' };
      }
    },
  };
}
