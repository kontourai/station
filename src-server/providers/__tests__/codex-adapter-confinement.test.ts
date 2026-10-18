/**
 * #2494: Codex's own sandbox is the first real confinement provider. The
 * posture on `session.started` is derived from Codex's thread response,
 * never from the sandbox Station sent, and a start whose policy requires
 * confinement does not run when Codex does not report it in force.
 *
 * The response is the real codex-cli 0.155.1 `thread/start` result
 * (`fixtures/codex-0.155.1-collab-v1-spawn-wait-completed.jsonl`), with only
 * its `sandbox` replaced where a case needs Codex to report something else.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { ConfinementPlan } from '@kontourai/station-contracts/execution-confinement';
import type {
  ProviderSessionStartInput,
  StationConfinement,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import { ConfinementRefusedError } from '../../security/confinement/confinement-provider.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';

class FakeWritable extends Writable {
  readonly lines: string[] = [];

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    for (const line of chunk.toString().split('\n'))
      if (line.trim()) this.lines.push(line);
    callback();
  }
}

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new FakeWritable();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.signalCode = signal;
    this.emit('exit', 0);
    return true;
  }
}

interface CapturedLine {
  dir: string;
  msg: { id?: number; method?: string; result?: Record<string, unknown> };
}

/** The real 0.155.1 `thread/start` response, as captured. */
function capturedThreadStartResult(): Record<string, unknown> {
  const lines = readFileSync(
    join(
      import.meta.dirname,
      'fixtures',
      'codex-0.155.1-collab-v1-spawn-wait-completed.jsonl',
    ),
    'utf8',
  )
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CapturedLine);
  const request = lines.find(
    (line) =>
      line.dir === 'client->server' && line.msg.method === 'thread/start',
  );
  const response = lines.find(
    (line) =>
      line.dir === 'server->client' &&
      line.msg.id === request?.msg.id &&
      line.msg.result,
  );
  if (!response?.msg.result) throw new Error('fixture has no thread/start');
  return structuredClone(response.msg.result);
}

const CAPTURED = capturedThreadStartResult();

function calls(process: FakeCodexProcess): any[] {
  return process.stdin.lines.map((line) => JSON.parse(line));
}

async function waitForCall(
  process: FakeCodexProcess,
  method: string,
): Promise<any> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const match = calls(process).find((call) => call.method === method);
    if (match) return match;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${method}.`);
}

function respond(
  process: FakeCodexProcess,
  request: { id: string | number },
  result: unknown,
): void {
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
}

const REQUIRED: ConfinementPlan = {
  requiredLevel: 'os-profile',
  policyBasis: 'workspace-floor',
  mechanism: 'codex-sandbox',
  level: 'os-profile',
  workspaceAccess: 'mounted',
};
const NOT_REQUIRED_HOST: ConfinementPlan = {
  ...REQUIRED,
  requiredLevel: 'host',
  policyBasis: 'operator-policy',
};
const NOT_REQUIRED_WORKSPACE: ConfinementPlan = {
  ...REQUIRED,
  requiredLevel: 'host',
};

async function start(input: {
  threadId: string;
  approvalMode?: 'ask' | 'auto' | 'never';
  confinement: StationConfinement;
  plan?: ConfinementPlan;
  /** Codex's reported sandbox; `null` removes it from the response. */
  reported?: unknown;
  resume?: boolean;
}) {
  const process = new FakeCodexProcess();
  const adapter = new CodexAdapter({ processFactory: () => process as never });
  const events: CanonicalRuntimeEvent[] = [];
  const controller = new AbortController();
  void (async () => {
    for await (const event of adapter.streamEvents({
      signal: controller.signal,
    }))
      events.push(event);
  })().catch(() => {});
  const startInput: ProviderSessionStartInput = {
    provider: 'codex',
    threadId: input.threadId,
    cwd: '/workspace/repo',
    modelId: 'gpt-5.5',
    ...(input.approvalMode
      ? { modelOptions: { approvalMode: input.approvalMode } }
      : {}),
    confinement: input.confinement,
    ...(input.plan ? { confinementPlan: input.plan } : {}),
    ...(input.resume
      ? { resumeCursor: { codexThreadId: String(threadIdOf(CAPTURED)) } }
      : {}),
  };
  const started = adapter.startSession(startInput);
  respond(process, await waitForCall(process, 'initialize'), {
    userAgent: 'collab-capture/0.155.1 (scrubbed)',
  });
  const request = await waitForCall(
    process,
    input.resume ? 'thread/resume' : 'thread/start',
  );
  const result = structuredClone(CAPTURED);
  if (input.reported === null) delete result.sandbox;
  else if (input.reported !== undefined) result.sandbox = input.reported;
  respond(process, request, result);
  const outcome = await started.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const sessionStarted = events.find(
    (event) => event.method === 'session.started',
  ) as { metadata?: Record<string, unknown> } | undefined;
  const cleanup = async () => {
    await adapter.stopAll();
    controller.abort();
  };
  return { outcome, request, sessionStarted, process, cleanup };
}

function threadIdOf(result: Record<string, unknown>): unknown {
  return (result.thread as { id?: unknown } | undefined)?.id;
}

describe('#2494: Codex confinement posture is read back from its response', () => {
  test('the captured 0.155.1 response really reports workspaceWrite for a workspace never start', async () => {
    // The fixture shape this suite rests on: Station asked for
    // workspace-write and Codex reported the policy it applied.
    expect(CAPTURED.sandbox).toEqual({
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  test('a required start that Codex reports sandboxed is recorded confined, by its mechanism', async () => {
    const run = await start({
      threadId: 'confined',
      approvalMode: 'never',
      confinement: 'workspace',
      plan: REQUIRED,
    });
    expect(run.outcome).toEqual({ ok: true });
    expect(run.request.params.sandbox).toBe('workspace-write');
    expect(run.sessionStarted?.metadata?.stationConfinementRecord).toEqual({
      level: 'os-profile',
      required: true,
      posture: 'confined',
      mechanism: 'codex-sandbox',
      workspaceAccess: 'mounted',
      policyBasis: 'workspace-floor',
    });
    await run.cleanup();
  });

  test.each([
    ['dangerFullAccess', { type: 'dangerFullAccess' }],
    [
      'an external sandbox Station cannot see',
      {
        type: 'externalSandbox',
        networkAccess: 'enabled',
      },
    ],
    ['no sandbox at all', null],
  ])(
    'a required start whose Codex reports %s is refused, never announced, and its process stopped',
    async (_label, reported) => {
      const run = await start({
        threadId: `refused-${String((reported as { type?: string } | null)?.type)}`,
        approvalMode: 'never',
        confinement: 'workspace',
        plan: REQUIRED,
        reported,
      });
      // Station asked for the sandbox: what it SENT would say confined.
      expect(run.request.params.sandbox).toBe('workspace-write');
      expect(run.outcome.ok).toBe(false);
      const error = (run.outcome as { error: unknown }).error;
      expect(error).toBeInstanceOf(ConfinementRefusedError);
      expect((error as ConfinementRefusedError).code).toBe(
        'confinement_not_observed',
      );
      expect(run.sessionStarted).toBeUndefined();
      expect(run.process.killed).toBe(true);
      await run.cleanup();
    },
  );

  test('a host start Codex reports at full access is recorded as host by policy, not as a failure', async () => {
    const run = await start({
      threadId: 'host-full',
      approvalMode: 'never',
      confinement: 'host',
      plan: NOT_REQUIRED_HOST,
      reported: { type: 'dangerFullAccess' },
    });
    expect(run.outcome).toEqual({ ok: true });
    expect(run.request.params.sandbox).toBe('danger-full-access');
    expect(run.sessionStarted?.metadata?.stationConfinementRecord).toEqual({
      level: 'host',
      required: false,
      posture: 'no-mechanism',
      workspaceAccess: 'mounted',
      policyBasis: 'operator-policy',
    });
    await run.cleanup();
  });

  test('a host start Codex reports sandboxed anyway (its own configuration won) is confined, though Station sent full access', async () => {
    const run = await start({
      threadId: 'host-but-sandboxed',
      approvalMode: 'never',
      confinement: 'host',
      plan: NOT_REQUIRED_HOST,
    });
    expect(run.request.params.sandbox).toBe('danger-full-access');
    expect(run.outcome).toEqual({ ok: true });
    expect(run.sessionStarted?.metadata?.stationConfinementRecord).toEqual({
      level: 'os-profile',
      required: false,
      posture: 'confined',
      mechanism: 'codex-sandbox',
      workspaceAccess: 'mounted',
      policyBasis: 'operator-policy',
    });
    await run.cleanup();
  });

  test('an unrequired start whose requested sandbox Codex did not apply is configured-but-failed, and still runs', async () => {
    const run = await start({
      threadId: 'ask-unsandboxed',
      approvalMode: 'ask',
      confinement: 'workspace',
      plan: NOT_REQUIRED_WORKSPACE,
      reported: { type: 'dangerFullAccess' },
    });
    expect(run.request.params.sandbox).toBe('workspace-write');
    expect(run.outcome).toEqual({ ok: true });
    expect(run.sessionStarted?.metadata?.stationConfinementRecord).toEqual({
      level: 'os-profile',
      required: false,
      posture: 'configured-but-failed',
      mechanism: 'codex-sandbox',
      workspaceAccess: 'mounted',
      policyBasis: 'workspace-floor',
    });
    await run.cleanup();
  });

  test('a respawn (thread/resume) is re-derived from the resumed thread, not carried from the first start', async () => {
    const first = await start({
      threadId: 'respawned',
      approvalMode: 'never',
      confinement: 'workspace',
      plan: NOT_REQUIRED_WORKSPACE,
    });
    expect(first.sessionStarted?.metadata?.stationConfinementRecord).toEqual(
      expect.objectContaining({ posture: 'confined' }),
    );
    await first.cleanup();
    const resumed = await start({
      threadId: 'respawned',
      approvalMode: 'never',
      confinement: 'workspace',
      plan: NOT_REQUIRED_WORKSPACE,
      reported: { type: 'dangerFullAccess' },
      resume: true,
    });
    expect(resumed.outcome).toEqual({ ok: true });
    expect(resumed.sessionStarted?.metadata?.stationConfinementRecord).toEqual(
      expect.objectContaining({ posture: 'configured-but-failed' }),
    );
    await resumed.cleanup();
  });

  test('a start without a plan (no orchestration resolution) records nothing here', async () => {
    const run = await start({
      threadId: 'no-plan',
      approvalMode: 'never',
      confinement: 'workspace',
    });
    expect(run.outcome).toEqual({ ok: true });
    expect(run.sessionStarted).toBeDefined();
    expect(run.sessionStarted?.metadata).not.toHaveProperty(
      'stationConfinementRecord',
    );
    await run.cleanup();
  });
});
