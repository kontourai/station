import { afterEach, expect, it } from 'vitest';
import { bindDurableAiSdkModel } from '../ai-sdk.js';
import { normalizePart, tapeBytes } from '../codecs.js';
import { canonical } from '../encoding.js';
import { createModelRuntime, DEFAULT_MODEL_POLICY } from '../index.js';
import { auditAgentRuntimeStore } from '../sqlite.js';
import { key, nextOwner, operation, parts } from './fixture.js';
import { nativeOptions } from './r1-fixture.js';
import { completedGeneration } from './r2-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
async function twoTapes() {
  const f = await completedGeneration();
  cleanup.push(() => f.close());
  const foreignKey = { ...key, conversationId: 'foreign' };
  const o = await f.storage.execute(
    operation({
      type: 'open',
      spec: { ...f.opened.snapshot.spec, key: foreignKey },
      owner: f.opened.snapshot.fence.owner,
    }),
    f.context,
  );
  if (o.kind !== 'opened') throw Error('real second generation prerequisite');
  const pin = { ...f.pin, requestId: 'foreign-request' };
  const p = await f.storage.execute(
    operation({
      type: 'pin',
      key: foreignKey,
      expected: o.snapshot.fence,
      pin,
    }),
    f.context,
  );
  if (p.kind === 'refused') throw Error('foreign pin prerequisite');
  const b = await f.storage.execute(
    operation({
      type: 'begin',
      key: foreignKey,
      expected: p.fence,
      requestId: pin.requestId,
    }),
    f.context,
  );
  if (b.kind !== 'execute') throw Error('foreign grant prerequisite');
  const tape = await f.bodies.put(
    'runtime-ai-sdk-v3-tape/1',
    tapeBytes(
      pin.requestId,
      b.attempt.number,
      parts.map((p) =>
        normalizePart(p.type === 'text-delta' ? { ...p, delta: 'FOREIGN' } : p),
      ),
    ),
  );
  const c = await f.storage.execute(
    operation({
      type: 'complete',
      key: foreignKey,
      expected: b.fence,
      attempt: b.attempt,
      tape,
      lastPartialSequence: -1,
    }),
    f.context,
  );
  if (c.kind === 'refused') throw Error('foreign completed tape prerequisite');
  const answer = await f.storage.execute(
    operation({
      type: 'begin',
      key: foreignKey,
      expected: c.fence,
      requestId: pin.requestId,
    }),
    f.context,
  );
  if (answer.kind !== 'replay')
    throw Error('foreign actual replay prerequisite');
  expect(await f.bodies.read(tape)).toBeInstanceOf(Uint8Array);
  expect(await f.bodies.read(f.tape)).toBeInstanceOf(Uint8Array);
  expect(tape.digest).not.toBe(f.tape.digest);
  return { f, answer, foreignKey };
}
for (const mutation of [
  'foreign-answer',
  'wrong-variant',
  'operation-id',
  'row-id',
  'command-type',
  'malformed-outer-id',
  'noncanonical-outer-id',
  'noncanonical-generation',
  'missing-generation',
] as const)
  it(`R2.3 current SQLite refuses schema-valid ${mutation} receipt with both actual generation tapes intact`, async () => {
    const { f, answer } = await twoTapes();
    expect(await f.storage.execute(f.begin, f.context)).toMatchObject({
      kind: 'acknowledged',
      originalGrantId: f.begun.attempt.grantId,
    });
    expect(await f.storage.execute(f.replay, f.context)).toEqual(f.replayed);
    const id = canonical([
      canonical([key.scopeId, key.conversationId, key.invocationId]),
      f.begin.operationId,
    ]);
    const row = f.database
      .prepare('SELECT record FROM agent_runtime_receipts WHERE id=?')
      .get(id);
    if (typeof row?.record !== 'string')
      throw Error('actual begin receipt prerequisite');
    const changed = JSON.parse(row.record);
    if (mutation === 'foreign-answer') changed.answer = answer;
    if (mutation === 'wrong-variant')
      changed.answer = { kind: 'opened', snapshot: f.opened.snapshot };
    if (mutation === 'operation-id')
      changed.operationId = 'unrelated-operation';
    if (mutation === 'command-type') changed.commandType = 'pin';
    if (
      mutation === 'malformed-outer-id' ||
      mutation === 'noncanonical-outer-id' ||
      mutation === 'noncanonical-generation' ||
      mutation === 'missing-generation'
    ) {
      const generation = canonical([
        key.scopeId,
        key.conversationId,
        key.invocationId,
      ]);
      const replacement =
        mutation === 'malformed-outer-id'
          ? canonical([generation, f.begin.operationId, 'extra'])
          : mutation === 'noncanonical-outer-id'
            ? ` ${id}`
            : mutation === 'noncanonical-generation'
              ? canonical([
                  generation.replace('scope', '\\u0073cope'),
                  f.begin.operationId,
                ])
              : canonical([
                  canonical(['scope', 'absent', 'turn']),
                  f.begin.operationId,
                ]);
      f.database
        .prepare('UPDATE agent_runtime_receipts SET id=? WHERE id=?')
        .run(replacement, id);
    } else if (mutation === 'row-id')
      f.database
        .prepare('UPDATE agent_runtime_receipts SET id=? WHERE id=?')
        .run(
          canonical([
            canonical([key.scopeId, key.conversationId, key.invocationId]),
            'unrelated-operation',
          ]),
          id,
        );
    else
      f.database
        .prepare('UPDATE agent_runtime_receipts SET record=? WHERE id=?')
        .run(canonical(changed), id);
    const attemptsBefore = f.database
      .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
      .get(
        canonical([key.scopeId, key.conversationId, key.invocationId]),
      )?.record;
    const retry = await f.storage.execute(f.begin, f.context).then(
      (a) => a.kind,
      () => 'damaged',
    );
    const outsideScope = [
      'noncanonical-outer-id',
      'noncanonical-generation',
      'missing-generation',
    ].includes(mutation);
    if (outsideScope) {
      expect(retry).toBe('refused');
      expect(await f.storage.execute(f.begin, f.context)).toEqual({
        kind: 'refused',
        reason: 'stale',
      });
      expect(
        f.database
          .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
          .get(canonical([key.scopeId, key.conversationId, key.invocationId]))
          ?.record,
      ).toBe(attemptsBefore);
      expect(
        (
          await auditAgentRuntimeStore({
            database: f.database,
            policy: DEFAULT_MODEL_POLICY,
          })
        ).status,
      ).toBe('damaged');
    } else expect(retry).toBe('damaged');
    let reopened = false;
    try {
      const port = f.open();
      reopened = true;
      await port.close();
    } catch {
      /* Strict current record admission must fail closed. */
    }
    expect(reopened).toBe(outsideScope);
  });
it('R2.3 final guarded replay rejects a valid foreign tape header supplied after own admitted replay', async () => {
  const { f, answer: foreign } = await twoTapes();
  let admittedOwnReplay = false;
  let providerCalls = 0;
  const output: string[] = [];
  const runtime = createModelRuntime({
    admission: f.host,
    liveness: (owner) => (owner.id === nextOwner.id ? 'live' : 'dead'),
    storage: {
      async execute(command, context) {
        const answer = await f.storage.execute(command, context);
        if (command.type === 'begin' && answer.kind === 'replay') {
          expect(answer.tape).toEqual(f.tape);
          admittedOwnReplay = true;
        }
        return answer;
      },
      close: () => f.storage.close(),
    },
    bodies: {
      put: f.bodies.put,
      async read(ref) {
        return f.bodies.read(
          admittedOwnReplay && ref.codec === 'runtime-ai-sdk-v3-tape/1'
            ? foreign.tape
            : ref,
        );
      },
    },
  });
  const entry = await runtime.restore({
    key,
    observed: f.fence,
    owner: nextOwner,
    admission: f.admission,
  });
  const model: import('@ai-sdk/provider').LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'scripted',
    modelId: 'text',
    supportedUrls: {},
    async doGenerate() {
      throw Error('unsupported');
    },
    async doStream() {
      providerCalls++;
      throw Error('replay must never dispatch');
    },
  };
  const guarded = bindDurableAiSdkModel({ runtime, entry, model });
  const outcome = await runtime
    .bind(entry)
    .run(async () => {
      const { stream } = await guarded.doStream(nativeOptions);
      for await (const part of stream)
        if (part.type === 'text-delta') output.push(part.delta);
    })
    .then(
      () => 'accepted',
      () => 'refused',
    );
  expect(admittedOwnReplay).toBe(true);
  expect(providerCalls).toBe(0);
  expect(output).toEqual([]);
  expect(outcome).toBe('refused');
});
it('R2.3 own historical execute acknowledgment and replay remain valid after a real owner takeover', async () => {
  const f = await completedGeneration();
  cleanup.push(() => f.close());
  const restored = await f.storage.execute(
    operation({ type: 'takeOver', key, expected: f.fence, owner: nextOwner }),
    { liveness: () => 'dead' },
  );
  if (restored.kind !== 'restored')
    throw Error('real historical owner takeover prerequisite');
  expect(restored.snapshot.fence.owner).toEqual(nextOwner);
  expect(await f.storage.execute(f.begin, f.context)).toEqual({
    kind: 'acknowledged',
    fence: f.begun.fence,
    originalGrantId: f.begun.attempt.grantId,
  });
  expect(await f.storage.execute(f.replay, f.context)).toEqual(f.replayed);
  const current = await f.storage.execute(
    operation({
      type: 'begin',
      key,
      expected: restored.snapshot.fence,
      requestId: f.pin.requestId,
    }),
    f.context,
  );
  expect(current).toMatchObject({
    kind: 'replay',
    fence: restored.snapshot.fence,
    attempt: f.begun.attempt,
    tape: f.tape,
  });
});
