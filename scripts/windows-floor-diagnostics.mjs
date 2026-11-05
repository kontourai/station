#!/usr/bin/env node
/**
 * TEMPORARY (#3994): runs the Windows floor's Vitest command with worker
 * breadcrumbs and Node fatal-error reports written under the uploaded
 * verification-output directory, and on failure records the Application
 * event log's crash entries there, so a worker that dies without a word on a
 * hosted runner leaves evidence. Exits with Vitest's status.
 *
 *   node scripts/windows-floor-diagnostics.mjs <vitest arguments...>
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(
  root,
  '.kontourai',
  'verification-output',
  'floor-diagnostics',
);
mkdirSync(out, { recursive: true });
const env = {
  ...process.env,
  STATION_FLOOR_DIAGNOSTICS: out,
  NODE_OPTIONS: [
    process.env.NODE_OPTIONS ?? '',
    '--report-on-fatalerror',
    '--report-uncaught-exception',
    `--report-directory=${join(out, 'node-reports')}`,
  ]
    .join(' ')
    .trim(),
};
const run = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules', 'vitest', 'vitest.mjs'),
    ...process.argv.slice(2),
  ],
  { cwd: root, env, stdio: 'inherit', windowsHide: true },
);
const status = run.status ?? 1;
writeFileSync(
  join(out, 'vitest-status.json'),
  JSON.stringify({
    status: run.status,
    signal: run.signal,
    error: run.error ? String(run.error) : null,
  }),
);
if (status !== 0 && process.platform === 'win32') {
  const events = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-60)} -ErrorAction SilentlyContinue | Where-Object { $_.ProviderName -in @('Application Error','Windows Error Reporting','.NET Runtime') -or $_.Message -match 'node.exe|conhost|OpenConsole' } | Select-Object -First 50 | Format-List TimeCreated,Id,ProviderName,Message | Out-String -Width 400",
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  writeFileSync(
    join(out, 'application-events.txt'),
    `${events.stdout ?? ''}\n--- stderr ---\n${events.stderr ?? ''}`,
  );
}
process.exit(status);
