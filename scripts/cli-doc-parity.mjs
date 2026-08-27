#!/usr/bin/env node
// Every CLI help topic must have a `### `-level heading naming its verb in
// docs/reference/cli.md, and every verb-shaped heading must name a real
// topic. Before this gate, the `conversation` verb was entirely absent from
// the reference and `review`/`version` had no headings — and nothing could
// notice, because no check read cli.md against the CLI at all.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function helpTopics(
  source = readFileSync(resolve(repoRoot, 'packages/cli/src/help.ts'), 'utf8'),
) {
  // Same key matcher as scripts/public-doc-contract-examples.mjs: hyphenated
  // command names are quoted object keys in TypeScript.
  return [
    ...source.matchAll(/^ {2}(?:(['"])([a-z][a-z-]*)\1|([a-z][a-z-]*)): \{/gm),
  ].map((match) => match[2] ?? match[3]);
}

export function documentedVerbs(
  doc = readFileSync(resolve(repoRoot, 'docs/reference/cli.md'), 'utf8'),
) {
  // A heading documents a verb by naming it in backticks: `### \`config\``,
  // `### \`stations\`, \`target\`, and \`setup\``. Prose headings without
  // backticked single-word tokens document nothing and constrain nothing.
  const documented = new Set();
  const verbHeadings = [];
  for (const line of doc.split('\n')) {
    if (!line.startsWith('### ')) continue;
    const tokens = [...line.matchAll(/`([a-z][a-z-]*)(?:[ `])/g)].map(
      (match) => match[1],
    );
    for (const token of tokens) documented.add(token);
    // Verb-shaped heading: starts with a backticked word immediately after
    // '### '. Only these are held to exist in the registry (a stale section
    // for a deleted verb should fail, prose headings should not).
    const lead = line.match(/^### `([a-z][a-z-]*)`/);
    if (lead) verbHeadings.push(lead[1]);
  }
  return { documented, verbHeadings };
}

export function evaluateParity({ topics, documented, verbHeadings }) {
  const topicSet = new Set(topics);
  return {
    undocumented: topics.filter((topic) => !documented.has(topic)),
    stale: verbHeadings.filter((verb) => !topicSet.has(verb)),
  };
}

export function main() {
  const topics = helpTopics();
  const { documented, verbHeadings } = documentedVerbs();
  const { undocumented, stale } = evaluateParity({
    topics,
    documented,
    verbHeadings,
  });
  if (undocumented.length === 0 && stale.length === 0) {
    console.log(
      `CLI doc parity passed: ${topics.length} help topics all documented in docs/reference/cli.md.`,
    );
    return 0;
  }
  if (undocumented.length > 0) {
    console.error(
      `FAIL: CLI help topics with no \`### \` heading in docs/reference/cli.md:\n${undocumented
        .map((topic) => `- ${topic}`)
        .join('\n')}`,
    );
  }
  if (stale.length > 0) {
    console.error(
      `FAIL: verb-shaped headings in docs/reference/cli.md naming no help topic (deleted verb? stale section?):\n${stale
        .map((verb) => `- ${verb}`)
        .join('\n')}`,
    );
  }
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = main();
