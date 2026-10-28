import { describe, expect, it } from 'vitest';
import {
  compareUiCopy,
  countSentences,
  inspectUiCopy,
  LONG_COPY_CAP,
  MAX_SENTENCES,
} from '../ui-copy-length.mjs';

// A realistic over-cap description: four facts in one paragraph.
const VERBOSE =
  'Removing a permission stops new use of it right away. Station drains running module work and retires registered providers. ' +
  'The result says when cleanup completed. Granting it again starts fresh.';
const kinds = (file: string, source: string) =>
  inspectUiCopy(file, source).map(({ kind, key }) => `${kind}:${key}`);

describe('UI copy length policy', () => {
  it('pins the cap and sentence limit the baseline was generated against', () => {
    expect(LONG_COPY_CAP).toBe(140);
    expect(MAX_SENTENCES).toBe(2);
    expect(VERBOSE.length).toBeGreaterThan(LONG_COPY_CAP);
  });

  it('flags long and multi-sentence JSX text, joining inline children and literal expressions', () => {
    const source = `export function Panel() {
  return (
    <section>
      <p className="hint">
        Removing a permission stops new use of it right away. Station drains
        running module work and <strong>retires registered providers</strong>.
        {' '}The result says when cleanup completed. Granting it again starts fresh.
      </p>
    </section>
  );
}`;
    expect(kinds('src-ui/src/Panel.tsx', source)).toEqual([
      'long-copy:text:p',
      'multi-sentence:text:p',
    ]);
    // The inline <strong> is part of the paragraph, not a second finding.
    expect(inspectUiCopy('src-ui/src/Panel.tsx', source)[0]?.text).toContain(
      'work and retires registered providers. The result',
    );
  });

  it('flags copy-bearing attributes, each conditional branch and copy-named properties', () => {
    expect(
      kinds(
        'src-ui/src/Settings.tsx',
        `<SettingsRow label="Proxy" description={\`${VERBOSE}\`} />`,
      ),
    ).toEqual([
      'long-copy:attr:description',
      'multi-sentence:attr:description',
    ]);
    expect(
      kinds(
        'src-ui/src/Confirm.tsx',
        `<ConfirmModal message={busy ? 'Deleting.' : '${VERBOSE}'} />`,
      ),
    ).toEqual(['long-copy:attr:message', 'multi-sentence:attr:message']);
    expect(
      kinds(
        'src-ui/src/utils/errors.ts',
        `export const COPY = { network: { title: 'Disconnected', body: '${VERBOSE}' } };`,
      ),
    ).toEqual(['long-copy:prop:body', 'multi-sentence:prop:body']);
    // Only the literal parts of a template count toward the length.
    expect(
      kinds(
        'src-ui/src/Row.tsx',
        `<Row hint={\`Uses \${name}. Saved \${when}. Applies on next launch.\`} />`,
      ),
    ).toEqual(['multi-sentence:attr:hint']);
  });

  it('flags long literals outside JSX by where they are used, never by line', () => {
    const both = (key: string) => [`long-copy:${key}`, `multi-sentence:${key}`];
    for (const [source, key] of [
      [`const msg = '${VERBOSE}';`, 'literal:const'],
      [`const msg = ok ? 'Saved.' : \`${VERBOSE}\`;`, 'literal:const'],
      [`function why() { return '${VERBOSE}'; }`, 'literal:return'],
      [`const why = () => '${VERBOSE}';`, 'literal:return'],
      [`toast.error('${VERBOSE}');`, 'literal:call:toast.error'],
      [`setError(failed ? '${VERBOSE}' : null);`, 'literal:call:setError'],
      // A lookup table keyed by quoted reasons.
      [
        `const DETAIL: Record<Reason, string> = { 'share-expired': '${VERBOSE}' };`,
        'literal:prop:share-expired',
      ],
      [`<Notice reason="${VERBOSE}" />`, 'literal:attr:reason'],
      [`<Banner error="${VERBOSE}" />`, 'attr:error'],
      [`<Chip text={\`${VERBOSE}\`} />`, 'attr:text'],
      [`const steps = [{ text: '${VERBOSE}' }];`, 'prop:text'],
      [`message = '${VERBOSE}';`, 'literal:assign'],
    ] as const) {
      expect(kinds('src-ui/src/Lit.tsx', source), source).toEqual(both(key));
    }
  });

  it('counts a literal once, under the copy rule that already measured it', () => {
    expect(kinds('src-ui/src/Once.tsx', `<p>{'${VERBOSE}'}</p>`)).toEqual([
      'long-copy:text:p',
      'multi-sentence:text:p',
    ]);
    expect(
      kinds(
        'src-ui/src/Once.tsx',
        `<Row description={busy ? 'Saving.' : '${VERBOSE}'} />`,
      ),
    ).toEqual([
      'long-copy:attr:description',
      'multi-sentence:attr:description',
    ]);
  });

  it('ignores literals that are not copy: logs, errors, imports, styling, markup, types and comparisons', () => {
    for (const source of [
      `console.warn('${VERBOSE}');`,
      `logger.info('${VERBOSE}');`,
      `log.debug('${VERBOSE}');`,
      `throw new TypeError(\`${VERBOSE}\`);`,
      `import thing from '${VERBOSE}';`,
      `export { thing } from '${VERBOSE}';`,
      `<div className={\`${'panel '.repeat(40)}\`} />`,
      `const cls = { className: '${'panel '.repeat(40)}' };`,
      `<div style={{ fontFamily: "'${'Mono Font, '.repeat(20)}'" }} />`,
      `<span data-hint="${VERBOSE}" />`,
      `const html = '<div style="padding: 8px; margin: 4px;">${VERBOSE}</div>';`,
      `const path = '${'M6.2 3.2A2.3 2.3 0 0 0 2.5 5a2.2 2.2 0 0 0 .7 4.2 '.repeat(4)}';`,
      `if (reason === '${VERBOSE}') go();`,
      `type Reason = '${VERBOSE}';`,
      `el.querySelector('${VERBOSE}');`,
      `const re = new RegExp('${VERBOSE}');`,
      `const req = { system: '${VERBOSE}' };`,
    ]) {
      expect(kinds('src-ui/src/Quiet.tsx', source), source).toEqual([]);
    }
  });

  it('ignores aria-labels, code, commands, identifiers, comments and short copy', () => {
    for (const source of [
      `<button aria-label="${VERBOSE}">x</button>`,
      `<p>Run <code>${VERBOSE}</code></p>`,
      `<pre>${VERBOSE}</pre>`,
      `<Row description="npm run ui-copy-length:ratchet -- --update --with-a-very-long-tail ${'x'.repeat(150)}" />`,
      `<Row title="${'https://example.com/'.padEnd(200, 'a')}" />`,
      `<div className="${'panel '.repeat(40)}" />`,
      `{/* ${VERBOSE} */}<p>Saved.</p>`,
      `// ${VERBOSE}\nconst x = <p>Saved. Synced.</p>;`,
      `<p>Pairing failed. Try again.</p>`,
      `throw new Error('${VERBOSE}');`,
    ]) {
      expect(kinds('src-ui/src/Quiet.tsx', source), source).toEqual([]);
    }
  });

  it('counts sentences without splitting on abbreviations, decimals, ellipses or stat labels', () => {
    expect(countSentences('Saved.')).toBe(1);
    expect(countSentences('Use e.g. a tag, i.e. v1.2.3, then wait…')).toBe(1);
    expect(countSentences('One. Two! Three?')).toBe(3);
    expect(
      countSentences('Queued: . Dropped: . Counts are for this process.'),
    ).toBe(1);
  });

  it('fails only on growth per file and key, and reports shrinkage separately', () => {
    const baseline = {
      'a.tsx': { 'long-copy:text:p': 2 },
      'gone.tsx': { 'multi-sentence:attr:description': 1 },
    };
    expect(
      compareUiCopy({ 'a.tsx': { 'long-copy:text:p': 2 } }, baseline),
    ).toEqual({
      added: [],
      reduced: [
        {
          file: 'gone.tsx',
          key: 'multi-sentence:attr:description',
          removed: 1,
        },
      ],
    });
    expect(
      compareUiCopy({ 'a.tsx': { 'long-copy:text:p': 1 } }, baseline).added,
    ).toEqual([]);
    expect(
      compareUiCopy(
        {
          'a.tsx': { 'long-copy:text:p': 3, 'long-copy:attr:hint': 1 },
          'new.tsx': { 'long-copy:text:p': 1 },
        },
        baseline,
      ).added,
    ).toEqual([
      { file: 'a.tsx', key: 'long-copy:text:p', added: 1 },
      { file: 'a.tsx', key: 'long-copy:attr:hint', added: 1 },
      { file: 'new.tsx', key: 'long-copy:text:p', added: 1 },
    ]);
  });

  it('refuses malformed inventories instead of treating them as an empty limit', () => {
    for (const baseline of [
      null,
      [],
      { 'a.tsx': null },
      { 'a.tsx': { k: -1 } },
      { 'a.tsx': { k: '1' } },
    ]) {
      expect(() => compareUiCopy({}, baseline as never)).toThrow();
    }
  });
});
