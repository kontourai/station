/**
 * Structure-preserving derivatives of markdown-heavy assistant messages read
 * from local Claude project JSONL transcripts on 2026-08-29. The originals
 * contained private names, domains, email addresses, absolute paths, and
 * operational identifiers, so no message was copied verbatim. These neutral
 * fixtures retain the real structural combinations: status prose, headings,
 * lists, tables, fenced commands, blockquotes, and nested list content.
 */
export const REAL_TRANSCRIPT_DERIVED_MARKDOWN = [
  `## Verification summary

The deployment check found two independent conditions:

- The origin serves the expected application.
- The cached edge still serves the previous page.

Run the bounded verification:

\`\`\`sh
curl -sI https://example.invalid/?revision=next
node scripts/check-release.mjs
\`\`\`

The source is correct; cache invalidation remains separate.`,
  `## Environment comparison

| Surface | Runtime | Result |
|---|---:|---|
| production | 7.4 | legacy |
| staging | 8.3 | current |

What the rehearsal caught:

1. A read-only mount rejected recursive ownership changes.
2. A command-line service did not mount application content.
3. Rewrite rules needed an explicit bootstrap step.

The browser response and the diagnostic log both stayed clean.`,
  `> Review note
>
> - Keep the command inside the list item:
>
>   \`\`\`ts
>   const result = verify({ mode: 'bounded' });
>   expect(result.ok).toBe(true);
>   \`\`\`
>
> - Report skipped evidence separately from passing evidence.

That distinction prevents a partial check from becoming a release claim.`,
] as const;

export const DEFINITION_DEPENDENT_MARKDOWN = [
  'Read the [release guide][guide].\n\n[guide]: https://example.invalid/guide',
  '![Build diagram][diagram]\n\n[diagram]: https://example.invalid/diagram.png "Build diagram"',
  'This result has supporting context.[^context]\n\n[^context]: The definition-only block must remain available to the full document parse.',
] as const;

export const MARKDOWN_RENDER_CORPUS = [
  ...REAL_TRANSCRIPT_DERIVED_MARKDOWN,
  ...DEFINITION_DEPENDENT_MARKDOWN,
] as const;
