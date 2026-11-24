import { describe, expect, it } from 'vitest';
import {
  ACTIVE_RETIRED_USER_TERMS,
  BANNED_WORD_PATTERN,
  maskExpressions,
  RETIRED_NOUN_PATTERN,
  RETIRED_PRODUCT_NOUN_PATTERN,
  RETIRED_USER_TERMS,
  runGate,
  SCAN_ROOTS,
  scanCopySourceContent,
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

  // The 2026-11 UI copy pass and the first-release design retire these; the
  // lanes that remove the last uses enforce them (RETIRED_USER_TERMS header).
  describe('RETIRED_USER_TERMS', () => {
    const VIOLATIONS: Record<string, string> = {
      'AI app': 'Pick an AI app',
      'device hub': 'Open the device hub',
      'Station owner': 'Ask the Station owner',
      'built-in assistant': 'Use the built-in assistant',
      'default assistant': 'Set the default assistant',
      'credential entry': 'Remove this credential entry',
      'model connection': 'Add model connection',
      'Connect through': 'Connect through',
      'Pair a device': 'Pair a device',
      'Workspace view': 'Choose a workspace view',
      'Starter layout': 'Starter layout',
      'Files and connections': 'Files and connections',
      'Conversation stats': 'Conversation stats',
      'Chat inventory': 'Chat inventory',
      'Chat settings': 'Chat settings',
      'Fork from here': 'Fork from here…',
      'Branch from this answer': 'Branch from this answer',
      'New chat from this message': 'New chat from this message',
      'Rewind conversation': 'Rewind conversation to here?',
      'Restore workspace': 'Restore workspace?',
      'Reset agent context': 'Reset agent context',
      'Settle conversation': 'Settle conversation',
      'Dismiss from inbox': 'Dismiss from inbox',
      'Hide from inbox': 'Hide from inbox',
      'Restore to inbox': 'Restore to inbox',
      'Discard unsent draft': 'Discard unsent draft',
      Unsnooze: 'Unsnooze',
      'Show inbox': 'Show inbox',
      'Show chats': 'Show chats',
      'Inbox chats': 'Inbox chats',
    };
    // Plural and lowercase forms of the same terms.
    const VARIANTS: Record<string, string> = {
      'AI app': 'connect your ai apps',
      'device hub': 'Device Hubs nearby',
      'Station owner': 'station owners can change this',
      'built-in assistant': 'Built-in Assistants',
      'default assistant': 'two default assistants',
      'credential entry': 'Credential entries',
      'model connection': 'Open model connections',
      'Connect through': 'connect through a proxy',
      'Pair a device': 'choose Pair phone',
      'Workspace view': 'Workspace views',
      'Starter layout': 'starter layouts',
      'Files and connections': 'Files & connections',
      'Conversation stats': 'Loading conversation statistics',
      'Chat inventory': 'CHAT INVENTORY',
      'Chat settings': 'More chat settings',
      'Fork from here': 'fork from here',
      'Branch from this answer': 'branch from this answer',
      'New chat from this message': 'new chat from this message',
      'Rewind conversation': 'rewind conversation',
      'Restore workspace': 'restore workspace',
      'Reset agent context': 'reset agent context',
      'Settle conversation': 'settle conversations',
      'Dismiss from inbox': 'dismiss from the inbox',
      'Hide from inbox': 'hide from the inbox',
      'Restore to inbox': 'restore to the inbox',
      'Discard unsent draft': 'discard unsent drafts',
      Unsnooze: 'Unsnoozing…',
      'Show inbox': 'Hide inbox, 2 need you',
      'Show chats': 'Hide chats, 2 working',
      'Inbox chats': 'inbox chats',
    };
    /** Retired by a slice that removed every use, so enforced now. */
    const ACTIVE = [
      'Settle conversation',
      'Dismiss from inbox',
      'Hide from inbox',
      'Restore to inbox',
      'Discard unsent draft',
      'Unsnooze',
      'Show inbox',
      'Show chats',
      'Inbox chats',
    ];

    it('pins the retired terms, independently of the script', () => {
      expect(RETIRED_USER_TERMS.map(({ term }) => term)).toEqual(
        Object.keys(VIOLATIONS),
      );
    });

    it('keeps every other entry pending until the copy lanes merge', () => {
      // Flip-on is deleting `pending`; when that happens this expectation
      // changes with it, deliberately.
      expect(ACTIVE_RETIRED_USER_TERMS.map(({ term }) => term)).toEqual(ACTIVE);
      for (const [term, text] of Object.entries(VIOLATIONS)) {
        expect(
          scanFileContent('Pending.tsx', `<p>${text}</p>`),
          text,
        ).toHaveLength(ACTIVE.includes(term) ? 1 : 0);
      }
    });

    it('each pending rule catches its term on every user-facing surface once enabled', () => {
      for (const entry of RETIRED_USER_TERMS) {
        const text = VIOLATIONS[entry.term];
        const enabled = [{ ...entry, pending: false }];
        for (const source of [
          `export const V = () => <section><p>${text}</p></section>;`,
          `export const V = () => <Row title="${text}" />;`,
          `export const V = () => <Row title={'${text}'} />;`,
          `export const STEPS = [{ label: '${text}' }];`,
          `export const V = () => <section><p>${VARIANTS[entry.term]}</p></section>;`,
        ]) {
          expect(
            scanFileContent('Enabled.tsx', source, enabled),
            `${entry.term}: ${source}`,
          ).toHaveLength(1);
        }
        const registry = scanCopySourceContent(
          'packages/contracts/src/settings-registry.ts',
          `defineSetting({ label: 'x', help: '${text}', description: 'd', placeholder: 'p' });`,
          'defineSetting(',
          enabled,
        );
        expect(registry.findings, entry.term).toHaveLength(1);
        const gated = runGate({
          files: ['Enabled.tsx'],
          readFile: () => `export const V = () => <p>${text}</p>;`,
          allowlist: [],
          retiredTerms: enabled,
        });
        expect(gated.unallowlisted, entry.term).toHaveLength(1);
      }
    });

    it('catches every pairing form the design retires once enabled', () => {
      const pair = RETIRED_USER_TERMS.find(
        ({ term }) => term === 'Pair a device',
      );
      if (!pair) throw new Error('Pair a device entry missing');
      const enabled = [{ ...pair, pending: false }];
      for (const text of [
        'Pair a device',
        'Open Connections to pair this device again',
        'Pair another device',
        'Pair your phone',
        'Pair phone',
        'Pair devices',
      ]) {
        expect(
          scanFileContent('Pair.tsx', `<p>${text}</p>`, enabled),
          text,
        ).toHaveLength(1);
      }
    });

    it('does not flag the replacement vocabulary or the terms in comments and identifiers', () => {
      const all = RETIRED_USER_TERMS.map((entry) => ({
        ...entry,
        pending: false,
      }));
      for (const source of [
        '<p>Pick an engine</p>',
        '<p>Open the device helper</p>',
        '<p>Ask the Station operator</p>',
        "<p>Use Station's engine</p>",
        '<p>Remove this account</p>',
        '<p>Email the app owner</p>',
        '// The device hub predates the device helper.\nconst x = <p>Saved</p>;',
        'const deviceHub = useDeviceHub(); const x = <p>Saved</p>;',
        '<div className="ai-app device-hub" />',
        '<p>Mail apps and AI applications</p>',
        // The first-release replacements and nearby legitimate copy.
        '<p>Add a provider</p>',
        '<p>Runs through: Claude subscription</p>',
        '<p>Connect a device</p>',
        '<p>Repair a device</p>',
        '<p>Add a view</p>',
        '<p>Files</p>',
        '<p>Usage</p>',
        '<p>Work</p>',
        '<p>Setup</p>',
        '<p>More in Settings, Chat and voice</p>',
        '<p>New chat from here</p>',
        '<p>Rewind chat to here</p>',
        '<p>Restore files to here</p>',
        '<p>Start fresh context</p>',
        '<p>Mark done</p>',
        '<p>Reopen</p>',
        '<p>Wake now</p>',
        '<p>Discard draft</p>',
        'const unsnoozeAttention = useUnsnoozeAttentionItemMutation(); const x = <p>Saved</p>;',
      ]) {
        expect(scanFileContent('Clean.tsx', source, all), source).toEqual([]);
      }
    });
  });
});
