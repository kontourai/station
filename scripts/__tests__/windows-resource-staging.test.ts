import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
      const archiveRoot = join(root, 'node-fixture');
      const distributionName = 'node-v24.0.0-fixture';
      mkdirSync(join(archiveRoot, distributionName), { recursive: true });
      writeFileSync(
        join(archiveRoot, distributionName, 'node.exe'),
        'fixture Node binary',
      );
      writeFileSync(
        join(archiveRoot, distributionName, 'LICENSE'),
        'fixture Node license',
      );
      const archive = join(root, `${distributionName}.zip`);
      const tar = spawnSyncBounded(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'),
        ['-acf', archive, '-C', archiveRoot, distributionName],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
      );
      expect(tar.status, `${tar.stdout}\n${tar.stderr}`).toBe(0);
      const cache = join(root, 'node_modules/.cache/station-node');
      mkdirSync(cache, { recursive: true });
      copyFileSync(archive, join(cache, `${distributionName}.zip`));
      mkdirSync(join(root, 'config'));
      writeFileSync(
        join(root, 'config/portable-server-node-runtime.json'),
        JSON.stringify({
          schemaVersion: 1,
          version: '24.0.0',
          origin: 'https://nodejs.invalid/',
          distributions: {
            'win32-x64': {
              file: `${distributionName}.zip`,
              sha256: createHash('sha256')
                .update(readFileSync(archive))
                .digest('hex'),
            },
          },
        }),
      );
      const prepare = fileURLToPath(
        new URL('../prepare-desktop-rust-resources.mjs', import.meta.url),
      );
      const command = compile.run.replace(
        'node scripts/prepare-desktop-rust-resources.mjs',
        `& '${process.execPath.replaceAll("'", "''")}' '${prepare.replaceAll("'", "''")}'`,
      );
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
  if (!(Test-Path src-desktop/binaries/station-node-x86_64-pc-windows-msvc.exe -PathType Leaf)) { throw 'Missing private Node sidecar' }
  Write-Output 'configured-resources-present'
}
${command}
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
  it.skipIf(process.platform !== 'win32')(
    'requires the exact Credential Manager test to execute once and pass',
    () => {
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
      const step = workflow.jobs['windows-pr-portable'].steps.find(
        (step) =>
          step.name === 'Verify recovery against Windows Credential Manager',
      );
      if (!step?.run)
        throw new Error('Credential Manager verification step is missing');
      const root = makeTempDir('station-windows-keyring-step-');
      for (const [name, exit, result, accepted] of [
        [
          'one-pass',
          0,
          'test result: ok. 1 passed; 0 failed; 0 ignored; 597 filtered out;',
          true,
        ],
        [
          'empty-selection',
          0,
          'test result: ok. 0 passed; 0 failed; 0 ignored; 598 filtered out;',
          false,
        ],
        [
          'test-failure',
          101,
          'test result: FAILED. 0 passed; 1 failed;',
          false,
        ],
      ] as const) {
        const script = join(root, `${name}.ps1`);
        writeFileSync(
          join(root, 'cargo.cmd'),
          `@echo off
if not "%*"=="test --manifest-path src-desktop/Cargo.toml tests::profile_store_windows_finds_real_dotted_credential_history -- --exact --nocapture" exit /b 99
echo ${result}
exit /b ${exit}
`,
        );
        writeFileSync(
          script,
          `$ErrorActionPreference = 'Stop'
$env:PATH = '${root.replaceAll("'", "''")};' + $env:PATH
${step.run}
`,
        );
        const run = spawnSyncBounded(
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
        expect(run.error).toBeUndefined();
        expect(run.status === 0, `${name}: ${run.stdout}\n${run.stderr}`).toBe(
          accepted,
        );
      }
    },
  );
});
