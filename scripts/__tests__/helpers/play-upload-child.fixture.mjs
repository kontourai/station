#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const mode =
  process.argv[2] ?? process.env.PLAY_UPLOAD_FIXTURE_MODE ?? 'normal';
const statePath = process.argv[3] ?? process.env.PLAY_UPLOAD_FIXTURE_STATE;
const readyPath = process.env.PLAY_UPLOAD_FIXTURE_READY;

if (readyPath) writeFileSync(readyPath, String(process.pid));
process.stdout.write(`child-pid=${process.pid}\n`);

if (mode === 'normal') process.exit(0);

if (mode === 'transient-once') {
  if (!statePath) throw new Error('transient fixture requires a state path');
  const attempts = existsSync(statePath)
    ? Number(readFileSync(statePath, 'utf8'))
    : 0;
  writeFileSync(statePath, String(attempts + 1));
  if (attempts === 0) {
    process.stderr.write('The service is currently unavailable.\n');
    process.exit(1);
  }
  process.exit(0);
}

if (mode === 'hang-403')
  process.stderr.write('403 Forbidden: insufficient permissions\n');
if (mode === 'hang-policy-version')
  process.stderr.write('Version code 242802 rejected by policy\n');

const exitOnSignal = mode !== 'ignore-signals';
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    process.stdout.write(`received-${signal}\n`);
    if (exitOnSignal) process.exit(0);
  });

setInterval(() => {}, 1_000);
