import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decideOrchestrationTransferScope } from '../check-prepush-orchestration-transfer.mjs';
import { decideSdkBarrelScope } from '../check-prepush-sdk-barrel.mjs';
import { decideStaticGateScope } from '../check-prepush-static-gates.mjs';
import { decideTypecheckScope } from '../check-prepush-typecheck.mjs';
import {
  gatePlan,
  gateScopes,
  veritasGuidanceForPaths,
  veritasGuidanceRules,
} from '../gate-for.mjs';

// gate:for must stay a COMPOSER of the pre-push deciders, never a parallel
// encoding of their path lists — these tests therefore assert agreement with
// the deciders' own verdicts on representative surfaces, not hardcoded path
// knowledge of this test's own.

const baseSha = 'f'.repeat(40);

// Assertions read the plan and the rules as data (#2927): rewording a line
// of the report fails nothing here, while dropping a gate, a rule or a lane
// does.
const PRE_PUSH = readFileSync('.githooks/pre-push', 'utf8');
const SCRIPTS: Record<string, string> = JSON.parse(
  readFileSync('package.json', 'utf8'),
).scripts;

function runJson(args: string[]) {
  const run = spawnSync('node', ['scripts/gate-for.mjs', '--json', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: run.status,
    stderr: run.stderr,
    plan: JSON.parse(run.stdout),
  };
}

describe('gate-for report', () => {
  it('shows the linked behavior check before a governed Session edit', () => {
    const rules = veritasGuidanceRules([
      'src-server/services/orchestration/session-turn-boundary.ts',
    ]);
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    expect(byId.get('session-lifecycle-recovery-contract')).toMatchObject({
      enforcementLevel: 'Require',
    });
    // The behavior check the rule links, as an evidence-check id.
    expect(rules.flatMap((rule) => rule.evidenceCheckIds)).toContain(
      'session-transition-contract',
    );
    expect(
      byId.get('session-lifecycle-recovery-contract')?.mustDo.length,
    ).toBeGreaterThan(0);
    // The rendered briefing carries every selected rule.
    const guidance = veritasGuidanceForPaths([
      'src-server/services/orchestration/session-turn-boundary.ts',
    ]);
    for (const rule of rules) expect(guidance).toContain(rule.id);
  });

  it('does not invent path guidance for an unrelated file', () => {
    // documentation-source-currentness is a repo-wide Guide, so every path
    // receives it; an unrelated file must receive nothing path-specific.
    const rules = veritasGuidanceRules([
      'docs/plans/issue-class-prevention.md',
    ]);
    expect(rules.map((rule) => rule.id)).toContain(
      'documentation-source-currentness',
    );
    expect(rules.filter((rule) => rule.enforcementLevel === 'Require')).toEqual(
      [],
    );
    expect(rules.flatMap((rule) => rule.evidenceCheckIds)).not.toContain(
      'session-transition-contract',
    );
  });

  it('marks every scoped gate as running for a surface that feeds all four, each a command the hook runs', () => {
    const scopes = gateScopes({
      changedPaths: [
        'src-ui/src/App.tsx',
        'packages/sdk/src/api.ts',
        'src-ui/src/styles/motion.css',
        'src-server/services/orchestration/orchestration-service.ts',
      ],
      baseSha,
    });
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) {
      expect(scope.runs, scope.name).toBe(true);
      expect(PRE_PUSH, scope.name).toContain(scope.command);
    }
  });

  it("marks every scoped gate skipped for a docs-only surface, with the deciders' own reasons", () => {
    const changedPaths = ['docs/guides/testing.md'];
    const scopes = gateScopes({ changedPaths, baseSha });
    expect(scopes.filter((scope) => scope.runs)).toEqual([]);
    expect(scopes.map((scope) => scope.reason)).toEqual(
      [
        decideOrchestrationTransferScope,
        decideStaticGateScope,
        decideSdkBarrelScope,
        decideTypecheckScope,
      ].map((decide) => decide({ baseSha, changedPaths }).reason),
    );
  });

  it('names the source-edit hook commands and a ladder of real commands', () => {
    const plan = gatePlan({ changedPaths: [], baseSha });
    expect(plan.everyPush.length).toBeGreaterThan(0);
    for (const { command } of plan.everyPush)
      expect(PRE_PUSH, command).toContain(
        command.replace('npm run ', 'npm run --silent '),
      );
    // Each runnable rung is a real package script; the rungs that are not
    // local commands (the merge queue, a manual dispatch) say so with null.
    const runnable = plan.ladder.filter((rung) => rung.command !== null);
    expect(runnable.map((rung) => rung.command)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('test:changed'),
        expect.stringContaining('ci:fast'),
        expect.stringContaining('full:regression'),
      ]),
    );
    for (const { command } of runnable) {
      const script = /^npm run ([^ ]+)/.exec(command ?? '')?.[1];
      expect(script && Object.hasOwn(SCRIPTS, script), command ?? '').toBe(
        true,
      );
    }
  });

  it('reports exactly the commands the pre-push hook runs', () => {
    // Derived from the hook itself: every executed `npm run` or
    // `node scripts/...` line is either an every-push check or a scoped
    // gate. A check dropped from the report, or a hook step the report
    // never mentions, fails here. Setup steps that check nothing are named
    // here with their reason, so a new one is still a deliberate decision.
    const SETUP_STEPS = new Map([
      [
        'node scripts/lib/liveness-scale-resolve.mjs',
        'resolves the liveness factor the checks inherit (#3302); refuses only a malformed override',
      ],
    ]);
    const hookCommands = PRE_PUSH.split('\n')
      .filter((line) => !/^\s*(?:#|echo\b)/.test(line))
      .flatMap((line) => {
        const match =
          /(npm run --silent \S+|node scripts\/\S+\.mjs(?: --\S+)*)/.exec(line);
        return match ? [match[1].replace('npm run --silent ', 'npm run ')] : [];
      });
    for (const step of SETUP_STEPS.keys())
      expect(hookCommands, `setup step ${step} left the hook`).toContain(step);
    const plan = gatePlan({ changedPaths: [], baseSha });
    expect(hookCommands.length).toBeGreaterThan(0);
    expect(
      new Set(hookCommands.filter((command) => !SETUP_STEPS.has(command))),
    ).toEqual(
      new Set([
        ...plan.everyPush.map((check) => check.command),
        ...plan.scoped.map((scope) => scope.command),
      ]),
    );
  });

  it('with no base sha, every decider fails open to running by its own rule', () => {
    const scopes = gateScopes({
      changedPaths: ['docs/guides/testing.md'],
      baseSha: '',
    });
    // Deciders treat an unresolvable base as "cannot scope, so run" — the
    // report must reflect that, not soften it.
    expect(scopes.filter((scope) => !scope.runs)).toEqual([]);
  });

  it('accepts --base in both = and space form, and both scope the same branch', () => {
    const eq = runJson(['--base=HEAD']);
    const space = runJson(['--base', 'HEAD']);
    // The space form used to absorb the ref as a changed PATH and answer
    // "nothing applies" about a branch it never looked at — the one output a
    // scoping advisor must never emit.
    expect(space.plan).toEqual(eq.plan);
    expect(space.plan.changedPaths).not.toContain('HEAD');
  });

  it('refuses an unrecognized flag instead of treating it as a path', () => {
    const run = spawnSync('node', ['scripts/gate-for.mjs', '--bogus'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The usage refusal (exit 2), naming the flag, and no report at all.
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--bogus');
    expect(run.stdout).toBe('');
  });

  it('the npm entry point exists and reports on the explicit paths', () => {
    expect(SCRIPTS['gate:for']).toBe('node scripts/gate-for.mjs');
    const { status, plan } = runJson(['docs/guides/testing.md']);
    expect(status).toBe(0);
    expect(plan.changedPaths).toEqual(['docs/guides/testing.md']);
    expect(plan.guidance.map((rule: { id: string }) => rule.id)).toContain(
      'documentation-source-currentness',
    );
  });
});
