import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';

const makeTempDir = trackTempDirs();

describe('Windows desktop resource staging', () => {
  it.skipIf(process.platform !== 'win32')(
    'stages bundled examples and configured Windows resources before Cargo',
    () => {
      const root = makeTempDir('station-windows-resource-staging-');
      const config = JSON.parse(
        readFileSync(
          new URL('../../src-desktop/tauri.windows.conf.json', import.meta.url),
          'utf8',
        ),
      );
      // #3213 consumes this resource after the base-controlled workflow lands.
      config.bundle.resources['../dist-desktop-runtime/examples'] = 'examples';
      mkdirSync(join(root, 'src-desktop'));
      mkdirSync(join(root, 'schemas'));
      writeFileSync(
        join(root, 'src-desktop', 'tauri.windows.conf.json'),
        JSON.stringify(config),
      );
      const workflow = load(
        readFileSync(
          new URL(
            '../../.github/workflows/windows-pr-verification.yml',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as {
        jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
      };
      const compile = workflow.jobs['windows-pr-portable'].steps.find(
        (step) => step.name === 'Compile desktop Rust tests',
      );
      if (!compile?.run)
        throw new Error('Windows floor compile step is missing');
      const script = join(root, 'compile-resources.ps1');
      writeFileSync(
        script,
        `$ErrorActionPreference = 'Stop'
function cargo {
  if (($args -join ' ') -ne 'test --manifest-path src-desktop/Cargo.toml --no-run') {
    throw 'Unexpected Cargo invocation'
  }
  $config = Get-Content -LiteralPath src-desktop/tauri.windows.conf.json -Raw | ConvertFrom-Json
  foreach ($resource in $config.bundle.resources.PSObject.Properties.Name) {
    if (!(Test-Path -LiteralPath (Join-Path src-desktop $resource) -PathType Container)) {
      throw "Missing configured resource: $resource"
    }
  }
  Write-Output 'configured-resources-present'
}
${compile.run}
`,
      );
      const result = spawnSyncBounded(
        'pwsh',
        ['-NoProfile', '-NonInteractive', '-File', script],
        {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 256 * 1024,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('configured-resources-present');
    },
  );
});
