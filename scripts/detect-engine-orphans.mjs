#!/usr/bin/env node
// station#1863 — host orphan detector.
//
// The startup sweep (src-server/services/infra/process-utils.ts) reaps engine
// children a Station RECORDED before it died. It cannot find orphans spawned
// by a Station that predates the registry, or by an engine started outside
// Station entirely. This script is the detection answer for those: it lists
// engine-like processes on the host whose parent is dead or has reparented
// them to PID 1 (init/launchd) — the signature of an orphaned detached child.
//
// It is READ-ONLY and reports candidates. It never kills anything; the
// registry sweep is the only automatic reaper, because it alone has proven
// ownership. An operator reviews this list and kills by hand.
//
// POSIX-only: `ps` parent/child relationships are the signal. On Windows the
// detached-process model differs; this script exits with a note instead of
// guessing.
//
// Usage:
//   node scripts/detect-engine-orphans.mjs                # default patterns
//   node scripts/detect-engine-orphans.mjs --pattern 'kiro-cli.*acp'
//   node scripts/detect-engine-orphans.mjs --json         # machine-readable

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';

const DEFAULT_PATTERNS = ['kiro-cli.*acp', 'codex.*--full-auto'];

function parseArgs(argv) {
  const args = { json: false, patterns: DEFAULT_PATTERNS };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--pattern') args.patterns = [argv[++i]];
    else if (a === '--help' || a === '-h') {
      args.help = true;
    } else positional.push(a);
  }
  return { args, positional };
}

function listProcesses() {
  // pid ppid command — portable across macOS/Linux `ps`.
  const out = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const rows = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space1 = trimmed.indexOf(' ');
    if (space1 < 0) continue;
    const pid = Number(trimmed.slice(0, space1));
    const rest = trimmed.slice(space1 + 1).trimStart();
    const space2 = rest.indexOf(' ');
    if (space2 < 0) continue;
    const ppid = Number(rest.slice(0, space2));
    const command = rest.slice(space2 + 1).trim();
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      rows.push({ pid, ppid, command });
    }
  }
  return rows;
}

function alive(pid) {
  if (pid === 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function matchesAny(command, patterns) {
  return patterns.some((p) => new RegExp(p).test(command));
}

function registryDir() {
  return (
    process.env.STATION_OWNED_PROCESS_REGISTRY ||
    join(tmpdir(), 'station-owned-processes')
  );
}

/** Whether this pid has a registry record (owned/managed by a live Station). */
function registryMembership(pid) {
  const file = join(registryDir(), `engine-${pid}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return 'unparseable';
  }
}

function main() {
  const { args } = parseArgs(process.argv);
  if (args.help) {
    console.error(
      'Usage: detect-engine-orphans.mjs [--pattern PATTERN] [--json]\n' +
        'Lists engine-like processes whose parent is dead or init (PID 1).',
    );
    process.exit(0);
  }
  if (process.platform === 'win32') {
    console.error(
      'detect-engine-orphans: POSIX-only (ps-based). Windows detached-process ' +
        'reparenting differs; run the registry sweep inside Station instead.',
    );
    process.exit(args.json ? 0 : 2);
  }
  const rows = listProcesses();
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const orphans = rows.filter((row) => {
    // station#1863 L2: exclude ourselves — a --pattern argument appears in this
    // script's own command line and would self-match (the self-match class
    // this repo has hit repeatedly).
    if (row.pid === process.pid) return false;
    if (!matchesAny(row.command, args.patterns)) return false;
    // Reparented to init/launchd (PID 1) => original parent died.
    if (row.ppid === 1) return true;
    const parent = byPid.get(row.ppid);
    // Parent not in the process table at all, or explicitly dead.
    if (!parent || !alive(row.ppid)) return true;
    return false;
  });

  // Enrich with start time + registry membership so an operator can tell a
  // genuine orphan from a deliberately disowned process (station#1863 L1).
  const enriched = orphans.map((o) => ({
    ...o,
    birthFingerprint: lookupProcessBirthFingerprint(o.pid),
    registry: registryMembership(o.pid) ? 'registered' : 'not-registered',
  }));

  if (args.json) {
    console.log(
      JSON.stringify(
        { platform: process.platform, orphans: enriched },
        null,
        2,
      ),
    );
  } else if (enriched.length === 0) {
    console.log('No orphaned engine processes detected.');
  } else {
    console.log(`Found ${enriched.length} orphaned engine process(es):`);
    for (const o of enriched) {
      const reg = o.registry === 'registered' ? ' [registered]' : '';
      const birth = o.birthFingerprint ? ` birth="${o.birthFingerprint}"` : '';
      console.log(
        `  pid=${o.pid} ppid=${o.ppid}${birth}${reg} cmd=${o.command}`,
      );
    }
    console.log(
      '\nTo remove one: kill -- -<pid>   (negative pid signals the whole group)\n' +
        'A [registered] process is tracked by a Station sweep; review before killing.\n' +
        'Use birth time + registry status to distinguish a genuine orphan from a\n' +
        'deliberately disowned process.',
    );
  }
  process.exit(enriched.length > 0 ? 1 : 0);
}

main();
