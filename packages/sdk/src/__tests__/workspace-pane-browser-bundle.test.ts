import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { describe, expect, test } from 'vitest';

describe('Workspace Pane portable contract bundle', () => {
  test('bundles the opt-in SDK entry for a browser without Node built-ins', async () => {
    const result = await esbuild.build({
      bundle: true,
      entryPoints: [
        fileURLToPath(new URL('../workspace-pane.ts', import.meta.url)),
      ],
      format: 'esm',
      logLevel: 'silent',
      platform: 'browser',
      write: false,
    });

    expect(result.outputFiles).toHaveLength(1);
    expect(result.outputFiles[0]?.text).not.toContain('node:util');
    expect(result.outputFiles[0]?.text).toContain(
      'parseWorkspaceCompositionSpec',
    );
  });
});
