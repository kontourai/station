import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `docs/glossary.md` is declared the source of truth for Station's vocabulary,
 * and says that when usage elsewhere conflicts, the usage gets fixed. A
 * glossary nobody enforces drifts, so these pin the two distinctions that are
 * easiest to blur:
 *
 *   Station — what you connect to. Countable, takes an article.
 *   device  — what you connect from. A phone, a laptop, a browser.
 *   client  — an agent app a Station runs (Claude Code, Codex, opencode).
 *
 * Bare "Station" is correct for the product itself ("Station tried to restart
 * it"). It is wrong where one host instance is meant, because it reads as a
 * brand and hides that there is more than one.
 */

const UI_SRC = join(__dirname, '..');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

/** Strip comments so the rules apply to copy, not to explanatory prose. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('Station vocabulary (docs/glossary.md)', () => {
  it('never says "to Station" where one instance is meant', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(UI_SRC)) {
      const body = withoutComments(readFileSync(file, 'utf-8'));
      // Only connection verbs. "Chat with Station" is correct — that is the
      // product, the thing you talk to. It is *connecting* to a bare Station
      // that hides the instance.
      for (const match of body.matchAll(
        /["'`][^"'`]*\b[Pp]air\w*\b[^"'`]*?\b(?:to|with) Station\b(?!'s)[^"'`]*["'`]|["'`][^"'`]*\b(?:[Cc]onnect|[Rr]econnect)\w*\b[^"'`]*?\b(?:to|with) Station\b(?!'s)[^"'`]*["'`]/g,
      )) {
        offenders.push(`${file.replace(UI_SRC, 'src-ui/src')}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('documents the three nouns so the rule has somewhere to point', () => {
    const glossary = readFileSync(
      join(UI_SRC, '..', '..', 'docs', 'glossary.md'),
      'utf-8',
    );
    expect(glossary).toContain('## Station, device, client');
    // The specific confusion worth preventing: "client" already means an
    // agent app, so a phone must not be called one.
    expect(glossary).toMatch(/Do not call a device a "client"/);
    expect(glossary).toMatch(/Do not use bare "Station" where you mean one/);
  });
});
