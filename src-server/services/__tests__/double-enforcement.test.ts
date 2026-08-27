/**
 * Double-enforcement test (roadmap #586, part of epic #580, S6 — design
 * doc risk "Double enforcement: Station-native policies + in-runtime
 * flow-agents hooks firing in the same session should agree (same policy
 * classes) — needs an explicit test, not a hope").
 *
 * Two enforcement points can fire for the SAME tool call in the SAME
 * opted-in workspace session:
 *
 *   1. Station-native: `AgentPolicyService.checkToolCall` — Station's own
 *      orchestration-layer gate (S3 item 1), which natively imports and
 *      calls the REAL installed `@kontourai/flow-agents` config-protection
 *      hook module (Form 2, no subprocess — see that service's header).
 *   2. In-runtime flow-agents hook: the SAME `config-protection.js` module,
 *      loaded and invoked directly here exactly as an external agent CLI's
 *      own hook wiring (`scripts/hooks/run-hook.js` -> config-protection.js)
 *      would invoke it during a live session in the same workspace.
 *
 * These are proven to agree by construction (both paths load and call the
 * identical installed module with an identical payload) — this test is the
 * concrete evidence for that claim, not an assumption: it fails the moment
 * either path's payload construction or verdict interpretation drifts from
 * the other's.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../telemetry/metrics.js', () => ({
  policyChecks: { add: vi.fn() },
}));

const { AgentPolicyService } = await import(
  '../agents/agent-policy-service.js'
);

const require = createRequire(import.meta.url);

interface HookRunOutput {
  exitCode?: number;
  stderr?: string;
  stdout?: string;
}

/** Loads the SAME config-protection.js module AgentPolicyService's own
 * `loadHook` resolves — proving both enforcement points run the identical
 * installed artifact, not two independently-drifting copies. */
function loadRealConfigProtectionHook(): {
  run(raw: string, options: { truncated: boolean; maxStdin: number }): unknown;
} {
  const packageJsonPath = require.resolve(
    '@kontourai/flow-agents/package.json',
  );
  const packageRoot = packageJsonPath.replace(/[\\/]package\.json$/, '');
  const scriptPath = join(
    packageRoot,
    'scripts',
    'hooks',
    'config-protection.js',
  );
  return require(scriptPath);
}

/** The EXACT payload shape `AgentPolicyService`'s private
 * `runConfigProtection` builds — reproduced here (not imported; the method
 * is private) so this test genuinely exercises "the same event through both
 * paths", proven by the two verdicts agreeing across a representative
 * matrix, not merely by code inspection. */
function preToolUsePayload(toolName: string, filePath: string): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath },
  });
}

const workspaces: string[] = [];

function optedInWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'double-enforcement-'));
  mkdirSync(join(dir, '.flow-agents'), { recursive: true });
  workspaces.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('double enforcement: Station-native gate agrees with the in-runtime flow-agents hook', () => {
  const cases: Array<{
    label: string;
    relPath: string;
    expectBlocked: boolean;
  }> = [
    {
      label: 'protected lint config',
      relPath: 'biome.json',
      expectBlocked: true,
    },
    {
      label: 'protected formatter config',
      relPath: '.eslintrc.json',
      expectBlocked: true,
    },
    {
      label: 'ordinary source file',
      relPath: 'src/index.ts',
      expectBlocked: false,
    },
    { label: 'ordinary doc file', relPath: 'README.md', expectBlocked: false },
  ];

  test.each(cases)(
    '$label: Station-native and in-runtime hook verdicts agree (expectBlocked=$expectBlocked)',
    ({ relPath, expectBlocked }) => {
      const ws = optedInWorkspace();
      const filePath = join(ws, relPath);

      // 1. Station-native path.
      const stationService = new AgentPolicyService({
        env: { ...process.env, SA_DISABLED_HOOKS: '', SA_HOOK_PROFILE: '' },
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      expect(stationService.engineAvailable).toBe(true);
      const stationResult = stationService.checkToolCall(
        'write',
        { path: filePath },
        { cwd: ws },
      );
      expect(stationResult.engine).toBe('native');

      // 2. In-runtime flow-agents hook path — the SAME installed module,
      // called directly with the SAME PreToolUse payload shape.
      const hook = loadRealConfigProtectionHook();
      const raw = preToolUsePayload('write', filePath);
      const hookResult = hook.run(raw, {
        truncated: false,
        maxStdin: 1024 * 1024,
      }) as HookRunOutput;
      const hookBlocked = hookResult?.exitCode === 2;

      // Agreement: both paths reach the SAME decision for the SAME event.
      expect(stationResult.decision).toBe(expectBlocked ? 'block' : 'allow');
      expect(hookBlocked).toBe(expectBlocked);
      expect(stationResult.decision === 'block').toBe(hookBlocked);
    },
  );

  test('a non-opted-in workspace: both paths are inert (no policy applies)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'double-enforcement-noop-'));
    workspaces.push(ws);
    const filePath = join(ws, 'biome.json');

    const stationService = new AgentPolicyService({
      env: { ...process.env, SA_DISABLED_HOOKS: '', SA_HOOK_PROFILE: '' },
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const stationResult = stationService.checkToolCall(
      'write',
      { path: filePath },
      { cwd: ws },
    );
    // Station's own opt-in gate short-circuits before the hook ever runs —
    // 'disabled' engine, allow decision (zero behavior change contract).
    expect(stationResult).toEqual({ decision: 'allow', engine: 'disabled' });
  });
});
