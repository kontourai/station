/**
 * YAML frontmatter + markdown body codec (store-contract.md §9). Uses `js-yaml` (a
 * standards-compliant YAML implementation) so every record file is genuinely
 * human/tool readable — not just parseable by this adapter — which is the fixture
 * proof AC1 requires ("a second adapter author... produce a conforming
 * implementation" from reading the doc alone).
 */
// Named imports, not a default import: js-yaml 5 is ESM-only and ships no
// default export. It also ships its own types, so `@types/js-yaml` must not be
// installed — the v4 types still declare a default export and would let a
// broken `import yaml from 'js-yaml'` typecheck cleanly while failing at
// runtime.
import { dump, load } from 'js-yaml';

export interface ParsedMarkdown {
  meta: Record<string, unknown>;
  body: string;
}

export function parseMarkdown(text: string): ParsedMarkdown {
  if (!text.startsWith('---\n')) {
    return { meta: {}, body: text };
  }
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) {
    return { meta: {}, body: text };
  }
  const rawYaml = text.slice(4, end);
  const body = text.slice(end + 5).replace(/^\n+/, '');
  const meta = (load(rawYaml) as Record<string, unknown> | null) ?? {};
  return { meta, body };
}

export function serializeMarkdown(
  meta: Record<string, unknown>,
  body: string,
): string {
  const frontmatter = dump(meta, { lineWidth: -1 }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${body}`;
}
