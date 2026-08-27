import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  TaskDeclaredOutputKeepConflictError,
  TaskDeclaredOutputKeepDeletedError,
} from '../../projects/task-graph-service.js';
import {
  TaskOutputConflictError,
  TaskOutputDeletedOperationError,
} from '../../projects/task-output-module.js';
import { EventStore } from '../event-store.js';
import { createSessionOutputsModule } from '../session-outputs-module.js';

const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    ),
);
const authority = sessionReadAuthorityFromRequest(
  'owner',
  undefined,
  undefined,
);
function row(
  index: number,
  descriptor: unknown = {
    kind: 'workspace-file',
    relativePath: `reports/${index}.txt`,
    digest: 'a'.repeat(64),
    length: 2,
    mediaType: 'text/plain',
  },
) {
  return {
    declarationId: `declaration-${String(index).padStart(3, '0')}`,
    eventId: `event-${index}`,
    threadId: 'session-a',
    turnId: 'turn-a',
    toolCallId: `call-${index}`,
    declaredAt: '2026-08-26T00:00:00.000Z',
    descriptor,
    sequence: index + 1,
  };
}
function source(rows: ReturnType<typeof row>[]) {
  return {
    listDeclaredOutputDescriptors: vi.fn(
      (input: {
        highWater?: number;
        after?: { sequence: number; declarationId: string };
        limit: number;
      }) => {
        const highWater = input.highWater ?? rows.at(-1)?.sequence ?? 0;
        const selected = rows.filter(
          (candidate) =>
            candidate.sequence <= highWater &&
            (!input.after ||
              candidate.sequence > input.after.sequence ||
              (candidate.sequence === input.after.sequence &&
                candidate.declarationId > input.after.declarationId)),
        );
        return {
          rows: selected.slice(0, input.limit),
          highWater,
          hasMore: selected.length > input.limit,
        };
      },
    ),
    readDeclaredOutputDescriptor: vi.fn((_sessionId: string, eventId: string) =>
      rows.find((candidate) => candidate.eventId === eventId),
    ),
    readSessionByThread: vi.fn(),
    issueDeclaredOutputCursor: vi.fn((cursor: unknown) =>
      Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url'),
    ),
    readDeclaredOutputCursor: vi.fn((cursor: string) => {
      try {
        return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      } catch {
        return undefined;
      }
    }),
  };
}

describe('SessionOutputsModule', () => {
  test('rejects forged or cross-authority cursors while preserving a real cursor over restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-output-cursor-'));
    directories.push(root);
    const first = new EventStore(join(root, 'orchestration.sqlite'));
    const cursor = first.issueDeclaredOutputCursor({
      sessionId: 'session-a',
      authority: 'personal::owner',
      highWater: 2,
      sequence: 1,
      declarationId: 'declaration-001',
    });
    first.close();
    const restarted = new EventStore(join(root, 'orchestration.sqlite'));
    expect(restarted.readDeclaredOutputCursor(cursor)).toMatchObject({
      highWater: 2,
      sequence: 1,
    });
    expect(restarted.readDeclaredOutputCursor(`${cursor}x`)).toBeUndefined();
    restarted.close();
  });

  test('rejects a real signed future cursor after restart or a lower-water restore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-output-cursor-water-'));
    directories.push(root);
    const path = join(root, 'orchestration.sqlite');
    const first = new EventStore(path);
    const cursor = first.issueDeclaredOutputCursor({
      sessionId: 'session-a',
      authority: 'personal::owner',
      highWater: 1_000_000,
      sequence: 999_999,
      declarationId: 'declaration-future',
    });
    first.close();
    const restored = new EventStore(path);
    const module = createSessionOutputsModule({
      eventStore: restored,
      canReadSession: () => true,
      workspaceForSession: () => undefined,
    });
    await expect(
      module.list({
        sessionId: 'session-a',
        cursor,
        authority,
        current: () => true,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    restored.close();
  });

  test('paginates 128 exact candidates with a stable high-water and no duplicates', async () => {
    const store = source(Array.from({ length: 128 }, (_, index) => row(index)));
    const module = createSessionOutputsModule({
      eventStore: store as any,
      canReadSession: () => true,
      workspaceForSession: () => undefined,
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await module.list({
        sessionId: 'session-a',
        cursor,
        limit: 50,
        authority,
        current: () => true,
      });
      expect(result.status).toBe('found');
      if (result.status !== 'found') return;
      seen.push(...result.page.items.map((candidate) => candidate.ref.eventId));
      cursor = result.page.cursor;
    } while (cursor);
    expect(seen).toHaveLength(128);
    expect(new Set(seen)).toHaveLength(128);
    expect(store.listDeclaredOutputDescriptors).toHaveBeenCalledTimes(3);
  });

  test('stops before the 64KiB page ceiling and resumes every 4KiB descriptor', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      ...row(index),
      label: 'x'.repeat(4 * 1024),
    }));
    const module = createSessionOutputsModule({
      eventStore: source(rows) as any,
      canReadSession: () => true,
      workspaceForSession: () => undefined,
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const outcome = await module.list({
        sessionId: 'session-a',
        cursor,
        limit: 50,
        authority,
        current: () => true,
      });
      expect(outcome.status).toBe('found');
      if (outcome.status !== 'found') return;
      expect(
        Buffer.byteLength(JSON.stringify(outcome.page), 'utf8'),
      ).toBeLessThanOrEqual(64 * 1024);
      seen.push(...outcome.page.items.map((value) => value.ref.eventId));
      cursor = outcome.page.cursor;
    } while (cursor);
    expect(seen).toEqual(rows.map((value) => value.eventId));
  });

  test('withholds corrupt descriptors without inventing a count and keeps later rows reachable', async () => {
    const store = source([row(0, { corrupt: true }), row(1)]);
    const module = createSessionOutputsModule({
      eventStore: store as any,
      canReadSession: () => true,
      workspaceForSession: () => undefined,
    });
    const result = await module.list({
      sessionId: 'session-a',
      authority,
      current: () => true,
    });
    expect(result).toMatchObject({ status: 'found', page: { partial: true } });
    if (result.status === 'found')
      expect(result.page.items.map((item) => item.ref.eventId)).toEqual([
        'event-1',
      ]);
  });

  test.each(['caller', 'session'] as const)(
    'withholds a %s revocation around inspection I/O',
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), 'station-output-inspection-'));
      directories.push(root);
      writeFileSync(join(root, 'report.txt'), 'ok');
      const store = source([
        row(0, {
          kind: 'workspace-file',
          relativePath: 'report.txt',
          digest:
            '2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df',
          length: 2,
          mediaType: 'text/plain',
        }),
      ]);
      (store.readDeclaredOutputDescriptor as any).mockReturnValueOnce({
        ...row(0),
        descriptor: {
          kind: 'workspace-file',
          relativePath: 'report.txt',
          digest:
            '2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df',
          length: 2,
        },
      });
      let current = true,
        readable = true;
      const module = createSessionOutputsModule({
        eventStore: store as any,
        canReadSession: () => readable,
        workspaceForSession: () => root,
      });
      if (kind === 'caller') current = false;
      else readable = false;
      await expect(
        module.inspect({
          sessionId: 'session-a',
          eventId: 'event-0',
          authority,
          current: () => current,
        }),
      ).resolves.toEqual({ status: 'not-found' });
    },
  );

  test('loads an exact current text descriptor only through explicit inspection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-output-inspection-'));
    directories.push(root);
    writeFileSync(join(root, 'report.txt'), 'ok');
    const store = source([
      row(0, {
        kind: 'workspace-file',
        relativePath: 'report.txt',
        digest:
          '2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df',
        length: 2,
        mediaType: 'text/plain',
      }),
    ]);
    const module = createSessionOutputsModule({
      eventStore: store as any,
      canReadSession: () => true,
      workspaceForSession: () => root,
    });
    const list = await module.list({
      sessionId: 'session-a',
      authority,
      current: () => true,
    });
    expect(list.status).toBe('found');
    await expect(
      module.inspect({
        sessionId: 'session-a',
        eventId: 'event-0',
        authority,
        current: () => true,
      }),
    ).resolves.toMatchObject({
      status: 'found',
      inspection: { kind: 'text', text: 'ok' },
    });
  });

  test('keeps only an exact file declaration in the Task-owned workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-output-keep-'));
    directories.push(root);
    const store = source([row(0)]);
    const outputs = {
      createDeclared: vi.fn(async () => ({
        outcome: 'kept' as const,
        output: { id: 'output-a' },
      })),
    };
    const module = createSessionOutputsModule({
      eventStore: store as any,
      canReadSession: () => true,
      workspaceForSession: () => root,
    });
    await expect(
      module.keep({
        taskId: 'task-a',
        sessionId: 'session-a',
        eventId: 'event-0',
        operationId: 'operation-a',
        taskWorkspace: join(root, 'other'),
        authority,
        current: () => true,
        canKeepForTask: () => true,
        outputs: outputs as any,
        keepPullRequest: vi.fn(),
      }),
    ).resolves.toEqual({ status: 'not-found' });
    expect(outputs.createDeclared).not.toHaveBeenCalled();
    await expect(
      module.keep({
        taskId: 'task-a',
        sessionId: 'session-a',
        eventId: 'event-0',
        operationId: 'operation-a',
        taskWorkspace: root,
        authority,
        current: () => true,
        canKeepForTask: () => true,
        outputs: outputs as any,
        keepPullRequest: vi.fn(),
      }),
    ).resolves.toMatchObject({ status: 'kept', output: { id: 'output-a' } });
    expect(outputs.createDeclared).toHaveBeenCalledWith(
      'task-a',
      expect.objectContaining({
        digest: 'a'.repeat(64),
        length: 2,
        relativePath: 'reports/0.txt',
      }),
    );
  });

  test('re-authorizes an exact PR identity and retains no provider body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-output-pr-keep-'));
    directories.push(root);
    const descriptor = {
      kind: 'pull-request' as const,
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'owner', name: 'repo' },
      ref: '42',
      nativeId: 'PR_kw',
    };
    const resolver = { readCurrent: vi.fn(async () => descriptor) };
    const keepPullRequest = vi.fn(async (input: any) => ({
      outcome: 'kept' as const,
      reference: {
        schemaVersion: 1,
        taskId: 'task-a',
        ...input,
        keptAt: '2026-08-26T00:00:00.000Z',
      },
    }));
    const module = createSessionOutputsModule({
      eventStore: source([row(0, descriptor)]) as any,
      canReadSession: () => true,
      workspaceForSession: () => root,
      pullRequestResolver: resolver,
    });
    await expect(
      module.keep({
        taskId: 'task-a',
        sessionId: 'session-a',
        eventId: 'event-0',
        operationId: 'operation-a',
        taskWorkspace: root,
        authority,
        current: () => true,
        canKeepForTask: () => true,
        outputs: {} as any,
        keepPullRequest,
      }),
    ).resolves.toMatchObject({
      status: 'kept',
      kind: 'pull-request',
      outcome: 'kept',
      reference: { nativeId: 'PR_kw' },
    });
    expect(keepPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        host: 'github.com',
        ref: '42',
        nativeId: 'PR_kw',
        provenance: expect.objectContaining({
          sessionId: 'session-a',
          eventId: 'event-0',
          turnId: 'turn-a',
          toolCallId: 'call-0',
        }),
      }),
    );
    expect(JSON.stringify(keepPullRequest.mock.calls[0]?.[0])).not.toContain(
      'body',
    );
  });

  test('refuses a substituted PR before TaskGraph curation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-output-pr-revoke-'));
    directories.push(root);
    const descriptor = {
      kind: 'pull-request' as const,
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'owner', name: 'repo' },
      ref: '42',
      nativeId: 'PR_kw',
    };
    const keepPullRequest = vi.fn();
    const module = createSessionOutputsModule({
      eventStore: source([row(0, descriptor)]) as any,
      canReadSession: () => true,
      workspaceForSession: () => root,
      pullRequestResolver: {
        readCurrent: vi.fn(async () => ({ ...descriptor, nativeId: 'other' })),
      },
    });
    await expect(
      module.keep({
        taskId: 'task-a',
        sessionId: 'session-a',
        eventId: 'event-0',
        operationId: 'operation-a',
        taskWorkspace: root,
        authority,
        current: () => true,
        canKeepForTask: () => true,
        outputs: {} as any,
        keepPullRequest,
      }),
    ).resolves.toEqual({ status: 'not-found' });
    expect(keepPullRequest).not.toHaveBeenCalled();
  });

  test.each([
    [new TaskOutputConflictError(), 'conflict'],
    [new TaskOutputDeletedOperationError(), 'deleted'],
  ] as const)(
    'preserves %s Keep terminal outcomes for route mapping',
    async (error, status) => {
      const root = mkdtempSync(join(tmpdir(), 'station-output-keep-outcome-'));
      directories.push(root);
      const module = createSessionOutputsModule({
        eventStore: source([row(0)]) as any,
        canReadSession: () => true,
        workspaceForSession: () => root,
      });
      await expect(
        module.keep({
          taskId: 'task-a',
          sessionId: 'session-a',
          eventId: 'event-0',
          operationId: 'operation-a',
          taskWorkspace: root,
          authority,
          current: () => true,
          canKeepForTask: () => true,
          outputs: {
            createDeclared: vi.fn(async () => {
              throw error;
            }),
          } as any,
          keepPullRequest: vi.fn(),
        }),
      ).resolves.toEqual({ status });
    },
  );

  test.each([
    [new TaskOutputConflictError(), 'file'],
    [new TaskOutputDeletedOperationError(), 'file'],
    [new TaskDeclaredOutputKeepConflictError(), 'pull-request'],
    [new TaskDeclaredOutputKeepDeletedError(), 'pull-request'],
  ] as const)('withholds a revoked %s %s outcome', async (error, kind) => {
    const root = mkdtempSync(join(tmpdir(), 'station-output-keep-revoke-'));
    directories.push(root);
    let current = true;
    const descriptor =
      kind === 'file'
        ? undefined
        : {
            kind: 'pull-request' as const,
            provider: 'github',
            host: 'github.com',
            repository: { owner: 'owner', name: 'repo' },
            ref: '42',
            nativeId: 'PR_kw',
          };
    const module = createSessionOutputsModule({
      eventStore: source([row(0, descriptor)]) as any,
      canReadSession: () => true,
      workspaceForSession: () => root,
      ...(descriptor
        ? {
            pullRequestResolver: { readCurrent: vi.fn(async () => descriptor) },
          }
        : {}),
    });
    await expect(
      module.keep({
        taskId: 'task-a',
        sessionId: 'session-a',
        eventId: 'event-0',
        operationId: 'operation-a',
        taskWorkspace: root,
        authority,
        current: () => current,
        canKeepForTask: () => current,
        outputs: {
          createDeclared: vi.fn(async () => {
            current = false;
            throw error;
          }),
        } as any,
        keepPullRequest: vi.fn(async () => {
          current = false;
          throw error;
        }),
      }),
    ).resolves.toEqual({ status: 'not-found' });
  });
});
