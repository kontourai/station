import { describe, expect, test } from 'vitest';
import { AttachmentStagingService } from '../attachment-staging-service.js';

const DATA = 'data:text/plain;base64,aGVsbG8=';
const descriptor = {
  clientAttachmentId: 'client-attachment-1',
  kind: 'file' as const,
  name: 'note.txt',
  mimeType: 'text/plain' as const,
  size: 5,
};
const ownerA = { principalId: 'human:local:operator' };
const ownerB = { principalId: 'human:local:other' };

describe('AttachmentStagingService', () => {
  test('keeps grants and bytes out of the reconnect projection while hydrating JIT', () => {
    const service = new AttachmentStagingService(() => 1_000);
    const prepared = service.prepare(ownerA, descriptor);
    const reference = service.upload(
      prepared.stageId,
      prepared.uploadGrant,
      DATA,
    );

    expect(service.reconcile(ownerA, [prepared.stageId])).toEqual([
      { stageId: prepared.stageId, state: 'complete', reference },
    ]);
    expect(
      JSON.stringify(service.reconcile(ownerA, [prepared.stageId])),
    ).not.toContain('aGVsbG8');
    expect(
      JSON.stringify(service.reconcile(ownerA, [prepared.stageId])),
    ).not.toContain(prepared.uploadGrant);
    expect(
      service.bindAndHydrate(ownerA, [reference], {
        threadId: 'thread-1',
        clientTurnId: 'turn-1',
      }),
    ).toEqual([{ ...descriptor, dataUrl: DATA }]);
  });

  test('rejects a different owner and expires abandoned stages', () => {
    let now = 1_000;
    const service = new AttachmentStagingService(() => now, 10);
    const prepared = service.prepare(ownerA, descriptor);
    expect(() =>
      service.bindAndHydrate(
        ownerB,
        [service.upload(prepared.stageId, prepared.uploadGrant, DATA)],
        { threadId: 'thread-1', clientTurnId: 'turn-1' },
      ),
    ).toThrow('unavailable');
    now += 11;
    expect(service.reconcile(ownerA, [prepared.stageId])).toEqual([
      { stageId: prepared.stageId, state: 'expired' },
    ]);
  });

  test('refuses to reuse a staged attachment on another turn', () => {
    const service = new AttachmentStagingService(() => 1_000);
    const prepared = service.prepare(ownerA, descriptor);
    const reference = service.upload(
      prepared.stageId,
      prepared.uploadGrant,
      DATA,
    );
    service.bindAndHydrate(ownerA, [reference], {
      threadId: 'thread-1',
      clientTurnId: 'turn-1',
    });
    expect(() =>
      service.bindAndHydrate(ownerA, [reference], {
        threadId: 'thread-1',
        clientTurnId: 'turn-2',
      }),
    ).toThrow('another turn');
  });

  test('replays a lost prepare response by retaining one stable attachment stage', () => {
    const service = new AttachmentStagingService(() => 1_000);
    const first = service.prepare(ownerA, descriptor);
    const replay = service.prepare(ownerA, descriptor);

    expect(replay.stageId).toBe(first.stageId);
    expect(replay.uploadGrant).not.toBe(first.uploadGrant);
    expect(() =>
      service.upload(first.stageId, first.uploadGrant, DATA),
    ).toThrow('authority');
    expect(
      service.upload(replay.stageId, replay.uploadGrant, DATA),
    ).toMatchObject({
      stageId: first.stageId,
      clientAttachmentId: descriptor.clientAttachmentId,
    });
  });

  test('fails closed when a grant is replayed to another stage or a reference digest is changed', () => {
    const service = new AttachmentStagingService(() => 1_000);
    const first = service.prepare(ownerA, descriptor);
    const second = service.prepare(ownerA, {
      ...descriptor,
      clientAttachmentId: 'client-attachment-2',
    });
    expect(() =>
      service.upload(second.stageId, first.uploadGrant, DATA),
    ).toThrow('authority');
    const reference = service.upload(first.stageId, first.uploadGrant, DATA);
    expect(() =>
      service.bindAndHydrate(
        ownerA,
        [{ ...reference, digest: `sha256-${'0'.repeat(64)}` }],
        { threadId: 'thread-1', clientTurnId: 'turn-1' },
      ),
    ).toThrow('not valid');
  });

  test('keeps a completed, bound stage immutable while same-turn binding remains idempotent', () => {
    const service = new AttachmentStagingService(() => 1_000);
    const prepared = service.prepare(ownerA, descriptor);
    const reference = service.upload(
      prepared.stageId,
      prepared.uploadGrant,
      DATA,
    );
    const binding = { threadId: 'thread-1', clientTurnId: 'turn-1' };
    expect(service.bindAndHydrate(ownerA, [reference], binding)).toEqual([
      { ...descriptor, dataUrl: DATA },
    ]);
    expect(service.bindAndHydrate(ownerA, [reference], binding)).toEqual([
      { ...descriptor, dataUrl: DATA },
    ]);
    expect(() => service.prepare(ownerA, descriptor)).toThrow(
      'already complete',
    );
    expect(() =>
      service.upload(prepared.stageId, prepared.uploadGrant, DATA),
    ).toThrow('authority');
  });

  test('enforces the 15 MiB owner capacity across completed stages', () => {
    const service = new AttachmentStagingService(() => 1_000);
    const bytes = Buffer.alloc(5 * 1024 * 1024, 7);
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
    for (let index = 0; index < 3; index += 1) {
      const prepared = service.prepare(ownerA, {
        clientAttachmentId: `capacity-${index}`,
        kind: 'image',
        name: `capacity-${index}.png`,
        mimeType: 'image/png',
        size: bytes.length,
      });
      service.upload(prepared.stageId, prepared.uploadGrant, dataUrl);
    }
    const overflow = service.prepare(ownerA, {
      clientAttachmentId: 'capacity-overflow',
      kind: 'image',
      name: 'overflow.png',
      mimeType: 'image/png',
      size: bytes.length,
    });
    expect(() =>
      service.upload(overflow.stageId, overflow.uploadGrant, dataUrl),
    ).toThrow('capacity');
  });

  test('sweeps before enforcing the per-principal stage ceiling', () => {
    let now = 1_000;
    const service = new AttachmentStagingService(() => now, 10);
    for (let index = 0; index < 5; index += 1) {
      service.prepare(ownerA, {
        ...descriptor,
        clientAttachmentId: `client-attachment-${index}`,
      });
    }
    expect(() =>
      service.prepare(ownerA, {
        ...descriptor,
        clientAttachmentId: 'client-attachment-overflow',
      }),
    ).toThrow('Too many');
    now += 11;
    expect(() => service.prepare(ownerA, descriptor)).not.toThrow();
  });

  test('keeps a bound turn retryable during its dispatch deadline, then releases five accepted files immediately', () => {
    let now = 1_000;
    const service = new AttachmentStagingService(() => now, 10, 1);
    const binding = {
      threadId: 'resolved-child-session',
      clientTurnId: 'turn-1',
    };
    const references = Array.from({ length: 5 }, (_, index) => {
      const prepared = service.prepare(ownerA, {
        ...descriptor,
        clientAttachmentId: `accepted-${index}`,
      });
      return service.upload(prepared.stageId, prepared.uploadGrant, DATA);
    });
    service.bindAndHydrate(ownerA, references, binding);
    now += 5;
    expect(service.reconcile(ownerA, [references[0]!.stageId])).toEqual([
      expect.objectContaining({ state: 'complete' }),
    ]);
    service.acceptBinding(ownerA, references, binding);
    expect(service.reconcile(ownerA, [references[0]!.stageId])).toEqual([
      expect.objectContaining({ state: 'accepted' }),
    ]);
    expect(() =>
      service.prepare(ownerA, {
        ...descriptor,
        clientAttachmentId: 'accepted-next',
      }),
    ).not.toThrow();
    service.dispose();
  });

  test('expires a failed bound five-file dispatch and releases its capacity', () => {
    let now = 1_000;
    const service = new AttachmentStagingService(() => now, 10, 1);
    const binding = { threadId: 'child-session', clientTurnId: 'turn-1' };
    const references = Array.from({ length: 5 }, (_, index) => {
      const prepared = service.prepare(ownerA, {
        ...descriptor,
        clientAttachmentId: `failed-${index}`,
      });
      return service.upload(prepared.stageId, prepared.uploadGrant, DATA);
    });
    expect(service.bindAndHydrate(ownerA, references, binding)).toHaveLength(5);
    expect(service.bindAndHydrate(ownerA, references, binding)).toHaveLength(5);
    expect(() =>
      service.bindAndHydrate(ownerA, references, {
        threadId: 'child-session',
        clientTurnId: 'different-turn',
      }),
    ).toThrow('another turn');
    now += 11;
    service.cleanup();
    expect(service.reconcile(ownerA, [references[0]!.stageId])).toEqual([
      expect.objectContaining({ state: 'expired' }),
    ]);
    expect(() =>
      service.prepare(ownerA, {
        ...descriptor,
        clientAttachmentId: 'failed-next',
      }),
    ).not.toThrow();
    service.dispose();
  });

  test('releases a cancelled stage slot immediately without retaining bytes', () => {
    const service = new AttachmentStagingService(() => 1_000);
    const stages = Array.from({ length: 5 }, (_, index) =>
      service.prepare(ownerA, {
        ...descriptor,
        clientAttachmentId: `cancelled-${index}`,
      }),
    );
    service.cancel(ownerA, stages[0]!.stageId);

    expect(() =>
      service.prepare(ownerA, {
        ...descriptor,
        clientAttachmentId: 'replacement',
      }),
    ).not.toThrow();
  });
});
