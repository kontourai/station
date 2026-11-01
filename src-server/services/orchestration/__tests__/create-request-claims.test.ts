import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { DelegationFileRefusal } from '@kontourai/station-shared/delegation-files';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { SessionStartRefusedError } from '../../../providers/adapter-shape.js';
import { withStationControlCallerContext } from '../../../tools/station-control-shared.js';
import type { ForegroundMessageHandle } from '../../execution-target/execution-target-execution.js';
import { ReceiverExecutionRefusal } from '../../projects/project-contribution-service.js';
import {
  CreateRequestClaims,
  markCreateRequestStarting,
} from '../create-request-claims.js';

const temp = trackTempDirs();
const input = () => ({
  kind: 'foreground' as const,
  principal: undefined,
  authority: sessionReadAuthorityFromRequest('operator', undefined, undefined),
  requestKey: 'request-1',
  intent: { message: 'hello' },
  sessionExists: () => false,
});
const handle = (sessionId: string): ForegroundMessageHandle => ({
  conversationId: sessionId,
  sessionId,
  providerTurnId: 'turn-1',
  target: { kind: 'agent', id: agentId('agent') },
  resolution: {
    schemaVersion: 'station.execution-resolution/v1',
    resolvedAt: '2026-11-01T00:00:00Z',
    environmentId: environmentId('station'),
    agentId: agentId('agent'),
    engine: { kind: 'station' },
    provider: 'station-agent',
    modelLaunchPlan: { kind: 'engine-selected', evidence: 'adapter-declared' },
  },
});
function setup() {
  const home = temp('create-claims-');
  return {
    home,
    file: join(home, 'delegation-create-claims.json'),
    claims: new CreateRequestClaims(home),
  };
}
afterEach(() => vi.useRealTimers());

test('completed receipts replay for seven days, then expire without removing unresolved claims', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
  const { home, file, claims } = setup();
  const effect = vi.fn(async (id: string) => handle(id));
  const first = await claims.run(input(), effect);
  await expect(
    claims.run({ ...input(), requestKey: 'unresolved' }, async (id) => {
      await markCreateRequestStarting(id);
      throw new Error('lost receipt');
    }),
  ).rejects.toThrow('lost receipt');
  vi.setSystemTime(new Date('2026-11-07T23:59:59.999Z'));
  expect(await new CreateRequestClaims(home).run(input(), effect)).toEqual(
    first,
  );
  vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
  expect((await claims.run(input(), effect)).sessionId).not.toBe(
    first.sessionId,
  );
  expect(effect).toHaveBeenCalledTimes(2);
  expect(
    Object.keys(JSON.parse(readFileSync(file, 'utf8')).claims),
  ).toHaveLength(2);
  await expect(
    claims.run({ ...input(), requestKey: 'unresolved' }, effect),
  ).rejects.toMatchObject({ outcome: 'indeterminate' });
});

test('exactly 1024 retained claims refuse a new request before any effect with a typed capacity result', async () => {
  const { file, claims } = setup();
  await claims.run(input(), async (id) => handle(id));
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  const row = Object.values(ledger.claims)[0];
  ledger.claims = Object.fromEntries(
    Array.from({ length: 1024 }, (_, n) => [
      n.toString(16).padStart(64, '0'),
      row,
    ]),
  );
  writeFileSync(file, JSON.stringify(ledger));
  const effect = vi.fn(async (id: string) => handle(id));
  await expect(
    claims.run({ ...input(), requestKey: 'overflow' }, effect),
  ).rejects.toMatchObject({
    code: 'create_request_capacity',
    limit: 'records',
  });
  expect(effect).not.toHaveBeenCalled();
});

test('receipt byte capacity is reserved before execution, including room for the pending result', async () => {
  const { file, claims } = setup();
  await claims.run(input(), async (id) => handle(id));
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  const row = Object.values(ledger.claims)[0] as {
    result: { resolution: unknown };
  };
  row.result.resolution = { padding: '' };
  row.result.resolution = {
    padding: 'x'.repeat(
      4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(ledger)) - 1000,
    ),
  };
  writeFileSync(file, JSON.stringify(ledger));
  const effect = vi.fn(async (id: string) => handle(id));
  await expect(
    claims.run({ ...input(), requestKey: 'overflow' }, effect),
  ).rejects.toMatchObject({ code: 'create_request_capacity', limit: 'bytes' });
  expect(effect).not.toHaveBeenCalled();
});

test.each([
  [
    'receiver unavailable',
    new SessionStartRefusedError(
      'receiver unavailable',
      'provider_session_start_failed',
    ),
  ],
  [
    'delegation_files_unsupported',
    new DelegationFileRefusal('delegation_files_unsupported'),
  ],
  ['bind failure', new Error('bind failure')],
  [
    'receiver policy refusal',
    new ReceiverExecutionRefusal(
      'execution_preparation_version_mismatch',
      'receiver policy refused',
    ),
  ],
])('a pre-start refusal (%s) releases the key', async (_name, refusal) => {
  const { claims, file } = setup();
  await expect(
    claims.run(input(), async () => {
      throw refusal;
    }),
  ).rejects.toBe(refusal);
  expect(
    Object.keys(JSON.parse(readFileSync(file, 'utf8')).claims),
  ).toHaveLength(0);
  await expect(
    claims.run(input(), async (id) => handle(id)),
  ).resolves.toMatchObject({ providerTurnId: 'turn-1' });
});

test('a typed rejected start with no session releases even its starting mark', async () => {
  const { claims } = setup();
  await expect(
    claims.run(input(), async (id) => {
      await markCreateRequestStarting(id);
      throw new SessionStartRefusedError(
        'receiver unavailable',
        'provider_session_start_failed',
      );
    }),
  ).rejects.toThrow('receiver unavailable');
  await expect(
    claims.run(input(), async (id) => handle(id)),
  ).resolves.toMatchObject({ providerTurnId: 'turn-1' });
});

test("two verified local agent sessions under one user cannot replay each other's handle", async () => {
  const { claims } = setup();
  const effect = vi.fn(async (id: string) => handle(id));
  const asCaller = (sessionId: string) =>
    withStationControlCallerContext(
      { token: 'fixture', resolve: () => ({ sessionId, assurance: 'bound' }) },
      () => claims.run(input(), effect),
    );
  const first = await asCaller('agent-a');
  const second = await asCaller('agent-b');
  expect(first.sessionId).not.toBe(second.sessionId);
  expect(await asCaller('agent-a')).toEqual(first);
  expect(effect).toHaveBeenCalledTimes(2);
  await expect(
    withStationControlCallerContext(
      {
        token: 'fixture',
        resolve: () => ({ sessionId: 'agent-a', assurance: 'bound' }),
      },
      () =>
        claims.run({ ...input(), intent: { message: 'different' } }, effect),
    ),
  ).rejects.toMatchObject({ code: 'create_request_conflict' });
});

test('legacy completion timestamps are durably migrated even when capacity refuses the first new create', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
  const { file, claims } = setup();
  await claims.run(input(), async (id) => handle(id));
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  const row = Object.values(ledger.claims)[0] as {
    digest: string;
    completedAt?: number;
  };
  row.digest = createHash('sha256').update(row.digest).digest('hex');
  delete row.completedAt;
  ledger.version = 1;
  ledger.claims = Object.fromEntries(
    Array.from({ length: 1024 }, (_, n) => [
      n.toString(16).padStart(64, '0'),
      row,
    ]),
  );
  writeFileSync(file, JSON.stringify(ledger));
  const effect = vi.fn(async (id: string) => handle(id));
  await expect(
    claims.run({ ...input(), requestKey: 'new' }, effect),
  ).rejects.toMatchObject({ code: 'create_request_capacity' });
  expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(2);
  vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
  await expect(
    claims.run({ ...input(), requestKey: 'new' }, effect),
  ).resolves.toMatchObject({ providerTurnId: 'turn-1' });
  expect(effect).toHaveBeenCalledTimes(1);
});

test('an oversized completion remains indeterminate within its reserved storage budget', async () => {
  const { claims, file } = setup();
  const effect = vi.fn(async (id: string) => ({
    ...handle(id),
    resolution: {
      ...handle(id).resolution,
      definitionFingerprint: 'x'.repeat(4096),
    },
  }));
  await expect(claims.run(input(), effect)).rejects.toMatchObject({
    code: 'create_request_indeterminate',
  });
  await expect(claims.run(input(), effect)).rejects.toMatchObject({
    code: 'create_request_indeterminate',
  });
  expect(effect).toHaveBeenCalledTimes(1);
  expect(Buffer.byteLength(readFileSync(file))).toBeLessThan(4096);
});

test('a completed create retires its async starting capability before later callbacks run', async () => {
  const { claims, file } = setup();
  let release!: () => void;
  let late!: Promise<void>;
  await claims.run(input(), async (id) => {
    const later = new Promise<void>((resolve) => {
      release = resolve;
    });
    late = later.then(() => markCreateRequestStarting('another-request'));
    return handle(id);
  });
  const before = readFileSync(file, 'utf8');
  release();
  await expect(late).resolves.toBeUndefined();
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('changed input conflicts while the original create is still running', async () => {
  const { claims } = setup();
  let entered!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const original = claims.run(input(), async (id) => {
    entered();
    await hold;
    return handle(id);
  });
  await ready;
  const other = vi.fn(async (id: string) => handle(id));
  try {
    await expect(
      claims.run({ ...input(), intent: { message: 'different' } }, other),
    ).rejects.toMatchObject({ code: 'create_request_conflict' });
    expect(other).not.toHaveBeenCalled();
  } finally {
    finish();
    await original;
  }
});
