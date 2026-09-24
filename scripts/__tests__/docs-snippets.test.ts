/**
 * Guide code blocks marked `<!-- compile-checked: <path> -->` are verbatim
 * copies of a file `npm run typecheck:examples` compiles (#2400).
 *
 * The plugins guide showed `useSendToChat('my-plugin:assistant')` and an
 * `useInvokeAgent()` call, and neither type-checked; nothing compiled guide
 * prose. This test cannot compile the block itself, so it proves the two
 * halves the guarantee needs: the block equals the file, and the file is one
 * a `typecheck:examples` project compiles.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectFiles, typecheckSegments } from '../examples-conformance.mjs';

const ROOT = process.cwd();
const MARKER = /<!-- compile-checked: (\S+) -->\r?\n```tsx?\r?\n([\s\S]*?)```/g;

interface MarkedBlock {
  doc: string;
  file: string;
  block: string;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

function markedBlocks(): MarkedBlock[] {
  return markdownFiles(join(ROOT, 'docs')).flatMap((path) =>
    [...readFileSync(path, 'utf8').matchAll(MARKER)].map((match) => ({
      doc: path.slice(ROOT.length + 1),
      file: match[1],
      block: match[2],
    })),
  );
}

/** The part of a snippet file a guide shows: everything from its first import. */
function shownPart(source: string): string {
  const start = source.search(/^import /m);
  return start === -1 ? source : source.slice(start);
}

function typecheckedFiles(): Set<string> {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    .scripts as Record<string, string>;
  const files = new Set<string>();
  for (const { project } of typecheckSegments(scripts['typecheck:examples'])) {
    for (const file of projectFiles(resolve(ROOT, project)).files)
      files.add(file);
  }
  return files;
}

describe('compile-checked guide snippets', () => {
  const blocks = markedBlocks();

  // Pinned independently of the scan: a loop over the found blocks cannot
  // notice a marker being deleted.
  it('finds the plugins guide Agents & Chat snippet', () => {
    expect(blocks).toContainEqual(
      expect.objectContaining({
        doc: 'docs/guides/plugins.md',
        file: 'examples/docs-snippets/src/plugins-agents-and-chat.tsx',
      }),
    );
  });

  it('shows each snippet exactly as its compiled file has it', () => {
    for (const { doc, file, block } of blocks) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect(block, `${doc} block for ${file}`).toBe(shownPart(source));
    }
  });

  it('compiles every snippet file in typecheck:examples', () => {
    const compiled = typecheckedFiles();
    for (const { file } of blocks) {
      expect(compiled.has(resolve(ROOT, file)), file).toBe(true);
    }
  });
});
