import { afterEach, expect, it } from 'vitest';
import { normalizePart, readTape, tapeBytes } from '../codecs.js';
import { canonical, RuntimeError } from '../encoding.js';
import {
  DEFAULT_MODEL_POLICY,
  drainModelOutbox,
  type RunKey,
} from '../index.js';
import { runRecordSchema } from '../records.js';
import { openSqliteRuntimeProjection } from '../sqlite.js';
import { fixture, key, operation, owner, parts } from './fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
for (const headers of ['distinct', 'same'] as const)
  it(`R3.1 ready refuses a foreign valid ${headers} header tape substituted only into its owning attempt`, async () => {
    const f = await fixture();
    cleanup.push(() => f.close());
    const sink = openSqliteRuntimeProjection({
      database: f.database,
      bodies: f.bodies,
      host: f.host,
      policy: DEFAULT_MODEL_POLICY,
    });
    cleanup.push(() => sink.close());
    const complete = async (
      runKey: RunKey,
      requestId: string,
      output: string,
    ) => {
      const opened = await f.storage.execute(
        operation({
          type: 'open',
          spec: { ...f.opened.snapshot.spec, key: runKey },
          owner,
        }),
        f.context,
      );
      if (opened.kind !== 'opened' && opened.kind !== 'existing')
        throw Error('actual generation prerequisite');
      const pin = { ...f.pin, requestId };
      const p = await f.storage.execute(
        operation({
          type: 'pin',
          key: runKey,
          expected: opened.snapshot.fence,
          pin,
        }),
        f.context,
      );
      if (p.kind === 'refused') throw Error('real pin prerequisite');
      const b = await f.storage.execute(
        operation({ type: 'begin', key: runKey, expected: p.fence, requestId }),
        f.context,
      );
      if (b.kind !== 'execute') throw Error('real fresh grant prerequisite');
      const tape = await f.bodies.put(
        'runtime-ai-sdk-v3-tape/1',
        tapeBytes(
          requestId,
          b.attempt.number,
          parts.map((p) =>
            normalizePart(
              p.type === 'text-delta' ? { ...p, delta: output } : p,
            ),
          ),
        ),
      );
      const c = await f.storage.execute(
        operation({
          type: 'complete',
          key: runKey,
          expected: b.fence,
          attempt: b.attempt,
          tape,
          lastPartialSequence: -1,
        }),
        f.context,
      );
      if (c.kind === 'refused') throw Error('real complete prerequisite');
      const settled = await f.storage.execute(
        operation({
          type: 'finish',
          key: runKey,
          expected: c.fence,
          status: 'completed',
        }),
        f.context,
      );
      if (settled.kind === 'refused')
        throw Error('actual settlement prerequisite');
      await drainModelOutbox(f.storage, sink, runKey, f.context);
      return tape;
    };
    const a = await complete(key, 'per-run-request', 'OWN-A');
    const b = await complete(
      { ...key, conversationId: 'B' },
      headers === 'same' ? 'per-run-request' : 'foreign-request',
      'FOREIGN-B',
    );
    const aBytes = await f.bodies.read(a);
    const bBytes = await f.bodies.read(b);
    const aTape = readTape(aBytes);
    const bTape = readTape(bBytes);
    expect(a.digest).not.toBe(b.digest);
    expect(aTape.attempt).toBe(bTape.attempt);
    expect(aTape.requestId === bTape.requestId).toBe(headers === 'same');
    const text = (tape: ReturnType<typeof readTape>) =>
      tape.parts
        .flatMap((p) => (p.type === 'text-delta' ? [p.delta] : []))
        .join('');
    expect(text(aTape)).toBe('OWN-A');
    expect(text(bTape)).toBe('FOREIGN-B');
    expect(await sink.readModelContext(key)).toEqual({
      kind: 'ready',
      tapes: [a],
    });
    expect(
      f.database
        .prepare(
          "SELECT count(*) AS n FROM agent_runtime_receipts WHERE json_extract(record,'$.answer.kind')='replay'",
        )
        .get()?.n,
    ).toBe(0);
    const id = canonical([key.scopeId, key.conversationId, key.invocationId]);
    const row = f.database
      .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
      .get(id);
    if (typeof row?.record !== 'string')
      throw Error('actual run row prerequisite');
    const original = row.record;
    const run = runRecordSchema.parse(JSON.parse(original));
    expect(run.pins[0]?.attempts[0]?.partials).toEqual([]);
    expect(run.pins[0]?.attempts[0]?.tape).toEqual(a);
    const authorities = () => ({
      outbox: f.database
        .prepare('SELECT id,record FROM agent_runtime_outbox ORDER BY id')
        .all(),
      applied: f.database
        .prepare('SELECT id,record FROM agent_runtime_projection ORDER BY id')
        .all(),
      receipts: f.database
        .prepare('SELECT id,record FROM agent_runtime_receipts ORDER BY id')
        .all(),
      bodies: f.database
        .prepare(
          'SELECT codec,digest,byte_length,bytes,format FROM agent_runtime_bodies ORDER BY codec,digest',
        )
        .all(),
      runCount: f.database
        .prepare('SELECT count(*) AS n FROM agent_runtime_runs')
        .get()?.n,
    });
    const before = authorities();
    const audit = await sink.readAudit(key);
    run.pins[0]!.attempts[0]!.tape = b;
    const corrupted = canonical(run);
    f.database
      .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
      .run(corrupted, id);
    let exposed = false;
    const released: string[] = [];
    try {
      const view = await sink.readModelContext(key);
      exposed = view.kind === 'ready';
      if (view.kind === 'ready')
        for (const ref of view.tapes)
          released.push(text(readTape(await f.bodies.read(ref))));
    } catch (error) {
      if (
        !(error instanceof RuntimeError) ||
        error.code !== 'DURABLE_RECORD_DAMAGED'
      )
        throw error;
    }
    expect.soft(exposed).toBe(false);
    expect.soft(released).toEqual([]);
    expect(authorities()).toEqual(before);
    expect(
      f.database
        .prepare('SELECT record FROM agent_runtime_runs WHERE id=?')
        .get(id)?.record,
    ).toBe(corrupted);
    expect(await sink.readAudit(key)).toEqual(audit);
    expect(await f.bodies.read(a)).toEqual(aBytes);
    expect(await f.bodies.read(b)).toEqual(bBytes);
    f.database
      .prepare('UPDATE agent_runtime_runs SET record=? WHERE id=?')
      .run(original, id);
    const restored = await sink.readModelContext(key);
    expect(restored).toEqual({ kind: 'ready', tapes: [a] });
    if (restored.kind !== 'ready')
      throw Error('restored own ready prerequisite');
    expect(text(readTape(await f.bodies.read(restored.tapes[0]!)))).toBe(
      'OWN-A',
    );
    expect(authorities()).toEqual(before);
  });
