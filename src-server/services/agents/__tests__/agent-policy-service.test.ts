/**
 * Unit tests for the Flow Agents policy service (S3 item 1).
 *
 * These run against the REAL canonical hook scripts installed from
 * @kontourai/flow-agents (native Form 2 import) — temp-dir workspace
 * fixtures, no mocked engine — plus the documented built-in guard paths.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindHostWorkflowSession,
  flowAgentsArtifactRoot,
} from '@kontourai/flow-agents';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AgentPolicyService,
  extractToolFilePath,
  resolveSessionPolicyBinding,
} from '../agent-policy-service.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  policyChecks: { add: vi.fn() },
}));

const workspaces: string[] = [];
const TEST_ACTOR = 'station.policy-test';

function bindTestActor(workspace: string, taskDir: string): void {
  bindHostWorkflowSession({
    artifactRoot: flowAgentsArtifactRoot(workspace),
    artifactDir: taskDir,
    actorKey: TEST_ACTOR,
    owner: 'station-test',
    source: 'fixture',
  });
}

function tempWorkspace(prefix = 'policy-ws-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  workspaces.push(dir);
  return dir;
}

/** Opted-in workspace: has `.flow-agents/`. */
function optedInWorkspace(): string {
  const dir = tempWorkspace();
  mkdirSync(join(dir, '.flow-agents'), { recursive: true });
  return dir;
}

/**
 * Workspace with an active delivery artifact — the canonical stop-goal-fit
 * fixture shape (markdown artifact only; no sidecar JSON, so the hook's
 * external sidecar validator is not spawned).
 *
 * flow-agents 3.x's stop-goal-fit/workflow-steering hooks read active-work
 * artifacts only from the durable `.kontourai/flow-agents/` root (their
 * shared `flowAgentsArtifactRootsForRead` no longer falls back to the legacy
 * `.flow-agents/` dir). Station's own opt-in detection
 * (`isWorkspaceOptedIn`) still independently checks both roots, so writing
 * here to the new canonical root is what a real post-rename workspace looks
 * like, not a change to what "opted in" means.
 */
function activeDeliveryWorkspace(): string {
  const dir = tempWorkspace();
  const taskDir = join(dir, '.kontourai', 'flow-agents', 'demo-task');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, 'demo--deliver.md'),
    ['status: executing', 'type: deliver', '', '# Demo task', ''].join('\n'),
  );
  bindTestActor(dir, taskDir);
  return dir;
}

/**
 * Workspace whose `state.json` sidecar needs ambient steering (blocked +
 * needs_user) — the canonical workflow-steering fixture shape. See
 * `activeDeliveryWorkspace` above for why this lives under
 * `.kontourai/flow-agents/` rather than the legacy `.flow-agents/` dir.
 */
function steeringWorkspace(): string {
  const dir = tempWorkspace();
  const taskDir = join(dir, '.kontourai', 'flow-agents', 'demo-task');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, 'state.json'),
    JSON.stringify({
      task_slug: 'demo-task',
      status: 'blocked',
      phase: 'execute',
      next_action: { status: 'needs_user', summary: 'decide on API shape' },
      updated_at: new Date().toISOString(),
    }),
  );
  bindTestActor(dir, taskDir);
  return dir;
}

function createService(
  env: Record<string, string | undefined> = {},
  options: ConstructorParameters<typeof AgentPolicyService>[0] = {},
): AgentPolicyService {
  return new AgentPolicyService({
    env: {
      ...process.env,
      FLOW_AGENTS_ACTOR: TEST_ACTOR,
      SA_DISABLED_HOOKS: '',
      SA_HOOK_PROFILE: '',
      ...env,
    },
    logger: { debug: vi.fn(), warn: vi.fn() },
    ...options,
  });
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('AgentPolicyService — engine resolution', () => {
  test('loads the canonical engine from the installed npm package', () => {
    expect(createService().engineAvailable).toBe(true);
  });

  test('an explicit but invalid engineRoot does NOT auto-discover (PolicyGate parity)', () => {
    const service = createService({}, { engineRoot: '/nonexistent/path' });
    expect(service.engineAvailable).toBe(false);
  });
});

describe('config-protection (checkToolCall, blocking pre-tool)', () => {
  test('blocks a write to a protected config file in an opted-in workspace (native engine)', () => {
    const ws = optedInWorkspace();
    const result = createService().checkToolCall('fs_write', {
      path: join(ws, 'biome.json'),
      content: '{}',
    });
    expect(result.decision).toBe('block');
    expect(result.engine).toBe('native');
    expect(result.reason).toMatch(/BLOCKED: Modifying biome\.json/);
  });

  test('blocks via the session cwd when the write path is relative', () => {
    const ws = optedInWorkspace();
    const result = createService().checkToolCall(
      'write_file',
      { file_path: '.eslintrc.json' },
      { cwd: ws },
    );
    expect(result.decision).toBe('block');
  });

  test('allows safe files, read tools, and pathless calls', () => {
    const ws = optedInWorkspace();
    const service = createService();
    expect(
      service.checkToolCall('fs_write', { path: join(ws, 'src/index.ts') })
        .decision,
    ).toBe('allow');
    expect(
      service.checkToolCall('read_file', { path: join(ws, 'biome.json') })
        .decision,
    ).toBe('allow');
    expect(service.checkToolCall('fs_write', { content: 'x' }).decision).toBe(
      'allow',
    );
  });

  test('non-opted workspace: zero behavior change', () => {
    const ws = tempWorkspace();
    const result = createService().checkToolCall('fs_write', {
      path: join(ws, 'biome.json'),
    });
    expect(result).toMatchObject({ decision: 'allow', engine: 'disabled' });
  });

  test('falls back to the documented protected-file set when the engine is missing', () => {
    const ws = optedInWorkspace();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const service = new AgentPolicyService({
      engineRoot: '/nonexistent/engine',
      env: { ...process.env, SA_HOOK_PROFILE: '', SA_DISABLED_HOOKS: '' },
      logger,
    });
    const blocked = service.checkToolCall('fs_write', {
      path: join(ws, 'biome.json'),
    });
    expect(blocked).toMatchObject({ decision: 'block', engine: 'typescript' });
    expect(blocked.reason).toMatch(/BLOCKED: Modifying biome\.json/);
    expect(
      service.checkToolCall('fs_write', { path: join(ws, 'src/app.ts') })
        .decision,
    ).toBe('allow');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('fail-open'),
      expect.objectContaining({ policy: 'config-protection' }),
    );
  });

  test('profile minimal and SA_DISABLED_HOOKS both disable the check', () => {
    const ws = optedInWorkspace();
    const input = { path: join(ws, 'biome.json') };
    expect(
      createService({ SA_HOOK_PROFILE: 'minimal' }).checkToolCall(
        'fs_write',
        input,
      ).decision,
    ).toBe('allow');
    expect(
      createService({
        SA_DISABLED_HOOKS: 'pre:config-protection',
      }).checkToolCall('fs_write', input).decision,
    ).toBe('allow');
  });
});

/**
 * archive#3210. A blocking `reason` is rendered to the user by
 * `pre-tool-policy.ts`, which must say whether the words are Station's or an
 * external process's. That question is answered HERE, in the branch that
 * produced the string, because it is the only place the two are still
 * distinguishable — `engine` is not a proxy for it, as the third test shows.
 */
describe('station#3210: a blocking reason declares its author', () => {
  test('the hook process is credited for its output; the built-in guard is not', () => {
    const ws = optedInWorkspace();
    const native = createService().checkToolCall('fs_write', {
      path: join(ws, 'biome.json'),
      content: '{}',
    });
    const builtin = new AgentPolicyService({
      engineRoot: '/nonexistent/engine',
      env: { ...process.env, SA_HOOK_PROFILE: '', SA_DISABLED_HOOKS: '' },
      logger: { debug: vi.fn(), warn: vi.fn() },
    }).checkToolCall('fs_write', { path: join(ws, 'biome.json') });

    // Both block on the same file and both open with the same sentence — the
    // TypeScript guard deliberately mirrors config-protection.js's wording —
    // so the TEXT cannot distinguish the author either.
    expect(native.reason).toMatch(/BLOCKED: Modifying biome\.json/);
    expect(builtin.reason).toMatch(/BLOCKED: Modifying biome\.json/);
    expect(native).toMatchObject({
      decision: 'block',
      engine: 'native',
      reasonAuthor: 'external-hook',
    });
    expect(builtin).toMatchObject({
      decision: 'block',
      engine: 'typescript',
      reasonAuthor: 'station',
    });
  });

  test('a hook that blocks with no output at all yields STATION-authored text under the SAME engine', () => {
    const engineRoot = tempWorkspace('policy-hook-fixture-');
    writeFileSync(join(engineRoot, 'run-hook.js'), 'module.exports = {};\n');
    // A hook that blocks and says nothing: `agent-policy-service` then
    // supplies its own fallback sentence, so `engine: 'native'` covers BOTH
    // authors. This is the case a `verdict.engine`-based attribution gets
    // wrong, and the reason authorship is declared rather than inferred.
    writeFileSync(
      join(engineRoot, 'config-protection.js'),
      "module.exports.run = () => ({ exitCode: 2, stderr: '  ', stdout: '' });\n",
    );
    const ws = optedInWorkspace();

    const result = new AgentPolicyService({
      engineRoot,
      env: { ...process.env, SA_HOOK_PROFILE: '', SA_DISABLED_HOOKS: '' },
      logger: { debug: vi.fn(), warn: vi.fn() },
    }).checkToolCall('fs_write', { path: join(ws, 'biome.json') });

    expect(result).toMatchObject({
      decision: 'block',
      engine: 'native',
      reason: 'BLOCKED: config-protection policy blocked this action.',
      reasonAuthor: 'station',
    });
  });
});

describe('quality-gate (afterWrite, non-blocking)', () => {
  test('is gated to the strict profile (canonical wiring)', () => {
    const ws = optedInWorkspace();
    const file = join(ws, 'notes.md');
    writeFileSync(file, '# hi\n');
    expect(createService().afterWrite(file)).toEqual({ warnings: [] });
  });

  test('strict profile runs the canonical hook without blocking and never throws', () => {
    const ws = optedInWorkspace();
    const file = join(ws, 'notes.md');
    writeFileSync(file, '# hi\n');
    const result = createService({ SA_HOOK_PROFILE: 'strict' }).afterWrite(
      file,
    );
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  test('non-opted workspace: no-op even in strict profile', () => {
    const ws = tempWorkspace();
    const file = join(ws, 'notes.md');
    writeFileSync(file, '# hi\n');
    expect(
      createService({ SA_HOOK_PROFILE: 'strict' }).afterWrite(file),
    ).toEqual({ warnings: [] });
  });
});

describe('workflow-steering (steeringContext, non-blocking inject)', () => {
  test('returns the canonical ambient steering for attention-needing state', () => {
    const ws = steeringWorkspace();
    const steering = createService().steeringContext({
      cwd: ws,
      actorKey: TEST_ACTOR,
    });
    expect(steering).toBeTruthy();
    expect(steering).toContain('WORKFLOW STATE ATTENTION');
    expect(steering).toContain('status:blocked');
    expect(steering).toContain('decide on API shape');
  });

  test('returns null for a workspace with no attention-needing state', () => {
    const ws = optedInWorkspace();
    expect(createService().steeringContext({ cwd: ws })).toBeNull();
  });

  test('returns null for non-opted workspaces and disabled profiles', () => {
    const steeringWs = steeringWorkspace();
    expect(
      createService().steeringContext({ cwd: tempWorkspace() }),
    ).toBeNull();
    expect(
      createService({ SA_HOOK_PROFILE: 'minimal' }).steeringContext({
        cwd: steeringWs,
      }),
    ).toBeNull();
    expect(
      createService({
        SA_DISABLED_HOOKS: 'prompt:workflow-steering',
      }).steeringContext({ cwd: steeringWs }),
    ).toBeNull();
  });
});

describe('stop-goal-fit (checkStop, blocking in strict mode)', () => {
  test('default mode: active delivery artifact produces a warn verdict with the canonical findings', async () => {
    const ws = activeDeliveryWorkspace();
    const result = await createService().checkStop({
      cwd: ws,
      actorKey: TEST_ACTOR,
    });
    expect(result.verdict).toBe('warn');
    expect(result.strict).toBe(false);
    expect(result.warnings.join('\n')).toMatch(/still status:executing/);
    expect(result.warnings.join('\n')).toMatch(
      /no trust\.bundle or state\.json/,
    );
  });

  test('strict profile: the same findings block', async () => {
    const ws = activeDeliveryWorkspace();
    const result = await createService({ SA_HOOK_PROFILE: 'strict' }).checkStop(
      {
        cwd: ws,
        actorKey: TEST_ACTOR,
      },
    );
    expect(result.verdict).toBe('block');
    expect(result.strict).toBe(true);
  });

  test('FLOW_AGENTS_GOAL_FIT_STRICT=true blocks without the strict profile', async () => {
    const ws = activeDeliveryWorkspace();
    const result = await createService({
      FLOW_AGENTS_GOAL_FIT_STRICT: 'true',
    }).checkStop({ cwd: ws, actorKey: TEST_ACTOR });
    expect(result.verdict).toBe('block');
    expect(result.strict).toBe(true);
  });

  test('defense-in-depth: a hook returning exitCode 2 in default mode downgrades to warn', async () => {
    // The canonical hook only exits 2 when FLOW_AGENTS_GOAL_FIT_MODE=block,
    // which checkStop only sets under the strict profile — so this branch
    // guards against a non-canonical hook override that ignores the mode env.
    const service = createService();
    vi.spyOn(
      service as unknown as { loadHook: (name: string) => unknown },
      'loadHook',
    ).mockReturnValue({
      run: async () => ({ stdout: '', stderr: '', exitCode: 2 }),
    });
    const result = await service.checkStop({ cwd: optedInWorkspace() });
    expect(result).toMatchObject({
      verdict: 'warn',
      strict: false,
      warnings: [],
    });
  });

  test('clean opted-in workspace passes; non-opted workspace passes untouched', async () => {
    expect(
      await createService().checkStop({ cwd: optedInWorkspace() }),
    ).toMatchObject({ verdict: 'pass', warnings: [] });
    expect(
      await createService().checkStop({ cwd: tempWorkspace() }),
    ).toMatchObject({
      verdict: 'pass',
      warnings: [],
    });
  });

  test('engine unavailable: fails open to pass (logged)', async () => {
    const ws = activeDeliveryWorkspace();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const service = new AgentPolicyService({
      engineRoot: '/nonexistent/engine',
      env: { ...process.env, SA_HOOK_PROFILE: 'strict', SA_DISABLED_HOOKS: '' },
      logger,
    });
    expect(await service.checkStop({ cwd: ws })).toMatchObject({
      verdict: 'pass',
    });
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('helpers', () => {
  test('extractToolFilePath reads the documented arg shapes', () => {
    expect(extractToolFilePath({ path: 'a.ts' })).toBe('a.ts');
    expect(extractToolFilePath({ file_path: 'b.ts' })).toBe('b.ts');
    expect(extractToolFilePath({ filePath: 'c.ts' })).toBe('c.ts');
    expect(extractToolFilePath({ content: 'x' })).toBeNull();
    expect(extractToolFilePath('not-an-object')).toBeNull();
    expect(extractToolFilePath(null)).toBeNull();
  });

  test('resolveSessionPolicyBinding takes the last policy.hooks-attached event', () => {
    const base = {
      eventId: 'e',
      provider: 'claude' as const,
      threadId: 't',
      createdAt: new Date().toISOString(),
    };
    const events: CanonicalRuntimeEvent[] = [
      {
        ...base,
        method: 'policy.hooks-attached',
        cwd: '/old',
        profile: 'standard',
        engine: 'native',
      },
      { ...base, method: 'turn.started', turnId: 'turn-1' },
      {
        ...base,
        method: 'policy.hooks-attached',
        cwd: '/new',
        profile: 'strict',
        engine: 'native',
      },
    ];
    expect(resolveSessionPolicyBinding(events)).toEqual({
      cwd: '/new',
      profile: 'strict',
    });
    expect(resolveSessionPolicyBinding([])).toBeNull();
  });

  test('isWriteTool covers the reference set plus Station names, case-insensitively', () => {
    const service = createService();
    for (const name of ['fs_write', 'Write', 'write_file', 'apply_patch']) {
      expect(service.isWriteTool(name)).toBe(true);
    }
    expect(service.isWriteTool('read_file')).toBe(false);
  });
});

describe('checkPlatformMutation (Station-side policy class, S3 item 4)', () => {
  test('enablement query follows the profile and explicit-disable contract', () => {
    expect(createService().isPlatformMutationEnabled()).toBe(true);
    expect(
      createService({ SA_HOOK_PROFILE: 'minimal' }).isPlatformMutationEnabled(),
    ).toBe(false);
    expect(
      createService({
        SA_DISABLED_HOOKS: 'pre:platform-mutation',
      }).isPlatformMutationEnabled(),
    ).toBe(false);
  });

  test('non-opted workspace: allow with engine disabled (zero change)', () => {
    const cwd = tempWorkspace();
    const service = createService();
    expect(
      service.checkPlatformMutation('create_agent', { cwd, runBound: false }),
    ).toEqual({ decision: 'allow', engine: 'disabled', profile: 'standard' });
  });

  test('opted + run-bound: allow (audited by the gate)', () => {
    const cwd = optedInWorkspace();
    const service = createService();
    const result = service.checkPlatformMutation('create_agent', {
      cwd,
      runBound: true,
    });
    expect(result.decision).toBe('allow');
    expect(result.engine).toBe('station');
  });

  test('opted + ungated: warn in the default policy profile, with guidance', () => {
    const cwd = optedInWorkspace();
    const service = createService();
    const result = service.checkPlatformMutation('update_config', {
      cwd,
      runBound: false,
    });
    expect(result.decision).toBe('warn');
    expect(result.reason).toMatch(/ungated/);
    expect(result.reason).toMatch(/standard Flow\/Builder lifecycle/);
    expect(result.reason).not.toContain('station-delivery');
  });

  test('opted + ungated: BLOCK in the strict profile, reason names the tool', () => {
    const cwd = optedInWorkspace();
    const service = createService({ SA_HOOK_PROFILE: 'strict' });
    const result = service.checkPlatformMutation('delete_agent', {
      cwd,
      runBound: false,
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/^BLOCKED: platform mutation 'delete_agent'/);
    expect(result.reason).toMatch(/standard Flow\/Builder lifecycle/);
    expect(result.reason).not.toContain('station-delivery');
  });

  test('minimal profile and SA_DISABLED_HOOKS disable the class', () => {
    const cwd = optedInWorkspace();
    expect(
      createService({ SA_HOOK_PROFILE: 'minimal' }).checkPlatformMutation(
        'create_agent',
        { cwd, runBound: false },
      ).engine,
    ).toBe('disabled');
    expect(
      createService({
        SA_DISABLED_HOOKS: 'pre:platform-mutation',
      }).checkPlatformMutation('create_agent', { cwd, runBound: false }).engine,
    ).toBe('disabled');
  });
});
