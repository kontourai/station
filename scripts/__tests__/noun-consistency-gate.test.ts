import { describe, expect, it } from 'vitest';
import {
  BANNED_WORD_PATTERN,
  maskExpressions,
  RETIRED_NOUN_PATTERN,
  RETIRED_PRODUCT_NOUN_PATTERN,
  runGate,
  SCAN_ROOTS,
  scanFileContent,
  stripComments,
} from '../noun-consistency-gate.mjs';

describe('noun-consistency-gate', () => {
  // Review L: `LayoutHeader.tsx` rendered the retired word "Prompts" from
  // `packages/sdk/src/components`, outside the gate's only root. The scope
  // must keep both trees.
  describe('SCAN_ROOTS', () => {
    it('covers the src-ui tree and the SDK component tree', () => {
      expect(SCAN_ROOTS).toContain('src-ui/src');
      expect(SCAN_ROOTS).toContain('packages/sdk/src/components');
    });
  });
  describe('BANNED_WORD_PATTERN', () => {
    it('matches the case-insensitive family, whole-word only', () => {
      expect(BANNED_WORD_PATTERN.test('Runtime')).toBe(true);
      expect(BANNED_WORD_PATTERN.test('provider')).toBe(false);
      expect(BANNED_WORD_PATTERN.test('guidance')).toBe(true);
      expect(BANNED_WORD_PATTERN.test('Playbook')).toBe(true);
      // whole-word: must not match inside an unrelated identifier
      expect(BANNED_WORD_PATTERN.test('runtimeConnectionId')).toBe(false);
      expect(BANNED_WORD_PATTERN.test('ProviderSettingsView')).toBe(false);
    });

    it('also matches plural forms without over-matching prefixed identifiers', () => {
      expect(BANNED_WORD_PATTERN.test('Runtimes appear here')).toBe(true);
      expect(BANNED_WORD_PATTERN.test('built-in cloud providers')).toBe(false);
      expect(BANNED_WORD_PATTERN.test('No playbooks enabled')).toBe(true);
      expect(BANNED_WORD_PATTERN.test('runtimesomething')).toBe(false);
    });
  });

  // Delta review: `prompt` left the case-insensitive family because the LLM
  // sense ("a text-only prompt", "the system prompt") is canonical lowercase
  // prose. The ban is the retired SURFACE's Title-Case name.
  describe('RETIRED_PRODUCT_NOUN_PATTERN', () => {
    it('bans the capital-P product noun, singular or plural', () => {
      expect(RETIRED_PRODUCT_NOUN_PATTERN.test('Prompts')).toBe(true);
      expect(RETIRED_PRODUCT_NOUN_PATTERN.test('Prompt')).toBe(true);
    });

    it('allows the lowercase LLM sense', () => {
      expect(RETIRED_PRODUCT_NOUN_PATTERN.test('prompt')).toBe(false);
      expect(RETIRED_PRODUCT_NOUN_PATTERN.test('prompts')).toBe(false);
      expect(RETIRED_PRODUCT_NOUN_PATTERN.test('a text-only prompt')).toBe(
        false,
      );
    });

    it('does not match inside identifiers or derived words', () => {
      expect(RETIRED_PRODUCT_NOUN_PATTERN.test('PromptSettingsView')).toBe(
        false,
      );
      expect(RETIRED_PRODUCT_NOUN_PATTERN.test('Prompted')).toBe(false);
    });
  });

  describe('RETIRED_NOUN_PATTERN (station#975 D-4)', () => {
    it('matches the retired agent-editor nouns case-sensitively', () => {
      expect(RETIRED_NOUN_PATTERN.test('External agent')).toBe(true);
      expect(RETIRED_NOUN_PATTERN.test('External agents')).toBe(true);
      expect(RETIRED_NOUN_PATTERN.test('Agent app')).toBe(true);
      expect(RETIRED_NOUN_PATTERN.test('Agent apps')).toBe(true);
      expect(RETIRED_NOUN_PATTERN.test('ACP')).toBe(true);
    });

    it('does not match canonical lowercase prose that legitimately uses these words', () => {
      expect(RETIRED_NOUN_PATTERN.test('an external engine')).toBe(false);
      expect(
        RETIRED_NOUN_PATTERN.test('external agents run on their own engine'),
      ).toBe(false);
      expect(RETIRED_NOUN_PATTERN.test('acp')).toBe(false);
    });
  });

  describe('stripComments', () => {
    it('blanks out line comments but preserves string content and length', () => {
      const source = 'const x = 1; // a runtime comment\nconst y = 2;';
      const stripped = stripComments(source);
      expect(stripped).not.toContain('runtime');
      expect(stripped.length).toBe(source.length);
      expect(stripped.split('\n')).toHaveLength(2);
    });

    it('blanks out block comments across multiple lines, preserving line count', () => {
      const source = '/**\n * a provider note\n */\nconst z = 3;';
      const stripped = stripComments(source);
      expect(stripped).not.toContain('provider');
      expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
    });

    it('does not treat "//" inside a string literal as a comment', () => {
      const source = 'const url = "https://example.com/prompt";';
      const stripped = stripComments(source);
      expect(stripped).toContain('https://example.com/prompt');
    });
  });

  describe('maskExpressions', () => {
    it('leaves plain text untouched and reports balanced', () => {
      const { masked, unbalanced } = maskExpressions('hello world');
      expect(masked).toBe('hello world');
      expect(unbalanced).toBe(false);
    });

    it('masks a simple balanced expression, keeping surrounding text', () => {
      const { masked, unbalanced } = maskExpressions(
        '{form.prompts.length} enabled',
      );
      expect(unbalanced).toBe(false);
      expect(masked).not.toContain('prompts');
      expect(masked.trim().endsWith('enabled')).toBe(true);
    });

    it('flags an unbalanced trailing open expression', () => {
      const { unbalanced } = maskExpressions('{prompt.description && (');
      expect(unbalanced).toBe(true);
    });

    it('flags a stray closing brace at depth 0', () => {
      const { unbalanced } = maskExpressions(')} more text');
      expect(unbalanced).toBe(true);
    });

    it('does not desync brace depth on a brace inside a string literal', () => {
      const { masked, unbalanced } = maskExpressions("{fn('a}b')} tail");
      expect(unbalanced).toBe(false);
      expect(masked.trim().endsWith('tail')).toBe(true);
    });
  });

  describe('scanFileContent', () => {
    it('flags a banned word in a scanned JSX attribute value', () => {
      const source = `
        export function Example() {
          return <div emptyTitle="No runtime connections" />;
        }
      `;
      const findings = scanFileContent('Example.tsx', source);
      expect(findings).toHaveLength(1);
      expect(findings[0].snippet).toBe('No runtime connections');
    });

    // Review L: user-facing copy also travels as object-literal fields, and
    // the JSX-only scanners never read those.
    it('flags a banned word in an object-literal copy field', () => {
      const source =
        'const SUMMARY_CARDS = [\n' +
        "  {\n    title: 'Runtime and policy',\n" +
        "    description: 'Core behavior.',\n  },\n" +
        '] as const;\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings).toHaveLength(1);
      expect(findings[0].snippet).toBe('Runtime and policy');
    });

    it('flags an object-literal copy field whose literal starts on the next line', () => {
      const source =
        'const content = {\n' +
        // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source deliberately embeds a template placeholder
        '  title: `${agentName} needs a model`,\n' +
        '  description:\n' +
        "    'A coding runtime is available.',\n" +
        '};\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings).toHaveLength(1);
      expect(findings[0].snippet).toBe('A coding runtime is available.');
    });

    it('reads a template-literal object field with its interpolations blanked', () => {
      const source =
        'const strip = {\n' +
        // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source deliberately embeds a template placeholder
        '  label: `Runtime running (${stepCount})`,\n' +
        '};\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings).toHaveLength(1);
      expect(findings[0].snippet).toBe('Runtime running ( )');
    });

    it('does not flag a non-literal object field value', () => {
      const source =
        'const strip = {\n' + '  label: deriveRuntimeLabel(state),\n' + '};\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings).toHaveLength(0);
    });

    it('does not flag a non-copy field whose name is not in the attribute vocabulary', () => {
      const source = "const ref = { altTitle: 'prompt history' };";
      const findings = scanFileContent('Example.tsx', source);
      expect(findings).toHaveLength(0);
    });

    // Delta review's exact pair: the LLM sense under a broad copy key passes,
    // the retired product noun fails — the layer's coverage must not turn a
    // vocabulary NON-change into a gate failure when copy moves into a view
    // model (engine-capability-matrix.ts's "text-only prompt" is the live
    // instance).
    it('passes "text-only prompt" and fails "Prompts" under a description key', () => {
      const pass = scanFileContent(
        'Example.tsx',
        "const reason = { description: 'Runs a text-only prompt.' };",
      );
      expect(pass).toHaveLength(0);

      const fail = scanFileContent(
        'Example.tsx',
        "const card = { description: 'Prompts you saved earlier.' };",
      );
      expect(fail).toHaveLength(1);
      expect(fail[0].snippet).toBe('Prompts you saved earlier.');
    });

    it('still bans the lowercase retired nouns under a copy key', () => {
      const fail = scanFileContent(
        'Example.tsx',
        "const card = { description: 'Your saved playbooks.' };",
      );
      expect(fail).toHaveLength(1);
    });

    it('flags a banned word in a template-literal attribute value', () => {
      const source =
        'export function Example() {\n' +
        '  return <div subtitle={`Check readiness for your runtimes`} />;\n' +
        '}\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings.some((f) => f.snippet.includes('runtimes'))).toBe(true);
    });

    it('flags a banned word in a plain JSX text node', () => {
      const source =
        'export function Example() {\n' +
        '  return (\n' +
        '    <div>\n' +
        '      <span>No runtime connections available.</span>\n' +
        '    </div>\n' +
        '  );\n' +
        '}\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(
        findings.some((f) =>
          f.snippet.includes('No runtime connections available.'),
        ),
      ).toBe(true);
    });

    it('does not flag an attribute name that is not on the allowlisted-attribute list', () => {
      const source = `export const x = <div data-testid="runtime-panel" />;`;
      const findings = scanFileContent('Example.tsx', source);
      expect(findings).toHaveLength(0);
    });

    it('does not flag a TypeScript generic that looks like an angle-bracket pair', () => {
      const source =
        "import { useState } from 'react';\n" +
        'export function Example() {\n' +
        '  const [values, setValues] = useState<Record<string, string>>({});\n' +
        '  return <div>{JSON.stringify(values)}</div>;\n' +
        '}\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings).toHaveLength(0);
    });

    it('does not flag banned words inside comments', () => {
      const source =
        'export function Example() {\n' +
        '  // Uses a provider to fetch data, see <meta> for details.\n' +
        '  return <div>Hello</div>;\n' +
        '}\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings).toHaveLength(0);
    });

    it('does not flag a code identifier inside an unbalanced expression-child gap', () => {
      const source =
        'export function Example({ prompt }) {\n' +
        '  return (\n' +
        '    <div>\n' +
        '      <div className="a">{prompt.name}</div>\n' +
        '      {prompt.description && (\n' +
        '        <div className="b">{prompt.description}</div>\n' +
        '      )}\n' +
        '    </div>\n' +
        '  );\n' +
        '}\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings).toHaveLength(0);
    });

    it('does not flag a React context provider tag', () => {
      const source =
        'export function Example() {\n' +
        '  return <MyContext.Provider value={1}>content</MyContext.Provider>;\n' +
        '}\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings).toHaveLength(0);
    });

    it('flags a banned word inside a bare single-quoted JSX-child expression literal', () => {
      const source =
        'export function Example() {\n' +
        "  return <div>{'No runtime connections'}</div>;\n" +
        '}\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(
        findings.some((f) => f.snippet.includes('No runtime connections')),
      ).toBe(true);
    });

    it('flags a banned word inside a bare template-literal JSX-child expression, masking only the interpolation', () => {
      const source =
        'export function Example({ count }) {\n' +
        // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source deliberately contains a literal placeholder
        '  return <div>{`No ${count} runtimes found`}</div>;\n' +
        '}\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings.some((f) => f.snippet.includes('runtimes'))).toBe(true);
    });

    it('masks the dollar-brace interpolation of a bare template-literal JSX-child expression so a banned word inside the interpolation is not flagged', () => {
      // The interpolated expression itself is code, not text — a banned
      // word appearing only inside `${...}` (e.g. a variable named
      // `runtimeCount`) must not surface a finding from the literal text
      // outside it.
      const source =
        'export function Example({ runtimeCount }) {\n' +
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture deliberately embeds an interpolation
        '  return <div>{`Count: ${runtimeCount}`}</div>;\n' +
        '}\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings).toHaveLength(0);
    });

    it("flags a banned word inside an attribute-expression string literal (title={'...'})", () => {
      const source = `export const x = <div title={'runtime'} />;`;
      const findings = scanFileContent('Example.tsx', source);
      expect(findings.some((f) => f.snippet === 'runtime')).toBe(true);
    });

    it('does not flag a bare identifier JSX-child expression (not a literal)', () => {
      const source =
        'export function Example({ someRuntimeVar }) {\n' +
        '  return <div>{someRuntimeVar}</div>;\n' +
        '}\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings).toHaveLength(0);
    });

    it('flags multiple genuinely distinct violations in one file', () => {
      const source =
        'export function Example() {\n' +
        '  return (\n' +
        '    <div>\n' +
        '      <div emptyTitle="No runtime connections" />\n' +
        '      <span>Ask for guidance here.</span>\n' +
        '    </div>\n' +
        '  );\n' +
        '}\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings.length).toBeGreaterThanOrEqual(2);
    });

    it('flags a retired-noun JSX text node (station#975 D-4)', () => {
      const source =
        'export function Example() {\n' +
        '  return <div><span>External agent</span></div>;\n' +
        '}\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings.some((f) => f.snippet.includes('External agent'))).toBe(
        true,
      );
    });

    it('does not flag canonical lowercase prose mentioning an external engine', () => {
      const source =
        'export function Example() {\n' +
        '  return <div><span>Runs on an external engine.</span></div>;\n' +
        '}\n';
      const findings = scanFileContent('Example.tsx', source);
      expect(findings).toHaveLength(0);
    });
  });

  describe('runGate', () => {
    it('reports un-allowlisted findings and accepts exact-matched allowlist entries', () => {
      const files = ['Example.tsx'];
      const source = `export const x = <div emptyTitle="No runtime connections" />;`;
      const readFile = () => source;

      const clean = runGate({ files, readFile, allowlist: [] });
      expect(clean.unallowlisted).toHaveLength(1);
      expect(clean.staleEntries).toHaveLength(0);

      const allowlist = [
        {
          file: 'Example.tsx',
          line: clean.findings[0].line,
          snippet: clean.findings[0].snippet,
          reason: 'test fixture',
        },
      ];
      const allowlisted = runGate({ files, readFile, allowlist });
      expect(allowlisted.unallowlisted).toHaveLength(0);
      expect(allowlisted.staleEntries).toHaveLength(0);
    });

    it('flags a stale allowlist entry once the underlying finding disappears', () => {
      const files = ['Example.tsx'];
      const readFile = () => `export const x = <div>All good now</div>;`;
      const allowlist = [
        {
          file: 'Example.tsx',
          line: 1,
          snippet: 'No runtime connections',
          reason: 'stale fixture',
        },
      ];
      const result = runGate({ files, readFile, allowlist });
      expect(result.unallowlisted).toHaveLength(0);
      expect(result.staleEntries).toHaveLength(1);
    });
  });
});
