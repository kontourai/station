import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLAIM_SURFACES,
  checkDeclarationCoverage,
  extractFunctionBody,
  extractRecordEntries,
  extractSwitchMembers,
  runClaimFixtureCheck,
  stripComments,
  testFileHasQuotedToken,
  testFileHasSubstring,
} from '../claim-fixture-ratchet.mjs';

function readFileFromMap(files: Record<string, string>) {
  return (file: string) => {
    if (!(file in files)) {
      throw new Error(`unexpected read: ${file}`);
    }
    return files[file];
  };
}

describe('claim-fixture-ratchet', () => {
  describe('extractFunctionBody', () => {
    it('extracts a plain function body (no return type)', () => {
      const src = `
function relationshipLine(source, authorized) {
  switch (source) {
    case 'ssh':
      return 'a';
  }
}
`;
      const body = extractFunctionBody(src, 'relationshipLine');
      expect(body).toContain("case 'ssh'");
    });

    it('skips an inline object-type return-type annotation to find the real body (the exact shape SshEnvironmentsSection.tsx\'s statusView uses, which a naive "first brace after params" scan gets wrong)', () => {
      const src = `
function statusView(state) : {
  label: string;
  tone: 'ready' | 'warn' | 'error' | 'disabled';
  detail?: string;
} {
  switch (state.phase) {
    case 'connected':
      return { label: 'Ready', tone: 'ready' };
    case 'idle':
      return { label: 'Not connected', tone: 'disabled' };
  }
}
`;
      const body = extractFunctionBody(src, 'statusView');
      expect(body).toContain('switch (state.phase)');
      expect(body).toContain("case 'idle'");
      // Proves the naive scan is actually wrong on this shape, not just untested: taking the
      // FIRST brace after the params captures only the return-type annotation, which contains
      // neither 'switch' nor the 'idle' case at all.
      expect(body?.startsWith('{')).toBe(true);
    });

    it('returns null when the named function is not declared', () => {
      expect(extractFunctionBody('const x = 1;', 'notThere')).toBeNull();
    });
  });

  describe('extractSwitchMembers', () => {
    it('extracts every case label, including stacked labels sharing one body, in source order, deduped', () => {
      const src = `
function unlocksLine(state) {
  switch (state.phase) {
    case 'connected':
      return 'a';
    case 'starting':
    case 'verifying':
    case 'launching':
      return 'b';
    case 'idle':
      return 'c';
  }
}
`;
      expect(extractSwitchMembers(src, 'unlocksLine')).toEqual([
        'connected',
        'starting',
        'verifying',
        'launching',
        'idle',
      ]);
    });

    it('returns null when the declaration cannot be located (registry drift)', () => {
      expect(extractSwitchMembers('const x = 1;', 'missingFn')).toBeNull();
    });
  });

  describe('extractRecordEntries', () => {
    it('extracts key/value pairs from a single-line Record literal', () => {
      const src = `const SOURCE_TONE: Record<X, 'warn' | 'disabled'> = {\n  paired: 'disabled',\n  manual: 'disabled',\n  ssh: 'warn',\n};\n`;
      expect(extractRecordEntries(src, 'SOURCE_TONE')).toEqual([
        { key: 'paired', value: 'disabled' },
        { key: 'manual', value: 'disabled' },
        { key: 'ssh', value: 'warn' },
      ]);
    });

    it('extracts key/value pairs across a multi-line type annotation (the exact pre-#1116-fix shape)', () => {
      const src = `const SOURCE_TONE: Record<\n  KnownEnvironment['source'],\n  'ready' | 'warn' | 'disabled'\n> = {\n  paired: 'ready',\n  manual: 'disabled',\n  ssh: 'warn',\n  discovered: 'warn',\n};\n`;
      expect(extractRecordEntries(src, 'SOURCE_TONE')).toEqual([
        { key: 'paired', value: 'ready' },
        { key: 'manual', value: 'disabled' },
        { key: 'ssh', value: 'warn' },
        { key: 'discovered', value: 'warn' },
      ]);
    });

    it('returns null when the declaration cannot be located (registry drift)', () => {
      expect(extractRecordEntries('const x = 1;', 'MISSING')).toBeNull();
    });
  });

  describe('stripComments', () => {
    it('removes // line comments but preserves string/template contents (including URLs containing "//")', () => {
      const src = `const url = 'https://box-b.tailnet.ts.net'; // comment mentioning 'idle'\nconst y = 1;`;
      const stripped = stripComments(src);
      expect(stripped).toContain("'https://box-b.tailnet.ts.net'");
      expect(stripped).not.toContain('comment mentioning');
      expect(stripped).toContain('const y = 1;');
    });

    it('removes /* */ block comments', () => {
      const src = `/* mentions 'idle' and 'error' */\nconst z = 'idle';`;
      const stripped = stripComments(src);
      expect(stripped).not.toContain('mentions');
      expect(stripped).toContain("const z = 'idle';");
    });

    it('[the false-positive this exists to prevent] a quoted word inside a // comment must not satisfy quoted-token coverage', () => {
      const testFile = `// The busy overlay text is shared with 'starting'/'verifying' — this is\n// the existing, unchanged busy-state rendering rule, not a regression.\nconst other = 'launching';`;
      expect(testFileHasQuotedToken(testFile, 'starting')).toBe(true); // pre-strip: false positive
      expect(testFileHasQuotedToken(stripComments(testFile), 'starting')).toBe(
        false,
      ); // post-strip: correctly absent
      expect(testFileHasQuotedToken(stripComments(testFile), 'launching')).toBe(
        true,
      ); // real fixture data untouched
    });
  });

  describe('testFileHasQuotedToken / testFileHasSubstring', () => {
    it('quoted-token search is exact, not a bare substring (avoids "error" matching inside "network error")', () => {
      const testFile = `const e = new Error('network error');`;
      expect(testFileHasQuotedToken(testFile, 'error')).toBe(false);
      expect(testFileHasQuotedToken(testFile, 'network error')).toBe(true);
    });

    it('value-coverage substring search matches a value embedded in a longer asserted string', () => {
      const testFile = `expect(badge.className).toContain('connections-page__status-badge--disabled');`;
      expect(testFileHasSubstring(testFile, 'disabled')).toBe(true);
      expect(testFileHasSubstring(testFile, 'ready')).toBe(false);
    });
  });

  describe('checkDeclarationCoverage', () => {
    it('flags an unfixtured switch member', () => {
      const sourceContent = `
function unlocksLine(state) {
  switch (state.phase) {
    case 'connected':
      return 'a';
    case 'idle':
      return 'b';
  }
}
`;
      const testContent = `render(<X />); // phase: 'connected' only`;
      const { findings } = checkDeclarationCoverage({
        sourceContent,
        testContent: stripComments(testContent),
        declaration: { name: 'unlocksLine', kind: 'switch' },
      });
      expect(findings).toEqual([
        { member: 'connected', covered: false, evidence: expect.any(String) },
        { member: 'idle', covered: false, evidence: expect.any(String) },
      ]);
    });

    it('covers a switch member once its exact literal is constructed in the test file', () => {
      const sourceContent = `
function unlocksLine(state) {
  switch (state.phase) {
    case 'idle':
      return 'b';
  }
}
`;
      const testContent = `mocks.state = { phase: 'idle' };`;
      const { findings } = checkDeclarationCoverage({
        sourceContent,
        testContent,
        declaration: { name: 'unlocksLine', kind: 'switch' },
      });
      expect(findings).toEqual([
        { member: 'idle', covered: true, evidence: expect.any(String) },
      ]);
    });

    it('returns membersFound: null for a stale registry entry (declaration renamed/removed)', () => {
      const { membersFound } = checkDeclarationCoverage({
        sourceContent: 'const x = 1;',
        testContent: '',
        declaration: { name: 'goneFunction', kind: 'switch' },
      });
      expect(membersFound).toBeNull();
    });
  });

  describe('runClaimFixtureCheck (synthetic)', () => {
    it('sums gaps across surfaces and respects the ceiling', () => {
      const files: Record<string, string> = {
        'a.tsx': `function f(s){switch(s.phase){case 'x': return 1; case 'y': return 2;}}`,
        'a.test.tsx': `phase: 'x'`,
      };
      const result = runClaimFixtureCheck({
        surfaces: [
          {
            file: 'a.tsx',
            testFile: 'a.test.tsx',
            declarations: [{ name: 'f', kind: 'switch' }],
          },
        ],
        readFile: readFileFromMap(files),
        ceiling: 0,
      });
      expect(result.gaps.map((g) => g.member)).toEqual(['y']);
      expect(result.withinCeiling).toBe(false);
    });

    it('reports an unresolved declaration separately from a coverage gap', () => {
      const files: Record<string, string> = {
        'a.tsx': `const nothingHere = 1;`,
        'a.test.tsx': ``,
      };
      const result = runClaimFixtureCheck({
        surfaces: [
          {
            file: 'a.tsx',
            testFile: 'a.test.tsx',
            declarations: [{ name: 'missingFn', kind: 'switch' }],
          },
        ],
        readFile: readFileFromMap(files),
        ceiling: 0,
      });
      expect(result.unresolved).toEqual([
        { file: 'a.tsx', declaration: 'missingFn' },
      ]);
      expect(result.gaps).toHaveLength(0);
    });
  });

  // #1184's acceptance bar: reconstruct at least two of the historical defects and prove this
  // gate would have gone red on them. Both fixtures below are the ACTUAL historical source, taken
  // verbatim from git history (not paraphrased), at the exact pre-fix commit — proving this against
  // a synthetic "obviously broken" fixture would not meet the bar #1184 sets.
  describe('historical reconstruction (#1184 acceptance bar)', () => {
    // station#1134, commit 6d3081ab (pre dfbe3b3e "honor the honesty rule" fix): statusView already
    // existed, phase-exhaustive, unchanged in shape by the fix — the union was already known. The
    // capability sentence itself was NOT gated by any switch at all (see the PR description / #1184
    // for the removed unconditional JSX); this reconstruction registers `statusView` (the
    // component's own pre-existing phase-exhaustive switch) as the anchor, exactly as this gate's
    // real CLAIM_SURFACES entry for this file does today, and shows it already would have flagged
    // 'idle' as unexercised at the moment the bug shipped.
    const HISTORICAL_1166_SOURCE = `
function statusView(state: SshEnvironmentState): {
  label: string;
  tone: 'ready' | 'warn' | 'error' | 'disabled';
  detail?: string;
} {
  switch (state.phase) {
    case 'connected':
      return { label: 'Ready', tone: 'ready', detail: 'Verified and ready for delegated work.' };
    case 'starting':
      return { label: 'Connecting...', tone: 'warn', detail: \`Starting SSH connection (attempt \${state.attempt}).\` };
    case 'verifying':
      return { label: 'Verifying...', tone: 'warn', detail: 'Checking Station, Node.js, and the project folder.' };
    case 'prompt':
      return { label: 'Needs attention', tone: 'warn', detail: \`Complete the SSH \${state.prompt} prompt from an interactive terminal.\` };
    case 'host-key':
      return { label: 'Host key', tone: 'error', detail: state.reason === 'changed' ? 'The host key changed. Review it in a terminal before reconnecting.' : 'Confirm this host once from an interactive SSH terminal, then reconnect.' };
    case 'agent':
      return { label: 'SSH agent', tone: 'error', detail: state.reason === 'unavailable' ? 'Start your SSH agent and load the host key, then reconnect.' : 'The SSH agent rejected this key. Check the host configuration and retry.' };
    case 'error':
      return { label: 'Action needed', tone: 'error', detail: state.action };
    case 'disconnected':
      return { label: state.reason === 'stopped' ? 'Stopped' : 'Disconnected', tone: 'disabled', detail: state.reason === 'transport-error' ? 'The SSH connection was interrupted. Reconnect when the host is available.' : undefined };
    case 'idle':
      return { label: 'Not connected', tone: 'disabled' };
  }
}
`;
    // The ACTUAL pre-fix test file's only two phase-varying fixtures (verbatim, station#1134
    // original commit 6d3081ab): the default mock is 'connected'; exactly one test overrides
    // 'disconnected'. Nothing else. The capability sentence ("This Station can run delegated tasks
    // here...") was asserted only under this same untouched 'connected' default.
    const HISTORICAL_1166_TEST = `
describe('SshEnvironmentsSection on mobile', () => {
  beforeEach(() => {
    mocks.environments = [{ profile: { name: 'Brian media' }, state: { phase: 'connected' } }];
  });

  test('offers a touch-sized stop control', () => {
    render(<SshEnvironmentsSection />);
  });

  test('turns a previously verified stopped environment into a Resume action', () => {
    mocks.environments[0].state = { phase: 'disconnected', reason: 'stopped' };
    render(<SshEnvironmentsSection />);
  });

  test('states what this environment unlocks', () => {
    render(<SshEnvironmentsSection />);
    expect(screen.getByText('This Station can run delegated tasks here — work runs on Brian media, with its own agents and workspace.')).toBeTruthy();
  });
});
`;

    it('#1166 reconstruction: flags "idle" (the exact phase that shipped the false capability claim) as an unfixtured statusView state', () => {
      const { membersFound, findings } = checkDeclarationCoverage({
        sourceContent: HISTORICAL_1166_SOURCE,
        testContent: stripComments(HISTORICAL_1166_TEST),
        declaration: { name: 'statusView', kind: 'switch' },
      });
      expect(membersFound).toContain('idle');
      const idleFinding = findings.find((f) => f.member === 'idle');
      expect(idleFinding?.covered).toBe(false);
      // Also unexercised at the same historical point (not just idle) — 'starting', 'verifying',
      // 'prompt', 'agent', 'error' were all equally untested, all equally at risk of the same class
      // of unevidenced claim.
      const uncovered = findings.filter((f) => !f.covered).map((f) => f.member);
      expect(uncovered).toEqual(
        expect.arrayContaining([
          'starting',
          'verifying',
          'prompt',
          'agent',
          'error',
          'idle',
        ]),
      );
      expect(uncovered).not.toContain('connected');
      expect(uncovered).not.toContain('disconnected');
    });

    // station#1096/#1116, commit 0eb29013 (pre 7b2f6eb8 "#1116 review" fix): SOURCE_TONE maps
    // `paired` to `'ready'` — the exact green-liveness-from-provenance defect #1184 names.
    const HISTORICAL_1116_SOURCE = `
const SOURCE_LABEL: Record<KnownEnvironment['source'], string> = {
  manual: 'Manual',
  ssh: 'SSH',
  paired: 'Paired',
  discovered: 'Discovered',
};

const SOURCE_TONE: Record<
  KnownEnvironment['source'],
  'ready' | 'warn' | 'disabled'
> = {
  paired: 'ready',
  manual: 'disabled',
  ssh: 'warn',
  discovered: 'warn',
};
`;
    // The ACTUAL pre-review-fix test file (verbatim, commit 0eb29013): the paired row's LABEL is
    // asserted ('Paired' truthy), proving the row genuinely rendered — but the badge's tone/class
    // is never asserted anywhere in the file. A plain "was this member ever rendered" check would
    // wrongly call this covered; this is exactly why SOURCE_TONE is registered as `kind: 'record'`
    // (value-coverage), not `kind: 'switch'` (key-coverage).
    const HISTORICAL_1116_TEST = `
test('lists a paired connection with a source badge', () => {
  connectionsState.data = [makeConnection()];
  render(<KnownEnvironmentsSection />);
  expect(screen.getByText('Box B')).toBeTruthy();
  expect(screen.getByText('Paired')).toBeTruthy();
});
`;

    it('#1116 reconstruction: flags "paired" as an unfixtured SOURCE_TONE claim, even though the row itself (and its label) was rendered and asserted', () => {
      const { membersFound, findings } = checkDeclarationCoverage({
        sourceContent: HISTORICAL_1116_SOURCE,
        testContent: stripComments(HISTORICAL_1116_TEST),
        declaration: { name: 'SOURCE_TONE', kind: 'record' },
      });
      expect(membersFound).toEqual(['paired', 'manual', 'ssh', 'discovered']);
      const pairedFinding = findings.find((f) => f.member === 'paired');
      expect(pairedFinding?.covered).toBe(false);
      // Every tone is unasserted at this historical point, not just the wrong one — the gap this
      // gate reports is "no test verifies the tone this member currently renders", which is
      // simultaneously true before AND after the fix corrects the value; only the VALUE changes.
      expect(findings.every((f) => !f.covered)).toBe(true);

      // Contrast: the SAME historical test file, checked against SOURCE_LABEL (kind: 'record',
      // value = 'Paired'), DOES cover 'paired' — proving the gate's distinction is real: this test
      // suite exercised identity (the label) but not the liveness-adjacent tone claim riding along
      // beside it, which is the precise shape of #1116's own review finding.
      const labelResult = checkDeclarationCoverage({
        sourceContent: HISTORICAL_1116_SOURCE,
        testContent: stripComments(HISTORICAL_1116_TEST),
        declaration: { name: 'SOURCE_LABEL', kind: 'record' },
      });
      const pairedLabelFinding = labelResult.findings.find(
        (f) => f.member === 'paired',
      );
      expect(pairedLabelFinding?.covered).toBe(true);
    });
  });

  // #1196 independent review, HIGH finding: a bare substring search treated a value asserted
  // only through `.not.` as positive coverage. This reconstruction re-injects the same
  // provenance-as-liveness defect into the current pure computer-row model, then proves the
  // current ComputersSection fixture has no positive assertion for that wrong `ready` value.
  describe('same-member negative-assertion shadowing reconstruction', () => {
    it('re-injecting the paired authorized tone defect into the real current row model finds ready only inside a `.not.` chain in the real current fixture', () => {
      const realSource = readFileSync(
        'src-ui/src/views/connections-hub/computer-rows.ts',
        'utf8',
      );
      const realTestContent = readFileSync(
        'src-ui/src/__tests__/ComputersSection.test.tsx',
        'utf8',
      );
      const strippedTestContent = stripComments(realTestContent);

      // Sanity: the real, current test file really does assert the injected value only inside a
      // `.not.` chain — if this ever stops being true (the regression guard was rewritten), this
      // reconstruction needs re-deriving, not silently passing for a different reason.
      expect(realTestContent).toContain(
        "expect(state.className).not.toContain(\n      'connections-computers__state--ready',",
      );

      // Re-inject the paired authorized provenance-as-liveness defect.
      const injectedSource = realSource.replace(
        "? { label: 'Authorized', tone: 'disabled' }",
        "? { label: 'Authorized', tone: 'ready' }",
      );
      expect(injectedSource).not.toBe(realSource); // guard: the replace actually matched
      expect(injectedSource).toContain(
        "? { label: 'Authorized', tone: 'ready' }",
      );
      // The polarity-aware helper rejects the test's only `ready` occurrence because it sits in
      // the `.not.` chain above; a bare substring search would incorrectly return true.
      expect(testFileHasSubstring(strippedTestContent, 'ready')).toBe(false);
    });
  });

  describe('CLAIM_SURFACES (repo-source integration)', () => {
    it('every registered declaration resolves against the real, current repo files (no stale registry entries)', () => {
      const readFile = (file: string) => readFileSync(file, 'utf8');
      const result = runClaimFixtureCheck({
        surfaces: CLAIM_SURFACES,
        readFile,
        ceiling: Number.POSITIVE_INFINITY,
      });
      expect(result.unresolved).toEqual([]);
    });

    it('the real repo files produce the exact checked-in baseline gap count (fails loudly on drift in either direction — see scripts/claim-fixture-baseline.json)', () => {
      const readFile = (file: string) => readFileSync(file, 'utf8');
      const baseline = JSON.parse(
        readFileSync(
          new URL('../claim-fixture-baseline.json', import.meta.url),
          'utf8',
        ),
      );
      const result = runClaimFixtureCheck({
        surfaces: CLAIM_SURFACES,
        readFile,
        ceiling: baseline.gapCeiling,
      });
      expect(result.gaps.length).toBe(baseline.gapCeiling);
    });
  });
});
