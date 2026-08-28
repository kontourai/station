import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * `:root` matches unconditionally — including when `data-theme="light"` is set —
 * and it has the same (0,1,0) specificity as `[data-theme="light"]`. So a `:root`
 * rule declared *after* the light block wins, and light silently renders the
 * default (dark) value.
 *
 * That is not hypothetical: a `:root, [data-theme="dark"]` block sat after the
 * light block and overrode ten of light's own tokens, so light mode rendered dark
 * shadows, a dark modal overlay, and dark disabled/subtle text (archive#1062). Nothing
 * caught it, because a too-heavy shadow reads as a design choice rather than a bug.
 *
 * The rule this pins: every block that includes a bare `:root` selector must be
 * declared before `[data-theme="light"]`, so light always gets the last word on
 * anything it chooses to override.
 */

const CSS_PATH = path.resolve(import.meta.dirname, '..', 'index.css');

interface Block {
  selector: string;
  line: number;
  tokens: Map<string, string>;
}

/**
 * Deliberately a line scanner rather than a real CSS parser: it needs to know
 * source *order*, which is the whole point, and index.css uses one selector list
 * per line for these blocks.
 */
function parseTopLevelBlocks(css: string): Block[] {
  const lines = css.split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    // Collect a selector list that may span lines, ending at its `{`.
    const selectorParts: string[] = [];
    let cursor = index;
    while (cursor < lines.length) {
      const text = lines[cursor].trim();
      if (text === '' || text.startsWith('/*') || text.startsWith('*')) break;
      selectorParts.push(text);
      if (text.endsWith('{')) break;
      if (!text.endsWith(',')) break;
      cursor += 1;
    }

    const joined = selectorParts.join(' ');
    if (joined.endsWith('{') && !joined.startsWith('@')) {
      const selector = joined.slice(0, -1).trim();
      const tokens = new Map<string, string>();
      let body = cursor + 1;
      while (body < lines.length && !lines[body].trim().startsWith('}')) {
        // Accumulate until the `;`: biome wraps long values across lines, and a
        // single-line regex would silently stop covering a token the moment its
        // value crossed the print width.
        let declarationText = lines[body];
        while (!declarationText.includes(';') && body + 1 < lines.length) {
          body += 1;
          if (lines[body].trim().startsWith('}')) break;
          declarationText += ` ${lines[body].trim()}`;
        }
        const declaration = /^\s*(--[\w-]+)\s*:\s*(.+?);/.exec(declarationText);
        if (declaration) {
          tokens.set(
            declaration[1],
            declaration[2].trim().replace(/\s+/g, ' '),
          );
        }
        body += 1;
      }
      if (tokens.size > 0) {
        blocks.push({ selector, line: index + 1, tokens });
      }
      index = body + 1;
      continue;
    }
    index += 1;
  }

  return blocks;
}

/**
 * `ROOT_MATCHING` deliberately also catches compound forms — `:root.is-dev-build`
 * and `:root:not(...)` — because those match an unthemed document too and win at
 * equal-or-higher specificity than `[data-theme="light"]`. The repo already has
 * three `:root.is-dev-build*` rules (index.css:28/39/43), so a token added to one
 * of those below the light block is a realistic edit, not a hypothetical.
 *
 * Descendant forms (`:root.thing`) are excluded: those target a different
 * element, not the root, so they cannot shadow a root-level token.
 *
 * `BARE_LIGHT` stays strict — it identifies *where the light block is*, and a
 * compound or descendant selector is not that block.
 */
const ROOT_MATCHING = /(^|,)\s*:root(?![\w-])(?![^,]*\s)/;
const BARE_LIGHT = /(^|,)\s*\[data-theme="light"\]\s*(,|$)/;

/**
 * Tokens known to live in a bare-`:root` block. Asserted below so the coverage
 * self-check cannot be satisfied by some unrelated `:root` rule — the earlier
 * geometry-only block at index.css:66 would otherwise make it pass vacuously
 * even if the theme blocks stopped being parsed entirely.
 */
const SENTINEL_ROOT_TOKENS = ['--shadow-lg', '--overlay-modal'];

describe('theme token cascade (#1062)', () => {
  const css = readFileSync(CSS_PATH, 'utf8');
  const blocks = parseTopLevelBlocks(css);

  test('the parser finds the theme blocks it is meant to police', () => {
    // Guards the test itself. Counting blocks is not enough — an unrelated
    // `:root` rule satisfies that while the theme blocks go unparsed (a comment
    // inside a selector list is enough to hide one). So assert the tokens that
    // must be in scope are actually in scope.
    const rootTokens = new Set(
      blocks
        .filter((b) => ROOT_MATCHING.test(b.selector))
        .flatMap((b) => [...b.tokens.keys()]),
    );
    for (const token of SENTINEL_ROOT_TOKENS) {
      expect(rootTokens, `${token} must be visible to this guard`).toContain(
        token,
      );
    }
    const lightTokens = new Set(
      blocks
        .filter((b) => BARE_LIGHT.test(b.selector))
        .flatMap((b) => [...b.tokens.keys()]),
    );
    for (const token of SENTINEL_ROOT_TOKENS) {
      expect(
        lightTokens,
        `${token} must be visible in the light block too`,
      ).toContain(token);
    }
  });

  test('no :root block is declared after [data-theme="light"] redeclaring its tokens', () => {
    const light = blocks.filter((b) => BARE_LIGHT.test(b.selector));
    expect(light.length).toBeGreaterThan(0);
    const firstLightLine = Math.min(...light.map((b) => b.line));
    const lightTokens = new Map<string, string>();
    for (const block of light) {
      for (const [name, value] of block.tokens) lightTokens.set(name, value);
    }

    const shadowed: string[] = [];
    for (const block of blocks) {
      if (block.line <= firstLightLine) continue;
      if (!ROOT_MATCHING.test(block.selector)) continue;
      for (const [name, value] of block.tokens) {
        const intended = lightTokens.get(name);
        if (intended !== undefined && intended !== value) {
          shadowed.push(
            `${name}: light declares "${intended}" but "${block.selector}" at line ${block.line} overrides it with "${value}"`,
          );
        }
      }
    }

    expect(
      shadowed,
      `Light theme would render these as dark. Move the offending block above the [data-theme="light"] block (line ${firstLightLine}) rather than reordering light, so :root keeps providing defaults for a document with no data-theme set.\n\n${shadowed.join('\n')}`,
    ).toEqual([]);
  });
});
