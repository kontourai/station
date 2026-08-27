import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { toVoltAgentTool } from '../frameworks/voltagent-adapter.js';
import {
  createNativeOutputDeclarationOperation,
  createNativeOutputDeclarationTool,
  declareCurrentNativeOutput,
  NATIVE_OUTPUT_DECLARATION_MAX_FILE_BYTES,
  stripOutputDeclarationHandle,
} from '../native-output-declaration.js';
import {
  createNativeOutputGrantAuthority,
  runWithNativeOutputTurnContext,
} from '../native-output-turn-grant.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'station-output-declaration-'));
  roots.push(root);
  await writeFile(join(root, 'result.txt'), 'declared bytes');
  const authority = createNativeOutputGrantAuthority();
  const grant = authority.issue(
    {
      threadId: 'session-a',
      turnId: 'turn-a',
      adapterId: 'station-agent',
      principal: { ...humanPrincipal('test', 'owner-a', 'Owner A') },
      configurationLease: { revision: 1 },
      workspaceRoot: root,
    },
    { isCurrent: () => true },
  )!;
  const operation = createNativeOutputDeclarationOperation({
    authority,
    workspaceForCall: (facts) => facts.workspaceRoot,
  });
  return { root, authority, grant, operation };
}

describe('native output declaration', () => {
  test('returns only an opaque handle and admits a bounded workspace file at terminal commit', async () => {
    const { authority, grant, operation } = await fixture();
    let result: { declarationHandle: string } | undefined;
    await runWithNativeOutputTurnContext(
      { grant, authority, declarationOperation: operation },
      async () => {
        const scope = authority.bindNativeCall(grant, 'real-framework-call')!;
        result = await operation.declare(scope, {
          label: 'Report',
          file: { path: 'result.txt', mediaType: 'text/plain' },
        });
      },
    );
    expect(result).toEqual({ declarationHandle: expect.any(String) });
    expect(stripOutputDeclarationHandle(result)).toEqual({});
    const admitted = operation.takeTerminalAdmissions(
      'session-a',
      'turn-a',
      'event-a',
    );
    expect(admitted).toEqual([
      expect.objectContaining({
        handle: result!.declarationHandle,
        declaration: expect.objectContaining({
          eventId: 'event-a',
          toolCallId: 'real-framework-call',
          descriptor: expect.objectContaining({
            kind: 'workspace-file',
            relativePath: 'result.txt',
          }),
        }),
      }),
    ]);
    operation.commit(admitted.map((entry) => entry.handle));
    expect(
      operation.takeTerminalAdmissions('session-a', 'turn-a', 'event-b'),
    ).toEqual([]);
  });

  test('the real Volt tool wrapper retains its handle privately and returns only public acknowledgement', async () => {
    const { authority, grant, operation } = await fixture();
    const tool = toVoltAgentTool(
      createNativeOutputDeclarationTool() as never,
    ) as { execute(input: unknown, options: unknown): Promise<unknown> };
    const result = await runWithNativeOutputTurnContext(
      { grant, authority, declarationOperation: operation },
      () =>
        tool.execute(
          { file: { path: 'result.txt' } },
          { toolContext: { callId: 'volt-framework-call' } },
        ),
    );
    expect(result).toEqual({ declared: true, kind: 'workspace-file' });
    expect(JSON.stringify(result)).not.toContain('declarationHandle');
    expect(
      operation.takeTerminalAdmissions('session-a', 'turn-a', 'event-a'),
    ).toEqual([
      expect.objectContaining({
        declaration: expect.objectContaining({
          toolCallId: 'volt-framework-call',
        }),
      }),
    ]);
  });

  test.each([
    { file: {} },
    { file: { path: 'result.txt' }, pullRequest: {} },
    { file: { path: 'result.txt' }, unexpected: true },
  ])(
    'refuses malformed Volt declaration input before callbacks or capacity admission',
    async (malformed) => {
      const { authority, grant, operation } = await fixture();
      const declare = vi.spyOn(operation, 'declare');
      const bindNativeCall = vi.spyOn(authority, 'bindNativeCall');
      const tool = toVoltAgentTool(
        createNativeOutputDeclarationTool() as never,
      ) as { execute(input: unknown, options: unknown): Promise<unknown> };

      const result = await runWithNativeOutputTurnContext(
        { grant, authority, declarationOperation: operation },
        () =>
          tool.execute(malformed, {
            toolContext: { callId: 'malformed-volt-framework-call' },
          }),
      );

      expect(result).toEqual({
        declared: false,
        reason: 'invalid-declaration-input',
      });
      expect(bindNativeCall).not.toHaveBeenCalled();
      expect(declare).not.toHaveBeenCalled();
      expect(
        operation.takeTerminalAdmissions('session-a', 'turn-a', 'event-a'),
      ).toEqual([]);
    },
  );

  test('requires the genuine current native call and refuses symlinks, escapes, and oversized files', async () => {
    const { root, authority, grant, operation } = await fixture();
    await writeFile(
      join(root, 'large.txt'),
      Buffer.alloc(NATIVE_OUTPUT_DECLARATION_MAX_FILE_BYTES + 1),
    );
    await symlink(join(root, 'result.txt'), join(root, 'link.txt'));
    await expect(
      declareCurrentNativeOutput({ file: { path: 'result.txt' } }),
    ).rejects.toThrow('genuine native');
    await runWithNativeOutputTurnContext(
      { grant, authority, declarationOperation: operation },
      async () => {
        const scope = authority.bindNativeCall(grant, 'real-call')!;
        await expect(
          operation.declare(scope, { file: { path: '../outside' } }),
        ).rejects.toThrow('outside the workspace');
        await expect(
          operation.declare(scope, { file: { path: 'link.txt' } }),
        ).rejects.toThrow('regular workspace file');
        await expect(
          operation.declare(scope, { file: { path: 'large.txt' } }),
        ).rejects.toThrow('5 MiB');
      },
    );
  });

  test('does not admit after terminal retirement or on a mismatched terminal identity', async () => {
    const { authority, grant, operation } = await fixture();
    const scope = authority.bindNativeCall(grant, 'real-call')!;
    await operation.declare(scope, { file: { path: 'result.txt' } });
    expect(
      operation.takeTerminalAdmissions('session-b', 'turn-a', 'event-a'),
    ).toEqual([]);
    authority.retireTerminal('session-a', 'turn-a');
    expect(
      operation.takeTerminalAdmissions('session-a', 'turn-a', 'event-a'),
    ).toEqual([]);
  });

  test('admits an exact injected PR point read and revocation after that read leaves no handle', async () => {
    const { authority, grant } = await fixture();
    const operation = createNativeOutputDeclarationOperation({
      authority,
      workspaceForCall: () => '/workspace',
      readPullRequest: async ({
        provider,
        host,
        owner,
        repository,
        ref,
        nativeId,
      }) => ({
        kind: 'pull-request',
        provider,
        host,
        repository: { owner, name: repository },
        ref,
        nativeId,
      }),
    });
    const scope = authority.bindNativeCall(grant, 'pr-call')!;
    await expect(
      operation.declare(scope, {
        pullRequest: {
          provider: 'github',
          host: 'github.com',
          owner: 'kontourai',
          repository: 'station',
          ref: '44',
          nativeId: '44',
        },
      }),
    ).resolves.toEqual({ declarationHandle: expect.any(String) });

    const revoked = createNativeOutputGrantAuthority();
    const revokedGrant = revoked.issue(
      {
        threadId: 'session-b',
        turnId: 'turn-b',
        adapterId: 'station-agent',
        principal: { ...humanPrincipal('test', 'owner-a', 'Owner A') },
        configurationLease: {},
        workspaceRoot: '/workspace',
      },
      { isCurrent: () => true },
    )!;
    const revokedOperation = createNativeOutputDeclarationOperation({
      authority: revoked,
      workspaceForCall: () => '/workspace',
      readPullRequest: async (input) => {
        revoked.retireTerminal('session-b', 'turn-b');
        return {
          kind: 'pull-request',
          provider: input.provider,
          host: input.host,
          repository: { owner: input.owner, name: input.repository },
          ref: input.ref,
          nativeId: input.nativeId,
        };
      },
    });
    await expect(
      revokedOperation.declare(
        revoked.bindNativeCall(revokedGrant, 'pr-call')!,
        {
          pullRequest: {
            provider: 'github',
            host: 'github.com',
            owner: 'kontourai',
            repository: 'station',
            ref: '44',
            nativeId: '44',
          },
        },
      ),
    ).rejects.toThrow('no longer authorized');
    expect(
      revokedOperation.takeTerminalAdmissions('session-b', 'turn-b', 'event-b'),
    ).toEqual([]);
  });

  test('reserves capacity before asynchronous PR reads and refuses the 257th call without eviction', async () => {
    const authority = createNativeOutputGrantAuthority();
    const makeGrant = (threadId: string, turnId: string) =>
      authority.issue(
        {
          threadId,
          turnId,
          adapterId: 'station-agent',
          principal: { ...humanPrincipal('test', 'owner-a', 'Owner A') },
          configurationLease: {},
        },
        { isCurrent: () => true },
      )!;
    const first = makeGrant('capacity-a', 'turn-a');
    const second = makeGrant('capacity-b', 'turn-b');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = createNativeOutputDeclarationOperation({
      authority,
      workspaceForCall: () => undefined,
      readPullRequest: async (input) => {
        await gate;
        return {
          kind: 'pull-request',
          provider: input.provider,
          host: input.host,
          repository: { owner: input.owner, name: input.repository },
          ref: input.ref,
          nativeId: input.nativeId,
        };
      },
    });
    const scopes = [
      ...Array.from(
        { length: 256 },
        (_, index) => authority.bindNativeCall(first, `call-${index}`)!,
      ),
      authority.bindNativeCall(second, 'call-256')!,
    ];
    const requests = scopes.map((scope) =>
      operation.declare(scope, {
        pullRequest: {
          provider: 'github',
          host: 'github.com',
          owner: 'kontourai',
          repository: 'station',
          ref: '44',
          nativeId: '44',
        },
      }),
    );
    release();
    const results = await Promise.allSettled(requests);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(256);
    expect(results.at(-1)).toMatchObject({ status: 'rejected' });
  });

  test('owns its capacity reservation before lease admission can reenter', async () => {
    const authority = createNativeOutputGrantAuthority();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = createNativeOutputDeclarationOperation({
      authority,
      workspaceForCall: () => undefined,
      readPullRequest: async (input) => {
        await blocked;
        return {
          kind: 'pull-request',
          provider: input.provider,
          host: input.host,
          repository: { owner: input.owner, name: input.repository },
          ref: input.ref,
          nativeId: input.nativeId,
        };
      },
    });
    const declaration = {
      pullRequest: {
        provider: 'github',
        host: 'github.com',
        owner: 'kontourai',
        repository: 'station',
        ref: '44',
        nativeId: '44',
      },
    };
    let reenter = false;
    let reentry: Promise<unknown> | undefined;
    let secondScope: ReturnType<typeof authority.bindNativeCall>;
    const firstGrant = authority.issue(
      {
        threadId: 'reentry-a',
        turnId: 'turn-a',
        adapterId: 'station-agent',
        principal: { ...humanPrincipal('test', 'owner-a', 'Owner A') },
        configurationLease: {},
      },
      {
        isCurrent: () => {
          if (reenter && secondScope) {
            reenter = false;
            reentry = operation.declare(secondScope, declaration);
          }
          return true;
        },
      },
    )!;
    const secondGrant = authority.issue(
      {
        threadId: 'reentry-b',
        turnId: 'turn-b',
        adapterId: 'station-agent',
        principal: { ...humanPrincipal('test', 'owner-a', 'Owner A') },
        configurationLease: {},
      },
      { isCurrent: () => true },
    )!;
    const firstScopes = Array.from(
      { length: 256 },
      (_, index) => authority.bindNativeCall(firstGrant, `reentry-${index}`)!,
    );
    secondScope = authority.bindNativeCall(secondGrant, 'reentry-257')!;
    const pending = firstScopes
      .slice(0, 255)
      .map((scope) => operation.declare(scope, declaration));
    reenter = true;
    const outer = operation.declare(firstScopes[255]!, declaration);
    await expect(reentry).rejects.toThrow('capacity is full');
    release();
    await expect(Promise.all([...pending, outer])).resolves.toHaveLength(256);
  });
});
