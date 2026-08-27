import { describe, expect, test } from 'vitest';
import { initializeRuntimeBackgroundTasks } from '../runtime-initialize.js';

describe('production runtime initialization import', () => {
  test('loads after the MCP-compatible VoltAgent Hono initialization order', () => {
    // This is deliberately the production bootstrap import, rather than a
    // background-task-only seam: it catches the vendored Zod patch/MCP auth
    // composition failure before any runtime wiring can execute.
    expect(initializeRuntimeBackgroundTasks).toBeTypeOf('function');
  });
});
