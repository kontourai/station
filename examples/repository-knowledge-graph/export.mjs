import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { invokedDirectly } from '../../scripts/lib/module-entry.mjs';
import {
  exportRepositoryKnowledge,
  GRAPH_LIMITS,
  validateKnowledgeSnapshot,
} from './graph.mjs';

export function main(args = process.argv.slice(2)) {
  let root = process.cwd();
  let output;
  for (const arg of args) {
    if (arg.startsWith('--repo=')) root = resolve(arg.slice(7));
    else if (arg.startsWith('--output=')) output = resolve(arg.slice(9));
    else throw new Error(`Unknown export option: ${arg}`);
  }
  const snapshot = validateKnowledgeSnapshot(
    exportRepositoryKnowledge({ root }),
  );
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > GRAPH_LIMITS.outputBytes)
    throw new Error('Formatted snapshot exceeds byte limit.');
  if (output) {
    writeFileSync(output, serialized, { flag: 'wx', mode: 0o600 });
    process.stdout.write(
      `${JSON.stringify({ ...snapshot.counts, inputDigest: snapshot.inputDigest })}\n`,
    );
  } else process.stdout.write(serialized);
}

if (invokedDirectly(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Export failed.');
    process.exitCode = 1;
  }
}
