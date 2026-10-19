/**
 * #3559: a client-turn dedup claim whose owner process died may be retried
 * only when that owner provably never began invoking the engine.
 *
 * Each case runs a REAL owner process (the production OrchestrationService
 * over a real SQLite EventStore), SIGKILLs it at a chosen point, then reopens
 * the same store in this process with a fresh service. Boot recovery retires
 * the dead owner's turn boundary first, exactly as a restarted Station does,
 * so the retry below is decided by the dedup claim alone.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderSendTurnInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { turnDedupKey } from '../sqlite-turn-dedup-persistence.js';

const CHILD_TIMEOUT_MS = 60_000;
const THREAD_ID = 'thread-3559';
const CLIENT_TURN_ID = 'client-turn-3559';
/**
 * The claim upsert of the binary before #3559, verbatim
 * (b45e155766:src-server/services/orchestration/sqlite-turn-dedup-persistence.ts:110).
 * A peer or downgraded runtime still writes rows with it.
 */
const PRE_3559_CLAIM_UPSERT = `INSERT INTO orchestration_turn_dedup (dedup_key, value, created_at, owner_json) VALUES (?, ?, ?, ?) ON CONFLICT(dedup_key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, owner_json = excluded.owner_json`;

function moduleUrl(path: string): string {
  return JSON.stringify(pathToFileURL(resolve(process.cwd(), path)).href);
}

/**
 * The owner process. `invoked`: the keyed send reaches `adapter.sendTurn`,
 * which never returns. `pre-invoke`: an unkeyed send holds the thread's
 * turn-start lock inside `sendTurn`, so the keyed send durably claims its key
 * and then waits for that lock, before its own `beginInvocation`.
 */
const OWNER_PROGRAM = `
  import { DatabaseSync } from 'node:sqlite';
  import { EventStore } from ${moduleUrl('src-server/services/orchestration/event-store.ts')};
  import { EventBus } from ${moduleUrl('src-server/services/orchestration/event-bus.ts')};
  import { OrchestrationService } from ${moduleUrl('src-server/services/orchestration/orchestration-service.ts')};
  import { turnDedupKey } from ${moduleUrl('src-server/services/orchestration/sqlite-turn-dedup-persistence.ts')};
  import { GateTestAdapter, createGateTestRegistry } from ${moduleUrl('src-server/__test-utils__/orchestration-gate-test-harness.ts')};
  const [dbPath, mode, threadId, clientTurnId] = process.argv.slice(1);
  const report = (step, extra = {}) =>
    process.stdout.write(JSON.stringify({ step, ...extra }) + '\\n');
  class CrashPointAdapter extends GateTestAdapter {
    started = new Set();
    async startSession(input) {
      this.started.add(input.threadId);
      return super.startSession(input);
    }
    async hasSession(threadId) {
      return this.started.has(threadId);
    }
    sendTurn(input) {
      report('adapter-invoked', { clientTurnId: input.clientTurnId ?? null });
      if (mode === 'accepted') return Promise.resolve({ threadId: input.threadId, turnId: 'accepted-before-crash' });
      return new Promise(() => {});
    }
  }
  const eventStore = new EventStore(dbPath);
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(new CrashPointAdapter()),
    eventBus: new EventBus(),
    eventStore,
    logger: { debug() {}, warn() {} },
  });
  service.initialize();
  await service.dispatch({
    type: 'startSession',
    input: { threadId, provider: 'claude' },
  });
  const send = (input) =>
    void service
      .dispatch({ type: 'sendTurn', input: { threadId, ...input } })
      .then(result => { if (mode === 'accepted') report('accepted', { turnId: result.turnId }); })
      .catch((error) => report('send-failed', { message: String(error?.message ?? error) }));
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  const claimRow = () =>
    reader
      .prepare('SELECT value FROM orchestration_turn_dedup WHERE dedup_key = ?')
      .get(turnDedupKey(threadId, clientTurnId));
  const waitForClaim = async () => {
    const deadline = Date.now() + 20_000;
    while (!claimRow()) {
      if (Date.now() > deadline) throw new Error('keyed claim never landed');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  if (mode === 'invoked' || mode === 'accepted') {
    send({ input: 'keyed', clientTurnId });
  } else {
    send({ input: 'unkeyed lock holder' });
    await new Promise((r) => setTimeout(r, 200));
    send({ input: 'keyed', clientTurnId });
    await waitForClaim();
    // Give the keyed send every chance to run ahead; it must still be queued.
    await new Promise((r) => setTimeout(r, 200));
    report('claimed-before-invocation');
  }
  setInterval(() => undefined, 1000);
`;

type OwnerStep = { step: string; clientTurnId?: string | null };

class CountingAdapter extends GateTestAdapter {
  readonly sent: ProviderSendTurnInput[] = [];
  override async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    this.sent.push(input);
    return {
      threadId: input.threadId,
      turnId: `retry-turn-${this.sent.length}`,
    };
  }
}

async function waitFor<T>(
  read: () => T,
  matches: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = read();
    if (matches(value)) return value;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for ${label}: ${JSON.stringify(value)}`,
      );
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('client-turn dedup after a killed owner (#3559)', () => {
  // Created before the afterEach below: after-hooks run in reverse order, so
  // these directories are removed only once the children and stores closed.
  const makeTempDir = trackTempDirs();
  const children: ChildProcess[] = [];
  const stores: EventStore[] = [];
  const services: OrchestrationService[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
    for (const service of services.splice(0)) await service.shutdown();
    for (const store of stores.splice(0)) store.close();
  });

  /** Starts the owner, waits for `until`, SIGKILLs it, and returns every step it reported. */
  async function killOwnerAt(
    dbPath: string,
    mode: 'invoked' | 'pre-invoke' | 'accepted',
    until: string,
  ): Promise<OwnerStep[]> {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        OWNER_PROGRAM,
        dbPath,
        mode,
        THREAD_ID,
        CLIENT_TURN_ID,
      ],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    children.push(child);
    const steps: OwnerStep[] = [];
    let stdout = '';
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `owner never reported ${until}: ${JSON.stringify(steps)} ${stderr}`,
            ),
          ),
        CHILD_TIMEOUT_MS,
      );
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `owner exited ${code} before ${until}: ${JSON.stringify(steps)} ${stderr}`,
          ),
        );
      });
      child.stdout!.on('data', (chunk) => {
        stdout += String(chunk);
        const lines = stdout.split('\n');
        stdout = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const step = JSON.parse(line) as OwnerStep;
          steps.push(step);
          if (step.step === until) {
            clearTimeout(timer);
            resolvePromise();
          }
        }
      });
    });
    child.removeAllListeners('exit');
    child.kill('SIGKILL');
    await once(child, 'exit');
    expect(child.signalCode).toBe('SIGKILL');
    return steps;
  }

  /** Reopens the store the way a restarted Station does and lets boot recovery settle. */
  async function restart(dbPath: string) {
    const eventStore = new EventStore(dbPath);
    stores.push(eventStore);
    const adapter = new CountingAdapter();
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: new EventBus(),
      eventStore,
      logger: { debug() {}, warn() {} },
    });
    services.push(service);
    service.initialize();
    // Boot recovery banners the dead owner's turn and removes its boundary
    // row, which is what makes the thread accept a new turn again.
    await waitFor(
      () =>
        eventStore.sessionTurnBoundaryAuthority().hasPossibleEffect(THREAD_ID),
      (value) => value.kind === 'available' && value.active === false,
      'boot recovery to retire the dead owner boundary',
    );
    return { adapter, service };
  }

  function retry(service: OrchestrationService, text = 'keyed') {
    return service.dispatch({
      type: 'sendTurn',
      input: {
        threadId: THREAD_ID,
        input: text,
        clientTurnId: CLIENT_TURN_ID,
      },
    });
  }

  function newStorePath(): string {
    return join(makeTempDir('turn-dedup-crash-'), 'orchestration.sqlite');
  }

  test(
    'a retry after the owner was killed inside adapter.sendTurn never reaches the adapter and reports indeterminate',
    async () => {
      const dbPath = newStorePath();
      const steps = await killOwnerAt(dbPath, 'invoked', 'adapter-invoked');
      expect(steps).toContainEqual({
        step: 'adapter-invoked',
        clientTurnId: CLIENT_TURN_ID,
      });

      const { adapter, service } = await restart(dbPath);
      await expect(retry(service)).rejects.toMatchObject({
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
      });
      expect(adapter.sent).toHaveLength(0);

      // Fail closed on every later retry too: the answer is durable, not a
      // one-shot verdict that a second attempt could slip past.
      await expect(retry(service)).rejects.toMatchObject({
        outcome: 'indeterminate',
      });
      expect(adapter.sent).toHaveLength(0);
    },
    CHILD_TIMEOUT_MS * 2,
  );

  test(
    '#3567: an accepted keyed input retains its digest after SIGKILL; changed input conflicts and identical input replays without invoking',
    async () => {
      const dbPath = newStorePath();
      const steps = await killOwnerAt(dbPath, 'accepted', 'accepted');
      expect(steps.filter((step) => step.step === 'adapter-invoked')).toEqual([
        { step: 'adapter-invoked', clientTurnId: CLIENT_TURN_ID },
      ]);
      const { adapter, service } = await restart(dbPath);
      await expect(retry(service, 'different input')).rejects.toMatchObject({
        code: 'client_turn_input_conflict',
      });
      expect(adapter.sent).toHaveLength(0);
      await expect(retry(service)).resolves.toMatchObject({
        turnId: 'accepted-before-crash',
      });
      expect(adapter.sent).toHaveLength(0);
    },
    CHILD_TIMEOUT_MS * 2,
  );

  test(
    'a retry after an older binary took over a pending claim, invoked and died is indeterminate',
    async () => {
      const dbPath = newStorePath();
      // This binary claimed the key (pending) and died before invoking.
      await killOwnerAt(dbPath, 'pre-invoke', 'claimed-before-invocation');
      // An older peer or downgraded runtime then reclaimed that dead claim
      // under its own owner with its exact upsert, called the provider (which
      // writes nothing to this table) and died in turn.
      const database = new DatabaseSync(dbPath);
      try {
        database.prepare(PRE_3559_CLAIM_UPSERT).run(
          turnDedupKey(THREAD_ID, CLIENT_TURN_ID),
          null,
          Date.now(),
          JSON.stringify({
            pid: 999_999_999,
            birth: 'older-binary-birth',
            token: 'older-binary-owner',
            identityKind: 'exact',
          }),
        );
      } finally {
        database.close();
      }

      const { adapter, service } = await restart(dbPath);
      await expect(retry(service)).rejects.toMatchObject({
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
      });
      expect(adapter.sent).toHaveLength(0);
    },
    CHILD_TIMEOUT_MS * 2,
  );

  test(
    'control: a retry after the owner was killed before beginInvocation is reclaimed and sends exactly once',
    async () => {
      const dbPath = newStorePath();
      const steps = await killOwnerAt(
        dbPath,
        'pre-invoke',
        'claimed-before-invocation',
      );
      // Only the unkeyed lock holder reached the engine; the keyed send was
      // still queued behind it when the owner died.
      expect(steps.filter((step) => step.step === 'adapter-invoked')).toEqual([
        { step: 'adapter-invoked', clientTurnId: null },
      ]);
      expect(steps.some((step) => step.step === 'send-failed')).toBe(false);

      const { adapter, service } = await restart(dbPath);
      await expect(retry(service, 'different input')).rejects.toMatchObject({
        code: 'client_turn_input_conflict',
      });
      expect(adapter.sent).toHaveLength(0);
      const first = await retry(service);
      expect(first).toMatchObject({
        threadId: THREAD_ID,
        turnId: 'retry-turn-1',
      });
      expect(adapter.sent).toHaveLength(1);
      expect(adapter.sent[0]?.clientTurnId).toBe(CLIENT_TURN_ID);

      // The reclaimed key is now resolved: a further retry replays it.
      await expect(retry(service)).resolves.toEqual(first);
      expect(adapter.sent).toHaveLength(1);
    },
    CHILD_TIMEOUT_MS * 2,
  );
});
