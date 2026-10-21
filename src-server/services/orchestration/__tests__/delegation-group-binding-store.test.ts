import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  type DelegationGroupBinding,
  delegationGroupBindingKey,
  FileDelegationGroupBindingStore,
} from '../delegation-group-binding-store.js';

let dir: string;
let store: FileDelegationGroupBindingStore;
const digest = `sha256:${'a'.repeat(64)}`;
const scope = {
  hostId: 'host',
  principalId: 'human:local:operator',
  tenantId: null,
};

function binding(
  overrides: Partial<DelegationGroupBinding> = {},
): DelegationGroupBinding {
  return {
    scope,
    groupId: 'group-1',
    seatId: 'seat-1',
    controllerId: 'controller',
    controllerGeneration: 1,
    authorityId: 'authority-1',
    authorityEpoch: 1,
    authorityDigest: digest,
    envelopeId: 'envelope-1',
    envelopeGeneration: 1,
    envelopeDigest: digest,
    taskId: 'task:1',
    conversationId: 'conversation-1',
    sessionId: 'session-1',
    clientTurnId: 'client-turn-1',
    invocationId: 'invocation-1',
    ...overrides,
  };
}

function reserve(
  overrides: Partial<DelegationGroupBinding> = {},
  operationId = 'operation-1',
) {
  return { binding: binding(overrides), operationId, intentDigest: digest };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'station-group-binding-'));
  store = new FileDelegationGroupBindingStore(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('durable group launch identity', () => {
  test('concurrent instances reserve one owner; reopen joins without disclosing its token', async () => {
    const other = new FileDelegationGroupBindingStore(dir);
    const outcomes = await Promise.all([
      store.reserve(reserve()),
      other.reserve(reserve()),
    ]);
    expect(outcomes.map((r) => r.kind).sort()).toEqual(['created', 'existing']);
    const created = outcomes.find((r) => r.kind === 'created');
    if (created?.kind !== 'created') throw new Error('No reservation owner');
    const reopened = new FileDelegationGroupBindingStore(dir);
    const replay = await reopened.reserve(reserve());
    expect(replay).toEqual({ kind: 'existing', record: created.record });
    const file = join(dir, 'delegation-group-bindings', 'bindings.json');
    expect(readFileSync(file, 'utf8')).not.toContain(created.ownerToken);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'delegation-group-bindings')).mode & 0o777).toBe(
      0o700,
    );
    await expect(
      reopened.reserve({
        ...reserve(),
        intentDigest: `sha256:${'b'.repeat(64)}`,
      }),
    ).rejects.toThrow('operation_intent_conflict');
  });

  test('launch intent survives a crash; only its exact owner advances actual turn evidence', async () => {
    const created = await store.reserve(reserve());
    if (created.kind !== 'created') throw new Error('No reservation owner');
    const base = { binding: binding(), ownerToken: created.ownerToken };
    await store.advance({
      ...base,
      expectedRevision: 1,
      transition: { state: 'launch-intent' },
    });
    const reopened = new FileDelegationGroupBindingStore(dir);
    expect(
      await reopened.findTurn(scope, 'session-1', 'client-turn-1'),
    ).toMatchObject({ state: 'launch-intent', providerTurnId: null });
    await expect(
      reopened.advance({
        ...base,
        ownerToken: 'b'.repeat(64),
        expectedRevision: 2,
        transition: { state: 'session-started' },
      }),
    ).rejects.toThrow('owner_mismatch');
    await expect(
      reopened.advance({
        ...base,
        expectedRevision: 1,
        transition: { state: 'session-started' },
      }),
    ).rejects.toThrow('revision_conflict');
    await reopened.advance({
      ...base,
      expectedRevision: 2,
      transition: { state: 'session-started' },
    });
    await reopened.advance({
      ...base,
      expectedRevision: 3,
      transition: {
        state: 'turn-accepted',
        providerTurnId: 'provider-turn-actual',
      },
    });
    await expect(
      reopened.advance({
        ...base,
        expectedRevision: 4,
        transition: {
          state: 'observed',
          providerTurnId: 'other-turn',
          observationRef: digest,
        },
      }),
    ).rejects.toThrow('provider_turn_conflict');
    await reopened.advance({
      ...base,
      expectedRevision: 4,
      transition: {
        state: 'observed',
        providerTurnId: 'provider-turn-actual',
        observationRef: digest,
      },
    });
    expect(
      await reopened.read(scope, delegationGroupBindingKey(binding())),
    ).toMatchObject({
      state: 'observed',
      revision: 5,
      providerTurnId: 'provider-turn-actual',
    });
    await expect(
      reopened.advance({
        ...base,
        expectedRevision: 5,
        transition: { state: 'launch-intent' },
      }),
    ).rejects.toThrow('transition_conflict');
  });

  test('capacity retains prior intents and refuses new membership', async () => {
    store = new FileDelegationGroupBindingStore(dir, { capacity: 1 });
    await store.reserve(reserve());
    await expect(
      store.reserve(
        reserve(
          {
            seatId: 'seat-2',
            clientTurnId: 'turn-2',
            invocationId: 'invoke-2',
          },
          'operation-2',
        ),
      ),
    ).rejects.toThrow('capacity');
    expect((await store.reserve(reserve())).kind).toBe('existing');
  });

  test('cannot reset an authority into a second group or attach a turn to two seats', async () => {
    await store.reserve(reserve());
    await expect(
      store.reserve(
        reserve(
          {
            groupId: 'group-2',
            clientTurnId: 'turn-2',
            invocationId: 'invoke-2',
          },
          'operation-2',
        ),
      ),
    ).rejects.toThrow('authority_already_bound');
    await expect(
      store.reserve(
        reserve({ seatId: 'seat-2', invocationId: 'invoke-2' }, 'operation-2'),
      ),
    ).rejects.toThrow('duplicate_binding');
    await expect(
      store.reserve(
        reserve(
          {
            envelopeGeneration: 2,
            clientTurnId: 'turn-2',
            invocationId: 'invoke-2',
          },
          'operation-2',
        ),
      ),
    ).rejects.toThrow('seat_membership_conflict');
    expect(
      await store.findTurn(
        { ...scope, principalId: 'other-user' },
        'session-1',
        'client-turn-1',
      ),
    ).toBeUndefined();
  });

  test('conversation membership survives session rollover without overwriting the old turn', async () => {
    await store.reserve(reserve());
    await store.reserve(
      reserve(
        {
          sessionId: 'session-2',
          clientTurnId: 'turn-2',
          invocationId: 'invoke-2',
        },
        'operation-2',
      ),
    );
    expect(
      (await store.findTurn(scope, 'session-1', 'client-turn-1'))?.binding
        .sessionId,
    ).toBe('session-1');
    expect(
      (await store.findTurn(scope, 'session-2', 'turn-2'))?.binding
        .conversationId,
    ).toBe('conversation-1');
  });

  test.each([
    'null',
    '{"version":1,"records":[]',
    '{"version":2,"records":[]}',
  ])('corrupt ledger %s cannot become an empty store', async (bytes) => {
    await store.reserve(reserve());
    writeFileSync(
      join(dir, 'delegation-group-bindings', 'bindings.json'),
      bytes,
    );
    await expect(store.reserve(reserve())).rejects.toThrow();
  });

  test('aliased or publicly readable storage refuses replay disclosure', async () => {
    await store.reserve(reserve());
    const file = join(dir, 'delegation-group-bindings', 'bindings.json');
    chmodSync(file, 0o644);
    await expect(
      store.findTurn(scope, 'session-1', 'client-turn-1'),
    ).rejects.toThrow('unsafe_storage');
    chmodSync(file, 0o600);
    linkSync(file, join(dir, 'alias.json'));
    await expect(
      store.findTurn(scope, 'session-1', 'client-turn-1'),
    ).rejects.toThrow('unsafe_storage');
  });
});
