import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const SOURCE_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * archive#3965. `NOT_VERIFIED` is Station's internal verification token: it
 * means "we did not confirm this, and will not assert it either way". It is a
 * genuine distinction and it belongs on the wire, in contracts, and in
 * comparisons. It does not belong on screen — a person reading their own board
 * or their own first task saw the literal string `NOT_VERIFIED`, which names
 * the check that did not pass instead of what happened to their work.
 *
 * The token reached the screen five separate times before anyone noticed,
 * across the Home card, the task workspace, a toast, the project tasks form,
 * and a board chip that rendered its whole state enum raw. It arrived once per
 * feature, each time as one plausible line, which is why this is a gate rather
 * than a fixed list of the five: the next feature will reach for it too.
 *
 * What is checked is deliberately narrow — a JSX **text node**, or one of the
 * attributes that renders as words. Comparing against the value
 * (`state === 'NOT_VERIFIED'`), importing it, typing with it, or keying CSS
 * off it are all untouched, because none of them is read by a person.
 */
const FORBIDDEN_ON_SCREEN = 'NOT_VERIFIED';

/** Attributes whose value a person reads. */
const RENDERED_ATTRIBUTES = [
  'title',
  'aria-label',
  'aria-description',
  'placeholder',
  'alt',
];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sourceFiles(full, found);
      continue;
    }
    if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Lines where the token sits in text a person reads. A JSX text node is
 * recognised by the token appearing OUTSIDE any quotes on that line — inside
 * quotes it is a value, a type, or a class name, and only the rendered
 * attributes above are read from there.
 */
function onScreenOccurrences(source: string): string[] {
  const offenders: string[] = [];
  for (const [index, line] of source.split('\n').entries()) {
    if (!line.includes(FORBIDDEN_ON_SCREEN)) continue;
    if (/^\s*(\*|\/\/)/.test(line)) continue;
    // An import names the token unquoted, and an object key or type member
    // writes it bare before a colon. Neither is read by anyone.
    if (/^\s*import\b/.test(line)) continue;
    const attribute = RENDERED_ATTRIBUTES.some((name) =>
      new RegExp(`${name}=\\s*["'\`][^"'\`]*${FORBIDDEN_ON_SCREEN}`).test(line),
    );
    const unquoted = line
      .replace(/'[^']*'/g, '')
      .replace(/"[^"]*"/g, '')
      .replace(/`[^`]*`/g, '')
      .replace(new RegExp(`${FORBIDDEN_ON_SCREEN}\\s*:`, 'g'), '')
      .includes(FORBIDDEN_ON_SCREEN);
    if (attribute || unquoted) offenders.push(`${index + 1}: ${line.trim()}`);
  }
  return offenders;
}

describe('plain-language policy', () => {
  test('the NOT_VERIFIED token never reaches a rendered string', () => {
    const offenders = sourceFiles(SOURCE_ROOT).flatMap((file) =>
      onScreenOccurrences(fs.readFileSync(file, 'utf8')).map(
        (line) => `${path.relative(SOURCE_ROOT, file)}:${line}`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  test('the gate reads rendered text, not values, types or class names', () => {
    // Everything a component legitimately does with the token, none of which
    // a person reads. If this list ever trips the gate, the gate is wrong.
    expect(
      onScreenOccurrences(
        [
          `const x = state === 'NOT_VERIFIED' ? a : b;`,
          `type Resolution = { state: 'current' | 'NOT_VERIFIED' };`,
          `className={\`board__state--NOT_VERIFIED\`}`,
          `import { NOT_VERIFIED } from './contract';`,
          `  NOT_VERIFIED: { label: 'Checking…' },`,
          ` * NOT_VERIFIED: explained in a docblock.`,
          `// NOT_VERIFIED in a line comment`,
        ].join('\n'),
      ),
    ).toEqual([]);

    // And the two shapes that ARE read: a JSX text node, and a title.
    const caught = onScreenOccurrences(
      ['<span>{NOT_VERIFIED}</span>', '<i title="NOT_VERIFIED yet" />'].join(
        '\n',
      ),
    );
    expect(caught).toHaveLength(2);
  });
});
