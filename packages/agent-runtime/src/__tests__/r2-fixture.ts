import { normalizePart, tapeBytes } from '../codecs.js';
import { fixture, key, operation, owner, parts } from './fixture.js';

export async function completedGeneration(
  kind: 'memory' | 'sqlite' = 'sqlite',
) {
  const f = await fixture(kind);
  const open = operation({ type: 'open', spec: f.opened.snapshot.spec, owner });
  const opened = await f.storage.execute(open, f.context);
  if (opened.kind !== 'existing') throw Error('saved open prerequisite');
  const p = await f.storage.execute(
    operation({
      type: 'pin',
      key,
      expected: f.opened.snapshot.fence,
      pin: f.pin,
    }),
    f.context,
  );
  if (p.kind === 'refused') throw Error('real pin prerequisite');
  const begin = operation({
    type: 'begin',
    key,
    expected: p.fence,
    requestId: f.pin.requestId,
  });
  const b = await f.storage.execute(begin, f.context);
  if (b.kind !== 'execute') throw Error('real begin prerequisite');
  const tape = await f.bodies.put(
    'runtime-ai-sdk-v3-tape/1',
    tapeBytes(f.pin.requestId, b.attempt.number, parts.map(normalizePart)),
  );
  const c = await f.storage.execute(
    operation({
      type: 'complete',
      key,
      expected: b.fence,
      attempt: b.attempt,
      tape,
      lastPartialSequence: -1,
    }),
    f.context,
  );
  if (c.kind === 'refused') throw Error('real complete prerequisite');
  const replay = operation({
    type: 'begin',
    key,
    expected: c.fence,
    requestId: f.pin.requestId,
  });
  const replayed = await f.storage.execute(replay, f.context);
  if (replayed.kind !== 'replay') throw Error('saved own replay prerequisite');
  return {
    ...f,
    savedOpen: open,
    begin,
    begun: b,
    replay,
    replayed,
    fence: c.fence,
    tape,
  };
}
