import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { toPassthroughToolDef } from '../adapters/agent-tool-server-mapping.js';

const adaptersDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'adapters',
);

function readAdapterSource(fileName: string): string {
  return readFileSync(join(adaptersDir, fileName), 'utf8');
}

describe('toPassthroughToolDef (shared ResolvedAgentToolServer → ToolDef mapping)', () => {
  test('rebuilds a ToolDef from a ResolvedAgentToolServer, always kind mcp, never an env field', () => {
    expect(
      toPassthroughToolDef({
        id: 'weather',
        displayName: 'Weather',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'weather-mcp'],
        endpoint: undefined,
      }),
    ).toEqual({
      id: 'weather',
      kind: 'mcp',
      displayName: 'Weather',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'weather-mcp'],
      endpoint: undefined,
    });
  });

  // Station#1157 DRY requirement: the mapping used to be a private
  // duplicate-risk function inside acp-adapter.ts (#895 wave A). It now
  // lives here, and BOTH the ACP and Claude adapters import this exact
  // module rather than re-declaring their own copy — this is a static,
  // source-level regression guard for that requirement (a behavioral test
  // alone can't tell "imports the shared helper" apart from "coincidentally
  // produces the same output from a second, drifted copy").
  test('station#1157 DRY: acp-adapter.ts and claude-mcp-passthrough.ts both import toPassthroughToolDef from this module, and neither re-declares it', () => {
    const acpAdapterSource = readAdapterSource('acp-adapter.ts');
    const claudeMcpPassthroughSource = readAdapterSource(
      'claude-mcp-passthrough.ts',
    );

    for (const source of [acpAdapterSource, claudeMcpPassthroughSource]) {
      expect(source).toMatch(
        /import\s*\{\s*toPassthroughToolDef\s*\}\s*from\s*'\.\/agent-tool-server-mapping\.js';/,
      );
      // No local re-declaration of the function this module owns.
      expect(source).not.toMatch(/function\s+toPassthroughToolDef\s*\(/);
    }
  });
});
