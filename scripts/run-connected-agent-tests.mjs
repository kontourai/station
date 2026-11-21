#!/usr/bin/env node
import { invokedDirectly } from './lib/module-entry.mjs';
import { runFocusedTests } from './run-focused-tests.mjs';

// Vitest can reorder files within an invocation. Give the projection its own
// invocation so it completes before the rest of the suite begins.
const CONNECTED_AGENT_TESTS = Object.freeze([
  'src-server/services/orchestration/__tests__/event-store-batched-projection.large.test.ts',
  'src-server/providers/llm/__tests__/bedrock-adapter.test.ts',
  'src-server/providers/__tests__/claude-adapter.test.ts',
  'src-server/providers/__tests__/codex-adapter.test.ts',
  'src-server/services/orchestration/__tests__/orchestration-service.test.ts',
  'src-server/services/orchestration/__tests__/event-store.test.ts',
  'src-server/routes/orchestration/__tests__/orchestration.routes.test.ts',
]);

export async function runConnectedAgentTests(options = {}) {
  let exitCode = 0;
  for (const files of [
    CONNECTED_AGENT_TESTS.slice(0, 1),
    CONNECTED_AGENT_TESTS.slice(1),
  ]) {
    const result = await runFocusedTests(files, {
      ...options,
      testTimeoutMs: 10_000,
      reportProgress: true,
    });
    exitCode ||= result;
  }
  return exitCode;
}

if (invokedDirectly(import.meta.url)) {
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
