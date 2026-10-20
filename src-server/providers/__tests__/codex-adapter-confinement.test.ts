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
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { ConfinementPlan } from '@kontourai/station-contracts/execution-confinement';
import type {
  ProviderSessionStartInput,
  StationConfinement,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ConfinementRefusedError } from '../../security/confinement/confinement-provider.js';
import { engineSpawnTmpDirPath } from '../../services/infra/engine-spawn-tmpdir.js';
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

async function waitForNthCall(
  process: FakeCodexProcess,
  method: string,
  index: number,
): Promise<any> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const match = calls(process).filter((call) => call.method === method)[
      index
    ];
    if (match) return match;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${method} #${index}.`);
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
  /**
   * Codex's reported sandbox; `null` removes it from the response. A
   * function answers from the request Station sent, and whether Codex
   * applied Station's permission profile.
   */
  reported?:
    | unknown
    | ((params: Record<string, unknown>, profiled: boolean) => unknown);
  /**
   * Codex's reported `activePermissionProfile`; `null` reports none. Absent:
   * what codex-cli 0.162.1 reports (EXECUTED), Station's profile when the
   * spawn selects it and the request sends no `sandbox` mode (a mode
   * replaces it), else none.
   */
  reportedProfile?: unknown;
  /**
   * Codex's reported approval policy. Absent: what Station sent, as Codex
   * echoes an accepted request (the capture's own `never`, when it sent
   * nothing).
   */
  reportedApprovalPolicy?: string;
  resume?: boolean;
  /** Arguments the connection itself adds to the app-server spawn. */
  connectionArgs?: string[];
}) {
  const process = new FakeCodexProcess();
  let spawnArgs: string[] | undefined;
  const adapter = new CodexAdapter({
    processFactory: (_env, args) => {
      spawnArgs = args;
      return process as never;
    },
    ...(input.connectionArgs
      ? {
          getConnectionLaunch: async () => ({
            env: undefined,
            args: input.connectionArgs!,
          }),
        }
      : {}),
  });
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
  result.approvalPolicy =
    input.reportedApprovalPolicy ??
    request.params.approvalPolicy ??
    CAPTURED.approvalPolicy;
  const profiled =
    (spawnArgs ?? []).includes('default_permissions="station-workspace"') &&
    request.params.sandbox === undefined;
  result.activePermissionProfile =
    input.reportedProfile !== undefined
      ? input.reportedProfile
      : profiled
        ? { id: 'station-workspace', extends: ':workspace' }
        : null;
  const reported =
    typeof input.reported === 'function'
      ? input.reported(request.params, profiled)
      : input.reported;
  if (reported === null) delete result.sandbox;
  else if (reported !== undefined) result.sandbox = reported;
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
  return {
    outcome,
    request,
    sessionStarted,
    process,
    spawnArgs,
    adapter,
    cleanup,
  };
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
    // #3800: the spawn's permission profile is the sandbox; a mode would
    // replace it.
    expect(run.request.params).not.toHaveProperty('sandbox');
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
      // Station engaged the sandbox (its permission profile): what it
      // requested would say confined.
      expect(run.request.params).not.toHaveProperty('sandbox');
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
    expect(run.request.params).not.toHaveProperty('sandbox');
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
      approvalMode: 'ask',
      confinement: 'workspace',
      plan: NOT_REQUIRED_WORKSPACE,
    });
    expect(first.sessionStarted?.metadata?.stationConfinementRecord).toEqual(
      expect.objectContaining({ posture: 'confined' }),
    );
    await first.cleanup();
    const resumed = await start({
      threadId: 'respawned',
      approvalMode: 'ask',
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
  describe('the breadth Codex reports, not only its sandbox type (F3)', () => {
    const workspaceWrite = (writableRoots: string[]) => ({
      type: 'workspaceWrite',
      writableRoots,
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });

    test.each([
      ['the filesystem root', ['/']],
      ['the home directory', [homedir()]],
      ['a sibling checkout', ['/workspace/other-repo']],
      ['a path that climbs out of the workspace', ['/workspace/repo/../other']],
    ])(
      'a required start whose workspaceWrite also opens %s is refused',
      async (_label, roots) => {
        const run = await start({
          threadId: `broad-${roots[0]}`,
          approvalMode: 'never',
          confinement: 'workspace',
          plan: REQUIRED,
          reported: workspaceWrite(roots),
        });
        expect(run.outcome.ok).toBe(false);
        expect(
          (run.outcome as { error: ConfinementRefusedError }).error.code,
        ).toBe('confinement_not_observed');
        expect(run.sessionStarted).toBeUndefined();
        await run.cleanup();
      },
    );

    test.each([
      ['inside the workspace', ['/workspace/repo/build']],
      ["in Station's own engine temp directory", [engineSpawnTmpDirPath()]],
    ])(
      'a required start whose extra writable root is %s is confined',
      async (_label, roots) => {
        const run = await start({
          threadId: `narrow-${roots[0]}`,
          approvalMode: 'never',
          confinement: 'workspace',
          plan: REQUIRED,
          reported: workspaceWrite(roots),
        });
        expect(run.outcome).toEqual({ ok: true });
        expect(run.sessionStarted?.metadata?.stationConfinementRecord).toEqual(
          expect.objectContaining({ posture: 'confined', required: true }),
        );
        await run.cleanup();
      },
    );

    test('the refusal names the operator-configured roots outside the workspace and how to fix it (D3)', async () => {
      const cargo = join(homedir(), '.cargo');
      const run = await start({
        threadId: 'broad-cargo',
        approvalMode: 'never',
        confinement: 'workspace',
        plan: REQUIRED,
        reported: workspaceWrite(['/workspace/repo/build', cargo]),
      });
      expect(run.outcome.ok).toBe(false);
      const message = (run.outcome as { error: Error }).error.message;
      expect(message).toContain(
        `writable roots outside the workspace: ${cargo}.`,
      );
      expect(message).not.toContain('/workspace/repo/build');
      expect(message).toContain('writable_roots');
      expect(message).toContain('host session');
      await run.cleanup();
    });

    test('an unrequired start whose workspaceWrite opens the filesystem root is recorded configured-but-failed, and still runs', async () => {
      const run = await start({
        threadId: 'broad-unrequired',
        approvalMode: 'ask',
        confinement: 'workspace',
        plan: NOT_REQUIRED_WORKSPACE,
        reported: workspaceWrite(['/']),
      });
      expect(run.outcome).toEqual({ ok: true });
      expect(run.sessionStarted?.metadata?.stationConfinementRecord).toEqual(
        expect.objectContaining({
          posture: 'configured-but-failed',
          required: false,
        }),
      );
      await run.cleanup();
    });
  });

  describe('the approval policy Codex reports also decides the requirement (F5)', () => {
    /**
     * D1: an operator config of `approval_policy = "never"` and
     * `sandbox_mode = "danger-full-access"`, with no Station mode. Codex
     * applies a sandbox Station asks for at thread level, and its own
     * configuration otherwise.
     */
    const operatorConfigSandbox = (
      params: Record<string, unknown>,
      profiled: boolean,
    ) =>
      params.sandbox === 'workspace-write' || profiled
        ? CAPTURED.sandbox
        : { type: 'dangerFullAccess' };

    test.each([
      ['start', false],
      ['resume', true],
    ] as const)(
      'a workspace %s Station sent no mode to runs under its permission profile, leaves approvals to Codex, and runs confined',
      async (label, resume) => {
        const run = await start({
          threadId: `codex-config-never-${label}`,
          confinement: 'workspace',
          plan: NOT_REQUIRED_WORKSPACE,
          reportedApprovalPolicy: 'never',
          reported: operatorConfigSandbox,
          resume,
        });
        expect(run.request.params).not.toHaveProperty('sandbox');
        expect(run.request.params).not.toHaveProperty('approvalPolicy');
        expect(run.outcome).toEqual({ ok: true });
        expect(run.sessionStarted?.metadata?.stationConfinementRecord).toEqual({
          level: 'os-profile',
          required: true,
          posture: 'confined',
          mechanism: 'codex-sandbox',
          workspaceAccess: 'mounted',
          policyBasis: 'workspace-floor',
        });
        await run.cleanup();
      },
    );

    test.each([
      ['start', false],
      ['resume', true],
    ] as const)(
      'a workspace %s Codex still reports wider than the profile Station selected, at never, is refused',
      async (label, resume) => {
        const run = await start({
          threadId: `codex-config-never-wider-${label}`,
          confinement: 'workspace',
          plan: NOT_REQUIRED_WORKSPACE,
          reportedApprovalPolicy: 'never',
          reported: { type: 'dangerFullAccess' },
          resume,
        });
        expect(run.request.params).not.toHaveProperty('sandbox');
        expect(run.outcome.ok).toBe(false);
        expect(
          (run.outcome as { error: ConfinementRefusedError }).error.code,
        ).toBe('confinement_not_observed');
        expect(run.sessionStarted).toBeUndefined();
        await run.cleanup();
      },
    );

    test('a host start Station sent no mode to asks for no sandbox and records only what Codex reported', async () => {
      const run = await start({
        threadId: 'codex-host-no-mode',
        confinement: 'host',
        plan: NOT_REQUIRED_HOST,
        reportedApprovalPolicy: 'never',
        reported: operatorConfigSandbox,
      });
      expect(run.request.params).not.toHaveProperty('sandbox');
      expect(run.outcome).toEqual({ ok: true });
      // Nothing engaged, Codex reported full access: no mechanism is named.
      expect(run.sessionStarted?.metadata?.stationConfinementRecord).toEqual({
        level: 'host',
        required: false,
        posture: 'no-mechanism',
        workspaceAccess: 'mounted',
        policyBasis: 'operator-policy',
      });
      await run.cleanup();
    });

    test('the same session Codex runs at never inside its sandbox is recorded required and confined', async () => {
      const run = await start({
        threadId: 'codex-config-never-sandboxed',
        confinement: 'workspace',
        plan: NOT_REQUIRED_WORKSPACE,
        reportedApprovalPolicy: 'never',
      });
      expect(run.outcome).toEqual({ ok: true });
      expect(run.sessionStarted?.metadata?.stationConfinementRecord).toEqual(
        expect.objectContaining({
          posture: 'confined',
          required: true,
          level: 'os-profile',
        }),
      );
      await run.cleanup();
    });

    test('a host session Codex runs at never at full access stays host by policy, not required', async () => {
      const run = await start({
        threadId: 'codex-host-config-never',
        confinement: 'host',
        plan: NOT_REQUIRED_HOST,
        reportedApprovalPolicy: 'never',
        reported: { type: 'dangerFullAccess' },
      });
      expect(run.outcome).toEqual({ ok: true });
      expect(run.sessionStarted?.metadata?.stationConfinementRecord).toEqual(
        expect.objectContaining({ posture: 'no-mechanism', required: false }),
      );
      await run.cleanup();
    });
  });
});

describe('#3800: workspace configuration cannot widen a confined Codex sandbox', () => {
  const PIN = [
    '-c',
    'default_permissions="station-workspace"',
    '-c',
    'permissions.station-workspace={extends=":workspace",filesystem={":workspace_roots"={".git"="read",".agents"="read","**/.codex"="deny","**/.codex/**"="deny","**/.claude"="deny","**/.claude/**"="deny"}}}',
    '-c',
    'sandbox_workspace_write.writable_roots=[]',
    '-c',
    'approvals_reviewer="user"',
  ];

  test('a workspace session pins its writable roots on the app-server spawn, after the connection arguments', async () => {
    const run = await start({
      threadId: 'pinned-workspace',
      approvalMode: 'auto',
      confinement: 'workspace',
      plan: NOT_REQUIRED_WORKSPACE,
      connectionArgs: ['-c', 'sandbox_workspace_write.writable_roots=["/"]'],
    });
    expect(run.outcome).toEqual({ ok: true });
    // Codex applies the last `-c` for a key, so the pin must come last.
    expect(run.spawnArgs?.slice(-PIN.length)).toEqual(PIN);
    expect(run.spawnArgs?.slice(0, 2)).toEqual([
      '-c',
      'sandbox_workspace_write.writable_roots=["/"]',
    ]);
    await run.cleanup();
  });

  test('a workspace session Station sends no mode to is pinned too', async () => {
    const run = await start({
      threadId: 'pinned-connection-default',
      confinement: 'workspace',
      plan: NOT_REQUIRED_WORKSPACE,
    });
    expect(run.outcome).toEqual({ ok: true });
    expect(run.spawnArgs).toEqual(PIN);
    await run.cleanup();
  });

  test.each([
    ['reports no permission profile (a Codex without profiles)', null],
    [
      "reports Codex's own workspace profile instead",
      { id: ':workspace', extends: null },
    ],
  ])(
    'a required start whose Codex %s is refused, naming the profile',
    async (_label, reportedProfile) => {
      const run = await start({
        threadId: `unprofiled-${String(reportedProfile && (reportedProfile as { id: string }).id)}`,
        approvalMode: 'never',
        confinement: 'workspace',
        plan: REQUIRED,
        reportedProfile,
      });
      // The legacy shape alone would read as confined.
      expect(CAPTURED.sandbox).toMatchObject({
        type: 'workspaceWrite',
        writableRoots: [],
      });
      expect(run.outcome.ok).toBe(false);
      const error = (run.outcome as { error: ConfinementRefusedError }).error;
      expect(error.code).toBe('confinement_not_observed');
      expect(error.message).toContain('station-workspace');
      expect(run.sessionStarted).toBeUndefined();
      expect(run.process.killed).toBe(true);
      await run.cleanup();
    },
  );

  test('an unrequired start without the profile is recorded configured-but-failed, and still runs', async () => {
    const run = await start({
      threadId: 'unprofiled-auto',
      approvalMode: 'auto',
      confinement: 'workspace',
      plan: NOT_REQUIRED_WORKSPACE,
      reportedProfile: null,
    });
    expect(run.outcome).toEqual({ ok: true });
    expect(run.sessionStarted?.metadata?.stationConfinementRecord).toEqual(
      expect.objectContaining({
        posture: 'configured-but-failed',
        required: false,
      }),
    );
    await run.cleanup();
  });

  test('a read-only review start still sends read-only, which needs no profile', async () => {
    const process = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => process as never,
    });
    const started = adapter.startSession({
      provider: 'codex',
      threadId: 'review-read-only',
      cwd: '/workspace/repo',
      modelId: 'gpt-5.5',
      confinement: 'workspace',
      confinementPlan: REQUIRED,
      reviewIsolation: { workspaceAccess: 'read-only' },
    } as ProviderSessionStartInput);
    respond(process, await waitForCall(process, 'initialize'), {});
    const request = await waitForCall(process, 'thread/start');
    expect(request.params.sandbox).toBe('read-only');
    const result = structuredClone(CAPTURED);
    result.approvalPolicy = 'never';
    result.sandbox = { type: 'readOnly', networkAccess: false };
    result.activePermissionProfile = null;
    respond(process, request, result);
    await expect(started).resolves.toBeDefined();
    await adapter.stopAll();
  });

  test.each([
    ['auto', 'never', 'ask'],
    ['never', 'auto', 'never'],
  ] as const)(
    'a workspace session under the profile changes modes across turns (%s, then %s, %s) without ever sending a sandboxPolicy',
    async (first, ...later) => {
      const run = await start({
        threadId: `profile-turns-${first}`,
        approvalMode: first,
        confinement: 'workspace',
        plan: NOT_REQUIRED_WORKSPACE,
      });
      expect(run.outcome).toEqual({ ok: true });
      for (const [index, mode] of [first, ...later].entries()) {
        const turn = run.adapter.sendTurn({
          threadId: `profile-turns-${first}`,
          input: 'go',
          modelOptions: { approvalMode: mode },
        });
        const request = await waitForNthCall(run.process, 'turn/start', index);
        expect(request.params).not.toHaveProperty('sandboxPolicy');
        respond(run.process, request, { turn: { id: `turn-${index}` } });
        await turn;
      }
      await run.cleanup();
    },
  );

  test("a host session keeps its workspace's configuration", async () => {
    const run = await start({
      threadId: 'unpinned-host',
      approvalMode: 'auto',
      confinement: 'host',
      plan: NOT_REQUIRED_HOST,
    });
    expect(run.outcome).toEqual({ ok: true });
    expect(run.spawnArgs).toBeUndefined();
    await run.cleanup();
  });
});

describe('#3800: a start without a cwd checks the directory Codex would run in', () => {
  const makeTempDir = trackTempDirs();

  test("an unaccounted .codex in the server's own directory refuses a non-host start before Codex is spawned", async () => {
    const dir = realpathSync(makeTempDir('codex-no-cwd-'));
    mkdirSync(join(dir, '.codex'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    let spawned = false;
    const adapter = new CodexAdapter({
      processFactory: () => {
        spawned = true;
        return new FakeCodexProcess() as never;
      },
    });
    try {
      const outcome = await adapter
        .startSession({
          provider: 'codex',
          threadId: 'no-cwd',
          confinement: 'workspace',
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(outcome).toBeInstanceOf(ConfinementRefusedError);
      expect((outcome as ConfinementRefusedError).code).toBe(
        'confinement_workspace_incompatible',
      );
      expect((outcome as Error).message).toContain(join(dir, '.codex'));
      expect(spawned).toBe(false);
    } finally {
      cwd.mockRestore();
      await adapter.stopAll();
    }
  });
});
