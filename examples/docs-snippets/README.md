# Documentation snippets

Compile-checked copies of TypeScript examples that the guides show inline. A
guide marks such a block with `<!-- compile-checked: <path> -->` on the line
before it. `scripts/__tests__/docs-snippets.test.ts` fails when the block and
the file differ, and `npm run typecheck:examples` compiles the file, so a guide
example cannot drift into code that does not type-check (#2400).

This is not a plugin. Nothing here is installed or run.

| File | Shown in |
| --- | --- |
| `src/plugins-agents-and-chat.tsx` | [Plugins guide: Agents & Chat](../../docs/guides/plugins.md#agents--chat) |
