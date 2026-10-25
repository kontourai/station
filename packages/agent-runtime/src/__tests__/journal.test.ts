import type {
  KernelCommand,
  KernelResult,
  KernelResults,
  ParticipantRefusal,
} from '@kontourai/monument';
import {
  type AtomicLocation,
  openAtomicCrashPointStore,
} from '@kontourai/monument/testing';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { normalizePart, tapeBytes } from '../codecs.js';
import { digestBytes, encode } from '../encoding.js';
import {
  drainModelOutbox,
  type ModelContext,
  type ModelProtocol,
  type Refused,
  type WriteAck,
} from '../index.js';
import { openSqliteRuntimeProjection } from '../sqlite.js';
import {
  finish,
  fixture,
  key,
  nextOwner,
  operation,
  parts,
} from './fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
expectTypeOf<KernelResult<KernelCommand>>().toEqualTypeOf<
  KernelResults[KernelCommand['type']] | ParticipantRefusal
>();

for (const kind of ['memory', 'sqlite'] as const)
  describe(`${kind} actual model protocol`, () => {
    it('holds a typed pin before writes and rolls back pin/receipt without inventing an outbox row', async () => {
      const f = await fixture(kind);
      cleanup.push(() => f.close());
      await f.storage.close();
      const location: AtomicLocation<
        ModelProtocol,
        ModelContext,
        never,
        Refused
      > = {
        open: (options) => Promise.resolve(f.open(options?.participants)),
        async dispose() {},
      };
      const crash = await openAtomicCrashPointStore(location);
      cleanup.push(() => crash.dispose());
      const held = crash.holdNextCommit();
      const command = operation({
        type: 'pin',
        key,
        expected: f.opened.snapshot.fence,
        pin: f.pin,
      });
      const pending: Promise<WriteAck> = crash.storage.execute(
        command,
        f.context,
      );
      const rejected = expect(pending).rejects.toThrow('crashed');
      await held.entered;
      expect(
        await f.open().execute({ type: 'read', key }, f.context),
      ).toMatchObject({ pins: [] });
      await crash.reopen();
      await rejected;
      crash.failNextCommit(new Error('pin-decision-rollback'));
      await expect(crash.storage.execute(command, f.context)).rejects.toThrow(
        'pin-decision-rollback',
      );
      expect(
        await crash.storage.execute({ type: 'read', key }, f.context),
      ).toMatchObject({ pins: [] });
      expect(
        await crash.storage.execute(
          { type: 'listOutbox', key, limit: 10 },
          f.context,
        ),
      ).toEqual({ kind: 'listed', entries: [], throughPosition: -1 });
      expect(await crash.storage.execute(command, f.context)).toMatchObject({
        kind: 'applied',
      });
    });

    it('begin receipt never grants another execution and proven-dead takeover grants a distinct attempt', async () => {
      const f = await fixture(kind);
      cleanup.push(() => f.close());
      const pinned = await f.storage.execute(
        operation({
          type: 'pin',
          key,
          expected: f.opened.snapshot.fence,
          pin: f.pin,
        }),
        f.context,
      );
      if (pinned.kind === 'refused') throw new Error('pin prerequisite');
      const command = operation({
        type: 'begin',
        key,
        expected: pinned.fence,
        requestId: f.pin.requestId,
      });
      let dispatches = 0;
      const begun = await f.storage.execute(command, f.context);
      if (begun.kind !== 'execute') throw new Error('begin prerequisite');
      dispatches++;
      const retry = await f.storage.execute(command, f.context);
      if (retry.kind === 'execute') dispatches++;
      expect(retry).toEqual({
        kind: 'acknowledged',
        fence: begun.fence,
        originalGrantId: begun.attempt.grantId,
      });
      expect(dispatches).toBe(1);
      expect(
        await f.storage.execute(
          operation({
            type: 'begin',
            key,
            expected: begun.fence,
            requestId: f.pin.requestId,
          }),
          f.context,
        ),
      ).toMatchObject({ kind: 'already-begun' });
      const recovery = operation({
        type: 'takeOver',
        key,
        expected: begun.fence,
        owner: nextOwner,
      });
      expect(
        await f.storage.execute(recovery, { liveness: () => 'unknown' }),
      ).toEqual({ kind: 'refused', reason: 'unknown-owner' });
      expect(
        await f.storage.execute(recovery, { liveness: () => 'live' }),
      ).toEqual({ kind: 'refused', reason: 'busy' });
      const restored = await f.storage.execute(recovery, {
        liveness: () => 'dead',
      });
      if (restored.kind !== 'restored')
        throw new Error('takeover prerequisite');
      const second = await f.storage.execute(
        operation({
          type: 'begin',
          key,
          expected: restored.snapshot.fence,
          requestId: f.pin.requestId,
        }),
        f.context,
      );
      expect(second).toMatchObject({
        kind: 'execute',
        attempt: { number: 2, owner: nextOwner, requestId: 'request' },
      });
      if (second.kind !== 'execute')
        throw new Error('second begin prerequisite');
      expect(second.attempt.grantId).not.toBe(begun.attempt.grantId);
      expect(restored.pendingRequest).toEqual(f.pin);
    });

    it('an emitting command rolls back state receipt and outbox after the actual decision', async () => {
      const f = await fixture(kind);
      cleanup.push(() => f.close());
      const pinned = await f.storage.execute(
        operation({
          type: 'pin',
          key,
          expected: f.opened.snapshot.fence,
          pin: f.pin,
        }),
        f.context,
      );
      if (pinned.kind === 'refused') throw new Error('pin prerequisite');
      const begun = await f.storage.execute(
        operation({
          type: 'begin',
          key,
          expected: pinned.fence,
          requestId: 'request',
        }),
        f.context,
      );
      if (begun.kind !== 'execute') throw new Error('begin prerequisite');
      await f.storage.close();
      const crash = await openAtomicCrashPointStore<
        ModelProtocol,
        ModelContext,
        never,
        Refused
      >({
        open: (o) => Promise.resolve(f.open(o?.participants)),
        async dispose() {},
      });
      cleanup.push(() => crash.dispose());
      const body = await f.bodies.put(
        'runtime-ai-sdk-v3-part/1',
        encode({ type: 'stream-start', warnings: [] }),
      );
      const partial = operation({
        type: 'partial',
        key,
        expected: begun.fence,
        attempt: begun.attempt,
        sequence: 0,
        body,
      });
      crash.failNextCommit(new Error('partial-decision-rollback'));
      await expect(crash.storage.execute(partial, f.context)).rejects.toThrow(
        'partial-decision-rollback',
      );
      expect(
        await crash.storage.execute(
          { type: 'listOutbox', key, limit: 10 },
          f.context,
        ),
      ).toEqual({ kind: 'listed', entries: [], throughPosition: -1 });
      expect(await crash.storage.execute(partial, f.context)).toMatchObject({
        kind: 'applied',
      });
      expect(
        await crash.storage.execute(
          { type: 'listOutbox', key, limit: 10 },
          f.context,
        ),
      ).toMatchObject({ entries: [{ kind: 'partial', sequence: 0, body }] });
    });

    it('strict complete validates stored tape and exact empty-prefix sentinel', async () => {
      const f = await fixture(kind);
      cleanup.push(() => f.close());
      const pinned = await f.storage.execute(
        operation({
          type: 'pin',
          key,
          expected: f.opened.snapshot.fence,
          pin: f.pin,
        }),
        f.context,
      );
      if (pinned.kind === 'refused') throw new Error('pin prerequisite');
      const begun = await f.storage.execute(
        operation({
          type: 'begin',
          key,
          expected: pinned.fence,
          requestId: 'request',
        }),
        f.context,
      );
      if (begun.kind !== 'execute') throw new Error('begin prerequisite');
      const tape = await f.bodies.put(
        'runtime-ai-sdk-v3-tape/1',
        tapeBytes('request', 1, [normalizePart(finish)]),
      );
      expect(
        await f.storage.execute(
          operation({
            type: 'complete',
            key,
            expected: begun.fence,
            attempt: begun.attempt,
            tape,
            lastPartialSequence: 0,
          }),
          f.context,
        ),
      ).toEqual({ kind: 'refused', reason: 'conflict' });
      expect(
        await f.storage.execute(
          operation({
            type: 'complete',
            key,
            expected: begun.fence,
            attempt: begun.attempt,
            tape,
            lastPartialSequence: -1,
          }),
          f.context,
        ),
      ).toMatchObject({ kind: 'applied' });
    });
  });

it('real SQLite abort audit is stable, monotone and ready only after required applied acknowledgments', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const sink = openSqliteRuntimeProjection({
    database: f.database,
    bodies: f.bodies,
    host: f.host,
    policy: (await import('../index.js')).DEFAULT_MODEL_POLICY,
  });
  cleanup.push(() => sink.close());
  const pinned = await f.storage.execute(
    operation({
      type: 'pin',
      key,
      expected: f.opened.snapshot.fence,
      pin: f.pin,
    }),
    f.context,
  );
  if (pinned.kind === 'refused') throw new Error('pin prerequisite');
  const begun = await f.storage.execute(
    operation({
      type: 'begin',
      key,
      expected: pinned.fence,
      requestId: 'request',
    }),
    f.context,
  );
  if (begun.kind !== 'execute') throw new Error('begin prerequisite');
  const body = await f.bodies.put(
    'runtime-ai-sdk-v3-part/1',
    encode({ type: 'text-delta', id: 'old', delta: 'OLD-PARTIAL' }),
  );
  const partial = await f.storage.execute(
    operation({
      type: 'partial',
      key,
      expected: begun.fence,
      attempt: begun.attempt,
      sequence: 0,
      body,
    }),
    f.context,
  );
  if (partial.kind === 'refused') throw new Error('partial prerequisite');
  const listed = await f.storage.execute(
    { type: 'listOutbox', key, limit: 10 },
    f.context,
  );
  if (listed.kind !== 'listed') throw new Error('list prerequisite');
  await drainModelOutbox(f.storage, sink, key, f.context);
  expect(await sink.readModelContext(key)).toEqual({ kind: 'unavailable' });
  const restored = await f.storage.execute(
    operation({
      type: 'takeOver',
      key,
      expected: partial.fence,
      owner: nextOwner,
    }),
    { liveness: () => 'dead' },
  );
  if (restored.kind !== 'restored') throw new Error('takeover prerequisite');
  const second = await f.storage.execute(
    operation({
      type: 'begin',
      key,
      expected: restored.snapshot.fence,
      requestId: 'request',
    }),
    f.context,
  );
  if (second.kind !== 'execute') throw new Error('second begin prerequisite');
  const tape = await f.bodies.put(
    'runtime-ai-sdk-v3-tape/1',
    tapeBytes('request', 2, parts.map(normalizePart)),
  );
  const completed = await f.storage.execute(
    operation({
      type: 'complete',
      key,
      expected: second.fence,
      attempt: second.attempt,
      tape,
      lastPartialSequence: -1,
    }),
    f.context,
  );
  if (completed.kind === 'refused') throw new Error('complete prerequisite');
  await f.storage.execute(
    operation({
      type: 'finish',
      key,
      expected: completed.fence,
      status: 'completed',
    }),
    f.context,
  );
  expect(await sink.readModelContext(key)).toEqual({ kind: 'unavailable' });
  await drainModelOutbox(f.storage, sink, key, f.context);
  const oldPartial = listed.entries[0];
  if (!oldPartial) throw new Error('old partial prerequisite');
  await sink.apply(oldPartial);
  await sink.apply(oldPartial);
  const audit = await sink.readAudit(key);
  expect(audit.map((p) => p.kind)).toEqual(['partial', 'aborted', 'completed']);
  expect(audit[1]).toMatchObject({
    requestId: 'request',
    attempt: 1,
    body: null,
  });
  expect(await f.bodies.read(body)).toEqual(
    encode({ type: 'text-delta', id: 'old', delta: 'OLD-PARTIAL' }),
  );
  expect(await sink.readModelContext(key)).toEqual({
    kind: 'ready',
    tapes: [tape],
  });
});

for (const scenario of [
  'later-alias-mutation',
  'legitimate-current',
  'bad-current-hash',
  'malformed-current',
] as const)
  it(`memory completion ${scenario} uses only current verified body bytes`, async () => {
    const f = await fixture('memory');
    cleanup.push(() => f.close());
    const pinned = await f.storage.execute(
      operation({
        type: 'pin',
        key,
        expected: f.opened.snapshot.fence,
        pin: f.pin,
      }),
      f.context,
    );
    if (pinned.kind === 'refused') throw Error('real memory pin');
    const begun = await f.storage.execute(
      operation({
        type: 'begin',
        key,
        expected: pinned.fence,
        requestId: f.pin.requestId,
      }),
      f.context,
    );
    if (begun.kind !== 'execute') throw Error('real memory begin');
    const originalBytes = tapeBytes(
      scenario === 'later-alias-mutation' ? 'foreign' : f.pin.requestId,
      1,
      parts.map(normalizePart),
    );
    const goodRef = await f.bodies.put(
      'runtime-ai-sdk-v3-tape/1',
      originalBytes,
    );
    const replacement = tapeBytes(f.pin.requestId, 1, parts.map(normalizePart));
    expect(replacement.byteLength).toBe(originalBytes.byteLength);
    const malformed = new Uint8Array([0, 0, 0, 1, 123]);
    const tape =
      scenario === 'malformed-current'
        ? {
            codec: goodRef.codec,
            digest: digestBytes(malformed),
            byteLength: malformed.byteLength,
          }
        : goodRef;
    const alias =
      scenario === 'malformed-current'
        ? malformed
        : new Uint8Array(originalBytes);
    if (scenario === 'bad-current-hash') alias[alias.length - 1] ^= 1;
    const actualRead = f.bodies.read.bind(f.bodies);
    let supplied = false;
    let mutations = 0;
    f.bodies.read = async (ref) => {
      if (
        ref.codec === tape.codec &&
        ref.digest === tape.digest &&
        ref.byteLength === tape.byteLength
      ) {
        supplied = true;
        if (scenario !== 'bad-current-hash')
          expect(digestBytes(alias)).toBe(tape.digest);
        return alias;
      }
      const current = await actualRead(ref);
      if (
        scenario === 'later-alias-mutation' &&
        mutations === 0 &&
        supplied &&
        ref.digest === f.captured.entry.body.digest
      ) {
        expect(digestBytes(alias)).toBe(goodRef.digest);
        alias.set(replacement);
        mutations++;
        expect(digestBytes(alias)).not.toBe(goodRef.digest);
      }
      return current;
    };
    await f.storage.close();
    f.storage = f.open();
    const command = operation({
      type: 'complete',
      key,
      expected: begun.fence,
      attempt: begun.attempt,
      tape,
      lastPartialSequence: -1,
    });
    const answer = await f.storage.execute(command, f.context).then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error }),
    );
    expect(supplied).toBe(true);
    if (scenario === 'later-alias-mutation') {
      expect(mutations).toBe(1);
      expect(answer.error).toBeNull();
      expect(answer.result).toEqual({ kind: 'refused', reason: 'conflict' });
    } else if (scenario === 'legitimate-current') {
      expect(mutations).toBe(0);
      expect(answer.error).toBeNull();
      expect(answer.result).toMatchObject({ kind: 'applied' });
      expect(
        await f.storage.execute({ type: 'read', key }, f.context),
      ).toMatchObject({ kind: 'found', snapshot: { state: 'running' } });
      expect(
        await f.storage.execute(
          { type: 'listOutbox', key, limit: 10 },
          f.context,
        ),
      ).toMatchObject({
        kind: 'listed',
        entries: [{ kind: 'completed', body: tape }],
      });
      expect(await actualRead(tape)).toEqual(originalBytes);
      return;
    } else {
      expect(mutations).toBe(0);
      expect(answer.result).toBeNull();
      expect(answer.error).toBeInstanceOf(Error);
      if (scenario === 'bad-current-hash')
        expect(String(answer.error)).toContain('DURABLE_BODY_DAMAGED');
      else expect(String(answer.error)).toContain('JSON');
    }
    expect(
      await f.storage.execute({ type: 'read', key }, f.context),
    ).toMatchObject({
      kind: 'found',
      snapshot: { state: 'running', fence: begun.fence },
    });
    expect(
      await f.storage.execute(
        { type: 'listOutbox', key, limit: 10 },
        f.context,
      ),
    ).toEqual({ kind: 'listed', entries: [], throughPosition: -1 });
  });
