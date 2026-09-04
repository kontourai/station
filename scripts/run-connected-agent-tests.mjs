#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFocusedTests } from './run-focused-tests.mjs';

// Same behavioral coverage and original 10s bound as the prior macro. The
// high-cardinality EventStore case runs first in its own process-exclusive test file
// so earlier work in the 190-case general EventStore file cannot spend its
// lifecycle, so earlier work cannot spend its product-law budget.
// EventStore is PROCESS_EXCLUSIVE in the resource manifest. The focused owner
// supplies one worker/no file parallelism; do not recreate a scheduler here.
const CONNECTED_AGENT_TESTS = Object.freeze([
  'src-server/services/orchestration/__tests__/event-store-batched-projection.large.test.ts',
  'src-server/providers/llm/__tests__/bedrock-adapter.test.ts',
  'src-server/providers/__tests__/claude-adapter.test.ts',
  'src-server/providers/__tests__/codex-adapter.test.ts',
  'src-server/services/orchestration/__tests__/orchestration-service.test.ts',
  'src-server/services/orchestration/__tests__/event-store.test.ts',
  'src-server/routes/orchestration/__tests__/orchestration.routes.test.ts',
]);

export function runConnectedAgentTests(options = {}) {
  return runFocusedTests(CONNECTED_AGENT_TESTS, {
    ...options,
    testTimeoutMs: 10_000,
  });
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2)
      throw new Error('Connected-agent macro accepts no CLI overrides');
    process.exitCode = await runConnectedAgentTests();
  } catch (error) {
    process.stderr.write(
      `[test:connected-agents] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
