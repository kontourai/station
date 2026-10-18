import { afterEach, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_POLICY,
  ModelMemoryVolume,
  openMemoryModelStorage,
} from '../index.js';
import { fixture, key, operation, owner } from './fixture.js';
import { deferred } from './r1-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
it('R1.1 memory input and returned ownership cannot mutate shared committed state', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const volume = new ModelMemoryVolume();
  const open = () =>
    openMemoryModelStorage({
      volume,
      bodies: f.bodies,
      host: f.host,
      policy: DEFAULT_MODEL_POLICY,
    });
  const storage = open();
  const peer = open();
  cleanup.push(() => peer.close());
  cleanup.push(() => storage.close());
  const spec = {
    ...f.opened.snapshot.spec,
    entry: { ...f.opened.snapshot.spec.entry },
  };
  const mutableOwner = { ...owner };
  const command = operation({ type: 'open', spec, owner: mutableOwner });
  const opened = await storage.execute(command, f.context);
  if (opened.kind !== 'opened') throw Error('real open prerequisite');
  const snapshot = structuredClone(opened.snapshot);
  mutableOwner.id = 'MUTATED-INPUT';
  spec.entry.sourceCutoff = 'MUTATED-INPUT';
  Object.assign(opened.snapshot.fence, { revision: '900' });
  Object.assign(opened.snapshot.spec.entry, { sourceCutoff: 'MUTATED-RESULT' });
  expect(await peer.execute({ type: 'read', key }, f.context)).toEqual({
    kind: 'found',
    snapshot,
    pins: [],
  });
  const pinned = await storage.execute(
    operation({ type: 'pin', key, expected: snapshot.fence, pin: f.pin }),
    f.context,
  );
  expect(pinned.kind).toBe('applied');
  if (pinned.kind === 'refused')
    throw Error('legitimate fenced write prerequisite');
  const b = await storage.execute(
    operation({
      type: 'begin',
      key,
      expected: pinned.fence,
      requestId: f.pin.requestId,
    }),
    f.context,
  );
  if (b.kind !== 'execute') throw Error('begin prerequisite');
  const expectedOwner = structuredClone(b.attempt.owner);
  Object.assign(b.attempt.owner, { id: 'MUTATED-ATTEMPT' });
  Object.assign(b.fence, { revision: '901' });
  const read = await peer.execute({ type: 'read', key }, f.context);
  expect(read.kind === 'found' ? read.snapshot.fence.owner : read).toEqual(
    expectedOwner,
  );
});
it('R1.1 memory snapshots command before real asynchronous body read and detaches participant views', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const entered = deferred();
  const release = deferred();
  let hold = true;
  const volume = new ModelMemoryVolume();
  let secondView = '';
  const bodies = {
    put: f.bodies.put,
    async read(ref: Parameters<typeof f.bodies.read>[0]) {
      if (hold) {
        hold = false;
        entered.resolve();
        await release.promise;
      }
      return f.bodies.read(ref);
    },
  };
  const storage = openMemoryModelStorage({
    volume,
    bodies,
    host: f.host,
    policy: DEFAULT_MODEL_POLICY,
    participants: [
      {
        name: 'mutator',
        commit(v) {
          if (v.command.type === 'open') {
            Object.assign(v.command.spec.entry, {
              sourceCutoff: 'PARTICIPANT',
            });
            if (v.result.kind === 'opened')
              Object.assign(v.result.snapshot.fence, { revision: '333' });
          }
        },
      },
      {
        name: 'observer',
        commit(v) {
          if (v.command.type === 'open')
            secondView = v.command.spec.entry.sourceCutoff;
        },
      },
    ],
  });
  cleanup.push(() => storage.close());
  const spec = {
    ...f.opened.snapshot.spec,
    entry: { ...f.opened.snapshot.spec.entry },
  };
  const input = operation({ type: 'open', spec, owner: { ...owner } });
  const pending = storage.execute(input, f.context);
  await entered.promise;
  spec.entry.sourceCutoff = 'SUSPENDED-CALLER';
  release.resolve();
  const answer = await pending;
  expect(answer.kind).toBe('opened');
  expect(secondView).toBe('A');
  const peer = openMemoryModelStorage({
    volume,
    bodies: f.bodies,
    host: f.host,
    policy: DEFAULT_MODEL_POLICY,
  });
  cleanup.push(() => peer.close());
  expect(await peer.execute({ type: 'read', key }, f.context)).toMatchObject({
    snapshot: {
      spec: { entry: { sourceCutoff: 'A' } },
      fence: { revision: '0' },
    },
  });
});
it('R1.4 memory reauthorizes after async body validation before staged commit', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const entered = deferred();
  const release = deferred();
  let revoked = false;
  let hold = true;
  const volume = new ModelMemoryVolume();
  const storage = openMemoryModelStorage({
    volume,
    policy: DEFAULT_MODEL_POLICY,
    host: () => {
      if (revoked) throw Error('revoked');
      return f.admission;
    },
    bodies: {
      put: f.bodies.put,
      async read(ref) {
        if (hold) {
          hold = false;
          entered.resolve();
          await release.promise;
        }
        return f.bodies.read(ref);
      },
    },
  });
  cleanup.push(() => storage.close());
  const pending = storage.execute(
    operation({ type: 'open', spec: f.opened.snapshot.spec, owner }),
    f.context,
  );
  await entered.promise;
  revoked = true;
  release.resolve();
  expect(await pending).toEqual({ kind: 'refused', reason: 'unavailable' });
  const peer = openMemoryModelStorage({
    volume,
    policy: DEFAULT_MODEL_POLICY,
    host: f.host,
    bodies: f.bodies,
  });
  cleanup.push(() => peer.close());
  expect(await peer.execute({ type: 'read', key }, f.context)).toEqual({
    kind: 'absent',
  });
});
it('memory fixed-open configuration rejects inherited objects and accessor authority without invoking it', async () => {
  const f = await fixture();
  cleanup.push(() => f.close());
  const options = {
    volume: new ModelMemoryVolume(),
    bodies: f.bodies,
    host: f.host,
    policy: DEFAULT_MODEL_POLICY,
  };
  Object.setPrototypeOf(options, { untrusted: true });
  expect(() => openMemoryModelStorage(options)).toThrow('DURABLE_UNSUPPORTED');
  const own = {
    volume: new ModelMemoryVolume(),
    bodies: f.bodies,
    host: f.host,
    policy: DEFAULT_MODEL_POLICY,
  };
  let reads = 0;
  Object.defineProperty(own, 'host', {
    enumerable: true,
    get() {
      reads++;
      return f.host;
    },
  });
  expect(() => openMemoryModelStorage(own)).toThrow('DURABLE_UNSUPPORTED');
  expect(reads).toBe(0);
});
for (const kind of ['memory', 'sqlite'] as const)
  for (const shape of [
    'getter',
    'toJSON',
    'undefined',
    'NaN',
    'symbol',
    'hidden',
  ] as const)
    it(`ownership ${kind} isolates liveness ${shape} mutation before any owned-record probe`, async () => {
      const f = await fixture(kind);
      cleanup.push(() => f.close());
      let calls = 0;
      let invoked = 0;
      const context = {
        liveness(view: import('@kontourai/monument').OwnerIdentity) {
          calls++;
          if (shape === 'getter')
            Object.defineProperty(view, 'pid', {
              enumerable: true,
              get() {
                invoked++;
                return 123;
              },
            });
          if (shape === 'toJSON')
            Object.assign(view, {
              toJSON() {
                invoked++;
                return {};
              },
            });
          if (shape === 'undefined') Object.assign(view, { birth: undefined });
          if (shape === 'NaN') Object.assign(view, { pid: NaN });
          if (shape === 'symbol')
            Object.defineProperty(view, Symbol('injected'), { value: 'x' });
          if (shape === 'hidden')
            Object.defineProperty(view, 'hidden', { value: 'x' });
          return 'live' as const;
        },
      };
      const result = await f.storage
        .execute(
          operation({
            type: 'pin',
            key,
            expected: f.opened.snapshot.fence,
            pin: f.pin,
          }),
          context,
        )
        .then(
          (answer) => answer.kind,
          () => 'rejected',
        );
      expect(calls).toBe(1);
      expect(invoked).toBe(0);
      expect(result).toBe('applied');
      expect(
        await f.storage.execute({ type: 'read', key }, f.context),
      ).toMatchObject({ snapshot: { fence: { owner } } });
    });
