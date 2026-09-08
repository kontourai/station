import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

/**
 * station#2299: this proof used to read every required source with a bare
 * `readFileSync`, so one retired file (`CodingLayout.tsx`) aborted the whole
 * run with an uncaught ENOENT before a single guardrail was evaluated — and
 * nothing noticed, because the aggregate never got to print a verdict.
 *
 * `repo-guardrail-source.test.ts` already covers the reader in isolation with
 * an injected `readSource`. That is exactly the coverage that let the defect
 * exist: the helper was correct and 297 call sites did not use it. These tests
 * therefore execute the real script as a child process and assert its real
 * exit status, which is the only thing that was ever actually broken.
 *
 * The script resolves every guardrail source as `../<path>` relative to its own
 * module URL, so a copy placed in a directory at repo-root depth resolves the
 * same tree. That keeps the negative mutation entirely inside a temporary
 * directory — the shared worktree is never mutated, which matters because this
 * checkout has concurrent writers.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const scriptPath = join(repoRoot, 'scripts/proof-repo-guardrails.mjs');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

/**
 * Copies the proof into a sibling directory of `scripts/` so its `../` reads
 * still resolve against the repo root, rewriting only its sibling-module
 * imports and its baseline path. `mutate` may then patch the copy's source.
 */
function runProofCopy(
  mutate: (source: string) => string = (source) => source,
  mutateChatRequestPreparation?: (source: string) => string,
  mutateConfigContext?: (source: string) => string,
  mutateAgentConnectionView?: (source: string) => string,
) {
  const root = join(repoRoot, `.proof-guardrails-negative-${process.pid}`);
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root, { recursive: true });
  temporaryRoots.push(root);

  // Only the three sibling-module import specifiers are rewritten. A blanket
  // replace would also corrupt the ~32 assertion string literals that quote
  // `from './...'` as expected source text.
  let source = readFileSync(scriptPath, 'utf8');
  for (const siblingModule of [
    'ci-workflow-governance.mjs',
    'repo-guardrail-source.mjs',
    'route-error-egress-gate.mjs',
    'lib/ratchet-utils.mjs',
  ]) {
    source = source.replace(
      `from './${siblingModule}'`,
      `from '../scripts/${siblingModule}'`,
    );
  }
  const baselineRewrite = source.replace(
    "readRequiredJson('./proof-repo-guardrails-baseline.json')",
    "readRequiredJson('../scripts/proof-repo-guardrails-baseline.json')",
  );
  // Guard the rewrite itself: if this anchor ever stops matching, the copy
  // silently loses its baseline and every case below fails for the wrong
  // reason.
  if (baselineRewrite === source) {
    throw new Error(
      'baseline path rewrite did not match; update the anchor in this test',
    );
  }
  source = baselineRewrite;

  if (mutateChatRequestPreparation) {
    writeFileSync(
      join(root, 'chat-request-preparation.ts'),
      mutateChatRequestPreparation(
        readFileSync(
          join(repoRoot, 'src-server/routes/chat/chat-request-preparation.ts'),
          'utf8',
        ),
      ),
    );
    const sourcePathRewrite = source.replace(
      "'../src-server/routes/chat/chat-request-preparation.ts'",
      "'./chat-request-preparation.ts'",
    );
    if (sourcePathRewrite === source) {
      throw new Error(
        'chat request preparation path rewrite did not match; update the anchor in this test',
      );
    }
    source = sourcePathRewrite;
  }

  if (mutateConfigContext) {
    writeFileSync(
      join(root, 'ConfigContext.tsx'),
      mutateConfigContext(
        readFileSync(
          join(repoRoot, 'src-ui/src/contexts/ConfigContext.tsx'),
          'utf8',
        ),
      ),
    );
    const sourcePathRewrite = source.replace(
      "'../src-ui/src/contexts/ConfigContext.tsx'",
      "'./ConfigContext.tsx'",
    );
    if (sourcePathRewrite === source) {
      throw new Error(
        'ConfigContext path rewrite did not match; update the anchor in this test',
      );
    }
    source = sourcePathRewrite;
  }

  if (mutateAgentConnectionView) {
    writeFileSync(
      join(root, 'AgentConnectionView.tsx'),
      mutateAgentConnectionView(
        readFileSync(
          join(repoRoot, 'src-ui/src/views/AgentConnectionView.tsx'),
          'utf8',
        ),
      ),
    );
    const sourcePathRewrite = source.replace(
      "'../src-ui/src/views/AgentConnectionView.tsx'",
      "'./AgentConnectionView.tsx'",
    );
    if (sourcePathRewrite === source) {
      throw new Error(
        'AgentConnectionView path rewrite did not match; update the anchor in this test',
      );
    }
    source = sourcePathRewrite;
  }

  const copy = join(root, 'proof-repo-guardrails.mjs');
  // The copy is ESM resolved from inside the repo, so node_modules is found by
  // the usual upward lookup; nothing else needs to be staged.
  writeFileSync(copy, mutate(source));

  const result = spawnSync(process.execPath, [copy], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('proof:repo-guardrails protects detailed chat context provenance', () => {
  test.each([
    'ctx.knowledgeService.getRAGContextDetailed(',
    'ctx.feedbackService.getBehaviorGuidelinesDetailed()',
  ])('removing %s emits its structured finding', (requiredCall) => {
    const { status, output } = runProofCopy(undefined, (source) => {
      const mutated = source.replace(
        requiredCall,
        requiredCall.replace('Detailed', 'Retired'),
      );
      if (mutated === source) {
        throw new Error(`negative mutation did not find ${requiredCall}`);
      }
      return mutated;
    });

    expect(output).toContain(
      `chat-request-preparation.ts must include ${requiredCall}.`,
    );
    expect(output).toContain('Repo guardrail proof failed');
    expect(status).toBe(1);
  });
});

describe('proof:repo-guardrails fails closed on a missing source', () => {
  test('positive control: the unmutated proof passes', () => {
    const { status, output } = runProofCopy();

    // station#3879 restored this to a real verdict. It had been loosened to
    // `passed|failed` and `[0, 1]` to get main green past ~20 stale
    // prompt-era findings — which left the aggregator unable to report
    // anything anyone would read: it passed whether the proof passed or
    // failed, so new drift would land silently and look like coverage. The
    // findings are dispositioned; the control asserts the verdict again.
    expect(output).toContain('Repo guardrail proof passed');
    expect(status).toBe(0);
    expect(output).not.toMatch(/(?:node:fs|at readFileSync|uncaught)/i);
  });

  test('distinguishes a raw fetch call from the SDK query refetch callback', () => {
    const { status, output } = runProofCopy(
      undefined,
      undefined,
      undefined,
      (source) => {
        const mutated = source.replace(
          'onRetry={() => void refetchRuntimes()}',
          "onRetry={() => void fetch('/api/connections')}",
        );
        if (mutated === source) {
          throw new Error(
            'negative mutation did not find the refetch callback',
          );
        }
        return mutated;
      },
    );

    expect(output).toContain(
      'AgentConnectionView must not issue raw fetch() calls.',
    );
    expect(output).toContain('Repo guardrail proof failed');
    expect(status).toBe(1);
  });

  test('a retired required source is a named finding, not an uncaught ENOENT', () => {
    const { status, output } = runProofCopy((source) =>
      source.replace(
        "readRequiredSource(\n  '../src-ui/src/workspace-panes/builtinWorkspacePaneRegistry.tsx',\n)",
        "readRequiredSource('../src-ui/src/components/coding-layout/CodingLayout.tsx')",
      ),
    );

    // The whole defect: this used to throw before any verdict existed.
    expect(output).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(output).not.toMatch(/^\s*at .+:\d+:\d+$/m);
    expect(output).toContain(
      'Missing required guardrail source: ../src-ui/src/components/coding-layout/CodingLayout.tsx',
    );
    // ...and the run still reached the aggregate verdict rather than dying.
    expect(output).toContain('Repo guardrail proof failed');
    expect(status).toBe(1);
  });

  test('the rest of the suite is still evaluated after a missing source', () => {
    const { output } = runProofCopy((source) =>
      source.replace(
        "readRequiredSource(\n  '../src-ui/src/workspace-panes/builtinWorkspacePaneRegistry.tsx',\n)",
        "readRequiredSource('../src-ui/src/components/coding-layout/CodingLayout.tsx')",
      ),
    );

    // An empty source makes that guardrail's own delegation assertions fail,
    // which proves evaluation continued past the missing read instead of
    // unwinding — the behaviour the ENOENT crash denied.
    expect(output).toContain(
      'must delegate its coding panes to the extracted section',
    );
  });
});

describe('proof:repo-guardrails parses required JSON without crashing', () => {
  // Found by independent review of the first fix: converting the reads to the
  // fail-closed reader is not enough when a caller immediately parses the
  // result. The reader returns '' for a missing file, and JSON.parse('')
  // throws — reintroducing the exact crash-before-verdict this proof was
  // repaired for, for that one source.
  test('a missing JSON source is a finding, not a SyntaxError', () => {
    const { status, output } = runProofCopy((source) =>
      source.replace(
        "readRequiredJson('../package.json')",
        "readRequiredJson('../package.json.retired')",
      ),
    );

    expect(output).not.toContain('SyntaxError');
    expect(output).toContain(
      'Missing required guardrail source: ../package.json.retired',
    );
    // Evaluation continued: the guardrails reading it failed on their own terms.
    expect(output).toContain('package.json is missing required script');
    expect(output).toContain('Repo guardrail proof failed');
    expect(status).toBe(1);
  });

  test('a required source that is not JSON is a named finding', () => {
    const { status, output } = runProofCopy((source) =>
      source.replace(
        "readRequiredJson('../package.json')",
        "readRequiredJson('../README.md')",
      ),
    );

    expect(output).not.toContain('SyntaxError:');
    expect(output).toContain(
      'Required guardrail source ../README.md is not valid JSON',
    );
    expect(output).toContain('Repo guardrail proof failed');
    expect(status).toBe(1);
  });
});

describe('proof:repo-guardrails baseline can only shrink', () => {
  test('the historical violation baseline is fully burned down', () => {
    const known = JSON.parse(
      readFileSync(
        join(repoRoot, 'scripts/proof-repo-guardrails-baseline.json'),
        'utf8',
      ),
    ).knownViolations as string[];

    expect(known).toEqual([]);
  });

  test('a violation outside the baseline fails the proof by name', () => {
    const { status, output } = runProofCopy((source) =>
      source.replace(
        "for (const requiredImport of ['./CodingTerminalPanel', './NewTerminalModal']) {",
        "for (const requiredImport of ['./ASectionThatIsNotDelegated']) {",
      ),
    );

    expect(output).toContain(
      'CodingTerminalPane.tsx must delegate its terminal surface to the extracted section ./ASectionThatIsNotDelegated',
    );
    expect(status).toBe(1);
  });

  test('a missing source can never be baselined away', () => {
    // The reader returns '' for a missing file, which makes every negative
    // `must not inline X` assertion about it vacuously true. The missing-source
    // finding is the only thing still holding those up, so baselining it would
    // absorb the absence AND silently pass all of them.
    const { status, output } = runProofCopy((source) =>
      source.replace(
        'const baselinedMissingSources = (baseline.knownViolations ?? []).filter(',
        `const baselinedMissingSources = [...(baseline.knownViolations ?? []), 'Missing required guardrail source: ../src-ui/src/components/coding-layout/CodingLayout.tsx.'].filter(`,
      ),
    );

    expect(output).toContain(
      'a missing guardrail source may never be baselined',
    );
    expect(output).toContain('do not record its absence');
    expect(status).toBe(1);
  });

  test('a baselined violation that no longer occurs fails until it is deleted', () => {
    const known = JSON.parse(
      readFileSync(
        join(repoRoot, 'scripts/proof-repo-guardrails-baseline.json'),
        'utf8',
      ),
    ).knownViolations as string[];
    expect(known).toEqual([]);

    const { status, output } = runProofCopy((source) =>
      source.replace(
        'const knownViolations = new Set(baseline.knownViolations ?? []);',
        `const knownViolations = new Set([...(baseline.knownViolations ?? []), 'a violation nothing emits']);`,
      ),
    );

    expect(output).toContain('baselined violation(s) no longer occur');
    expect(output).toContain('a violation nothing emits');
    expect(status).toBe(1);
  });
});
