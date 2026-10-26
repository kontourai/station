/**
 * #3581: a direct `/chat` turn retried after a crash never reaches the agent a
 * second time once its first attempt may have started it.
 *
 * Each case runs a REAL owner process (the production `streamPrimaryAgentChat`
 * over a real SQLite `EventStore`), SIGKILLs it at a chosen point, then reopens
 * the same store in this process and retries the same `clientTurnId` against
 * a counting agent.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildChatHarnessApp,
  createHarnessConversationStore,
  emptyAgentResult,
} from '../../../__test-utils__/chat-primary-stream-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { chatTurnDedupKey } from '../../../services/orchestration/sqlite-turn-dedup-persistence.js';
import { ChatTurnDedupStore } from '../chat-turn-dedup.js';

const CHILD_TIMEOUT_MS = 60_000;
const CLIENT_TURN_ID = 'client-turn-3581';

function moduleUrl(path: string): string {
  return JSON.stringify(pathToFileURL(resolve(process.cwd(), path)).href);
}

/**
 * The owner process. `invoked`: the turn reaches `agent.streamText`, which
 * never returns. `pre-invoke`: the turn has durably claimed its key and is
 * held inside conversation setup, before the agent call.
 */
const OWNER_PROGRAM = `
  import { DatabaseSync } from 'node:sqlite';
  import { agentId } from '@kontourai/station-contracts/agent-identity';
  import { createNativeForegroundRelay } from ${moduleUrl('src-server/runtime/conversation/native-foreground-invocation.ts')};
  import { EventStore } from ${moduleUrl('src-server/services/orchestration/event-store.ts')};
  import { chatTurnDedupKey } from ${moduleUrl('src-server/services/orchestration/sqlite-turn-dedup-persistence.ts')};
  import { ChatTurnDedupStore } from ${moduleUrl('src-server/routes/chat/chat-turn-dedup.ts')};
  import { buildChatHarnessApp, createHarnessConversationStore } from ${moduleUrl('src-server/__test-utils__/chat-primary-stream-harness.ts')};
  const [dbPath, mode, clientTurnId] = process.argv.slice(1);
  const report = (step, extra = {}) =>
    process.stdout.write(JSON.stringify({ step, ...extra }) + '\\n');
  const eventStore = new EventStore(dbPath);
  // Opened after the store created the file.
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  const claimed = () =>
    Boolean(
      reader
        .prepare('SELECT 1 FROM orchestration_turn_dedup WHERE dedup_key = ?')
        .get(chatTurnDedupKey(clientTurnId)),
    );
  const conversations = createHarnessConversationStore(async () => {
    if (mode !== 'pre-invoke') return;
    report('claimed-before-invocation', { claimed: claimed() });
    await new Promise(() => {});
  });
  const agent = {
    getMemory: () => null,
    model: { modelId: 'test-model' },
    streamText() {
      report('agent-invoked');
      if (mode.endsWith('failed')) throw new Error('injected post-invocation failure');
      return new Promise(() => {});
    },
  };
  const nativeForeground = mode.startsWith('native-')
    ? createNativeForegroundRelay({
        agentId: agentId('assistant'),
        agentSpec: { name: 'Assistant', prompt: 'Answer the user.' },
        project: {
          id: 'project', slug: 'project', name: 'Project',
          createdAt: '2026-10-25T00:00:00.000Z',
          updatedAt: '2026-10-25T00:00:00.000Z',
        },
        workspaceIsolationMode: 'shared',
        message: 'hello',
        async invoke(_phase, _actual, effect) {
          if (mode === 'native-held') {
            report('guard-held', { claimed: claimed() });
            await new Promise(() => {});
          }
          return effect();
        },
      }, { threadId: 'native-thread', userId: 'owner' })
    : undefined;
  const app = buildChatHarnessApp({
    agent,
    conversations,
    dedupStore: new ChatTurnDedupStore(eventStore),
    nativeForeground,
  });
  const response = await app.request(
    '/chat?clientTurnId=' + encodeURIComponent(clientTurnId),
    { method: 'POST' },
  );
  if (mode.endsWith('failed')) {
    await response.text();
    report('agent-failed', { claimed: claimed() });
  } else {
    void response.text();
  }
  setInterval(() => undefined, 1000);
`;

type OwnerStep = { step: string; claimed?: boolean };

describe('/chat client-turn dedup after a killed owner (#3581)', () => {
  // Created before the afterEach below: after-hooks run in reverse order, so
  // these directories are removed only once the children and stores closed.
  const makeTempDir = trackTempDirs();
  const children: ChildProcess[] = [];
  const stores: EventStore[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
    for (const store of stores.splice(0)) store.close();
  });

  async function killOwnerAt(
    dbPath: string,
    mode:
      | 'invoked'
      | 'pre-invoke'
      | 'failed'
      | 'native-held'
      | 'native-invoked'
      | 'native-failed',
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

  /** Reopens the store the way a restarted Station does, with a counting agent. */
  function restart(dbPath: string) {
    const eventStore = new EventStore(dbPath);
    stores.push(eventStore);
    const calls: string[] = [];
    const app = buildChatHarnessApp({
      agent: {
        getMemory: () => null,
        model: { modelId: 'test-model' },
        streamText(input: string) {
          calls.push(input);
          return Promise.resolve(emptyAgentResult());
        },
      },
      conversations: createHarnessConversationStore(),
      dedupStore: new ChatTurnDedupStore(eventStore),
    });
    const retry = async () => {
      const response = await app.request(
        `/chat?clientTurnId=${encodeURIComponent(CLIENT_TURN_ID)}`,
        { method: 'POST' },
      );
      return { status: response.status, body: await response.text() };
    };
    return { calls, retry };
  }

  function newStorePath(): string {
    return join(makeTempDir('chat-turn-dedup-crash-'), 'orchestration.sqlite');
  }

  test.each(['invoked', 'failed', 'native-invoked', 'native-failed'] as const)(
    'a retry after the %s owner was killed never reaches the agent and answers indeterminate',
    async (mode) => {
      const dbPath = newStorePath();
      const steps = await killOwnerAt(
        dbPath,
        mode,
        mode.endsWith('failed') ? 'agent-failed' : 'agent-invoked',
      );
      if (mode.endsWith('failed'))
        expect(steps).toContainEqual({ step: 'agent-failed', claimed: true });
      const invokedByOwner = steps.filter(
        (step) => step.step === 'agent-invoked',
      );
      expect(invokedByOwner).toHaveLength(1);

      const { calls, retry } = restart(dbPath);
      const first = await retry();
      // The agent ran once, in the killed owner, and never again.
      expect(invokedByOwner.length + calls.length).toBe(1);
      // A typed refusal before any stream starts, not an SSE error frame.
      expect(first.status).toBe(409);
      expect(JSON.parse(first.body)).toMatchObject({
        success: false,
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
      });

      // The answer is durable: a later retry is refused the same way.
      const second = await retry();
      expect(second.status).toBe(409);
      expect(JSON.parse(second.body)).toMatchObject({
        outcome: 'indeterminate',
      });
      expect(calls).toHaveLength(0);
    },
    CHILD_TIMEOUT_MS * 2,
  );

  test.each(['pre-invoke', 'native-held'] as const)(
    'control: a retry after the owner was killed at %s is reclaimed and sends exactly once',
    async (mode) => {
      const dbPath = newStorePath();
      const steps = await killOwnerAt(
        dbPath,
        mode,
        mode === 'native-held' ? 'guard-held' : 'claimed-before-invocation',
      );
      // The owner had durably claimed the key and never reached the agent.
      expect(steps).toContainEqual({
        step:
          mode === 'native-held' ? 'guard-held' : 'claimed-before-invocation',
        claimed: true,
      });
      expect(steps.some((step) => step.step === 'agent-invoked')).toBe(false);

      const { calls, retry } = restart(dbPath);
      const first = await retry();
      expect(first.status).toBe(200);
      expect(first.body).toContain('"type":"conversation-started"');
      expect(calls).toHaveLength(1);

      // The reclaimed key is now resolved: a further retry replays it.
      const second = await retry();
      expect(second.status).toBe(200);
      expect(second.body).toContain('"type":"conversation-started"');
      expect(calls).toHaveLength(1);
    },
    CHILD_TIMEOUT_MS * 2,
  );

  test('a /chat row written before #3579 (no invocation record) whose owner died is still reclaimed', async () => {
    const dbPath = newStorePath();
    // Create the schema, then write the pre-#3579 row shape directly.
    new EventStore(dbPath).close();
    const database = new DatabaseSync(dbPath);
    try {
      database
        .prepare(
          `INSERT INTO orchestration_turn_dedup
             (dedup_key, value, created_at, owner_json) VALUES (?, ?, ?, ?)`,
        )
        .run(
          chatTurnDedupKey(CLIENT_TURN_ID),
          null,
          Date.now(),
          JSON.stringify({
            pid: 999_999_999,
            birth: 'pre-3579-birth',
            token: 'pre-3579-owner',
            identityKind: 'exact',
          }),
        );
    } finally {
      database.close();
    }

    const { calls, retry } = restart(dbPath);
    const first = await retry();
    expect(first.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
