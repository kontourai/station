import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { canonicalJson } from '@kontourai/relay';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { onTestFinished, test, vi } from 'vitest';
import { createOrchestrationRequestPrincipalResolver } from '../../../runtime/bootstrap/orchestration-request-principal.js';
import { CreateRequestClaims } from '../create-request-claims.js';
import { SourceRefusal } from '../delegation-group-source-admission.js';
import {
  fixture,
  selection,
  subject,
} from './delegation-source-fixtures/source.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const code = (expected: string) => (error: unknown) =>
  error instanceof SourceRefusal && error.code === expected;

async function allocation(
  f: Fixture,
  request: Request,
  effect: (taskId: string) => Promise<void>,
  options: {
    request?: Request;
    callerSessionId?: string;
    sessionId?: string;
  } = {},
) {
  const stop = new Error('fixture stops before provider start');
  const principal = createOrchestrationRequestPrincipalResolver({
    environmentSecurityService: f.environment,
  })(f.context(request));
  try {
    await new CreateRequestClaims(f.home).run(
      {
        kind: 'delegation',
        principal,
        authority: sessionReadAuthorityFromRequest(
          'operator',
          undefined,
          undefined,
        ),
        request: options.request ?? request,
        callerSessionId: options.callerSessionId,
        sessionId: options.sessionId,
        requestKey: 'native-source-create',
        intent: { kind: 'native-source-fixture' },
        hasSessionStartRecord: () => false,
      },
      async (taskId) => {
        await effect(taskId);
        throw stop;
      },
    );
    assert.fail('The source fixture must not publish a provider-start receipt');
  } catch (error) {
    if (error !== stop) throw error;
  }
}

function sourceOpens(f: Fixture, onOpen?: (path: string) => void) {
  const open = fs.openSync;
  let count = 0;
  const observed = vi
    .spyOn(fs, 'openSync')
    .mockImplementation((path, flags, mode) => {
      if (String(path) === join(f.repo, 'source.txt')) count++;
      onOpen?.(String(path));
      return open(path, flags, mode);
    });
  syncBuiltinESMExports();
  onTestFinished(() => {
    observed.mockRestore();
    syncBuiltinESMExports();
  });
  return () => count;
}

test('a native root seal reads real source under the server Task allocation, without group identities or source disclosure', async () => {
  const f = await fixture();
  const request = f.request('/api/orchestration/delegations', {
    body: JSON.stringify({ taskId: 'claimed-task', groupId: 'claimed-group' }),
  });
  const reads = sourceOpens(f);
  let captured:
    | Awaited<ReturnType<typeof f.owner.captureRootNativeTaskSnapshot>>
    | undefined;
  await allocation(f, request, async (taskId) => {
    captured = await f.owner.captureRootNativeTaskSnapshot(
      f.context(request),
      selection,
    );
    assert.ok(reads() > 0, 'the actual source-content observer must execute');
    assert.equal(captured.taskId, taskId);
    assert.notEqual(taskId, 'claimed-task');
    assert.equal(captured.guarantee, 'sealed-input-only');
    assert.equal(JSON.stringify(captured).includes('original source'), false);
    const digest = `sha256:${createHash('sha256')
      .update(
        canonicalJson({
          format: 'station.source-files.v1',
          files: [
            {
              path: 'source.txt',
              mode: '100644',
              encoding: 'base64',
              content: Buffer.from('original source\n').toString('base64'),
            },
          ],
        }),
      )
      .digest('hex')}`;
    assert.equal(captured.source.source_state_id, digest);
    const reference = captured.source.source_admission_receipt;
    assert.ok(reference);
    const receipt = JSON.parse(
      fs.readFileSync(
        join(f.store, `native-snapshot-${reference.id}.json`),
        'utf8',
      ),
    );
    assert.equal(receipt.payload.taskId, taskId);
    assert.equal(receipt.payload.snapshotDigest, digest);
    assert.equal(Object.hasOwn(receipt.payload, 'subject'), false);
    assert.equal(Object.hasOwn(receipt.payload, 'groupId'), false);
    f.owner.assertRootNativeSnapshotCurrent(
      f.context(request),
      captured.capability,
    );
    await assert.rejects(
      f.owner.prepareSdkSnapshot(
        f.context(request),
        subject,
        captured.capability,
        {},
      ),
      code('snapshot_unavailable'),
    );
  });
  const sealed = captured;
  assert.ok(sealed);
  assert.throws(
    () =>
      f.owner.assertRootNativeSnapshotCurrent(
        f.context(request),
        sealed.capability,
      ),
    /delegation_create_custody_unavailable/,
  );
  f.owner.releaseRootNativeSnapshot(sealed.capability);
});

test('native root seals share the existing four-holder capacity with group snapshots', async () => {
  const f = await fixture();
  const request = f.request('/api/orchestration/delegations');
  await allocation(f, request, async () => {
    const held: object[] = [];
    try {
      for (let index = 0; index < 4; index++)
        held.push(
          (
            await f.owner.captureRootNativeTaskSnapshot(
              f.context(request),
              selection,
            )
          ).capability,
        );
      await assert.rejects(
        f.owner.captureRootNativeTaskSnapshot(f.context(request), selection),
        code('snapshot_capacity_exceeded'),
      );
      await assert.rejects(
        f.owner.captureSnapshot(f.context(request), subject, selection),
        code('snapshot_capacity_exceeded'),
      );
      const released = held.pop();
      assert.ok(released);
      f.owner.releaseRootNativeSnapshot(released);
      const group = await f.owner.captureSnapshot(
        f.context(request),
        subject,
        selection,
      );
      f.owner.releaseSnapshot(group.capability);
    } finally {
      for (const capability of held)
        f.owner.releaseRootNativeSnapshot(capability);
    }
  });
});

test('credential revocation after one source file refuses the next protected native source read', async () => {
  const f = await fixture();
  fs.writeFileSync(join(f.repo, 'a-first.txt'), 'first protected source\n');
  fs.writeFileSync(join(f.repo, 'z-last.txt'), 'last protected source\n');
  await f.git('add', '--', 'a-first.txt', 'z-last.txt');
  await f.git('commit', '-qm', 'source revocation fixture');
  const request = f.request('/api/orchestration/delegations');
  let firstRead = false;
  let revoked = false;
  let revocationFailure: unknown;
  let releaseFirst!: () => void;
  let revocationEnabled = true;
  const afterFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  // Register outside the source owner's synchronous Home span. Revocation is
  // an independent owner action, not a descendant borrowing a retired span.
  const revoking = afterFirst.then(() => {
    if (!revocationEnabled) return;
    try {
      f.environment.devicePairing.revokeDevice(
        f.paired.device.id,
        'operator-credential',
      );
      revoked = true;
    } catch (error) {
      revocationFailure = error;
    }
  });
  onTestFinished(async () => {
    revocationEnabled = false;
    releaseFirst();
    await revoking;
  });
  const reads = sourceOpens(f, (path) => {
    if (path !== join(f.repo, 'a-first.txt') || firstRead) return;
    firstRead = true;
    releaseFirst();
  });
  await allocation(f, request, async () => {
    let captured:
      | Awaited<ReturnType<typeof f.owner.captureRootNativeTaskSnapshot>>
      | undefined;
    let failure: unknown;
    try {
      captured = await f.owner.captureRootNativeTaskSnapshot(
        f.context(request),
        selection,
      );
    } catch (error) {
      failure = error;
    } finally {
      if (captured) f.owner.releaseRootNativeSnapshot(captured.capability);
    }
    assert.equal(
      firstRead,
      true,
      'the real first source-file read must execute',
    );
    await revoking;
    assert.equal(revocationFailure, undefined);
    assert.equal(revoked, true, 'the actual credential revocation must commit');
    assert.ok(failure, 'revocation must refuse the capture');
    assert.equal(reads(), 0, 'the next source file must remain unread');
    assert.deepEqual(
      fs
        .readdirSync(f.store)
        .filter((name) => name.startsWith('native-snapshot-')),
      [],
    );
  });
});

test('native root capture refuses outside a live create allocation before source reads', async () => {
  const f = await fixture();
  const request = f.request('/api/orchestration/delegations');
  const reads = sourceOpens(f);
  await assert.rejects(
    f.owner.captureRootNativeTaskSnapshot(f.context(request), selection),
    code('native_task_custody_unavailable'),
  );
  assert.equal(reads(), 0);
});

test('native root capture cannot borrow another Request from the same operator allocation', async () => {
  const f = await fixture();
  const request = f.request('/api/orchestration/delegations');
  const other = f.request('/api/orchestration/delegations');
  const reads = sourceOpens(f);
  await allocation(f, request, async () => {
    await assert.rejects(
      f.owner.captureRootNativeTaskSnapshot(f.context(other), selection),
      code('native_task_custody_unavailable'),
    );
    assert.equal(reads(), 0);
  });
});

test.each([
  {
    label: 'provided Task IDs',
    options: { sessionId: 'task:11111111-1111-1111-1111-111111111111' },
    expected: 'native_task_custody_unavailable',
  },
  {
    label: 'session-parent fallback',
    options: { callerSessionId: 'parent-session' },
    expected: 'native_ancestor_source_admission_unavailable',
  },
])(
  'native root capture refuses $label before source reads',
  async ({ options, expected }) => {
    const f = await fixture();
    const request = f.request('/api/orchestration/delegations');
    const reads = sourceOpens(f);
    await allocation(
      f,
      request,
      async () => {
        await assert.rejects(
          f.owner.captureRootNativeTaskSnapshot(f.context(request), selection),
          code(expected),
        );
        assert.equal(reads(), 0);
      },
      options,
    );
  },
);
