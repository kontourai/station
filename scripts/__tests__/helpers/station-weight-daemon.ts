import { createRequire } from 'node:module';
import { execFileSyncBounded } from '../../lib/bounded-capture.mjs';

// Detached daemons the station-weight tests start have no ChildProcess handle
// in the test, so nothing there can end them if the test worker is killed.
// Each one bounds itself instead: it exits at its deadline, when its lease
// file (if any) is gone, or when its owner is gone.

const koffiPath =
  process.platform === 'darwin'
    ? createRequire(import.meta.url).resolve('koffi')
    : null;

// Darwin's public <sys/proc_info.h> PROC_PIDTBSDINFO ABI uses a 136-byte
// proc_bsdinfo, ending in two uint64 fields for the process start time.
const BIRTH_SOURCE = `const darwinInfo = process.platform === 'darwin'
  ? require(${JSON.stringify(koffiPath)}).load('/usr/lib/libproc.dylib')
      .func('int proc_pidinfo(int, int, uint64_t, void *, int)')
  : null;
const birthOf = (pid) => {
  try {
    if (process.platform === 'linux') {
      const stat = require('node:fs').readFileSync('/proc/' + pid + '/stat', 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
    }
    if (!darwinInfo) return '';
    const info = Buffer.alloc(136);
    if (darwinInfo(pid, 3, 0, info, info.length) !== info.length ||
        info.readUInt32LE(12) !== pid) return '';
    return info.readBigUInt64LE(120) + ':' + info.readBigUInt64LE(128);
  } catch {
    return '';
  }
};`;

/** The birth token of `pid`, read the way a daemon reads it. */
export function birthOf(pid: number) {
  const birth = execFileSyncBounded(
    process.execPath,
    ['-e', `${BIRTH_SOURCE} process.stdout.write(birthOf(${pid}));`],
    { encoding: 'utf8', windowsHide: true },
  );
  if (!birth) throw new Error(`cannot read the birth of pid ${pid}`);
  return birth;
}

/** A daemon's owner: a pid and the birth it had when the daemon was made. */
export type DaemonOwner = { pid: number; birth: string };

/**
 * Node source for an idle daemon that exits on its own, checked every
 * 100 ms: `deadlineMs` after it started; when `lease` is given and that file
 * is gone; when `owner` no longer answers `kill(pid, 0)`; and when the
 * owner's pid has another birth, checked every `birthCheckMs`. The birth
 * check catches a reused pid without adding descendants to measured trees.
 * The owner need not be the daemon's ancestor.
 */
export function daemonSource({
  owner,
  lease,
  deadlineMs = 60_000,
  birthCheckMs = 10_000,
}: {
  owner: DaemonOwner;
  lease?: string;
  deadlineMs?: number;
  birthCheckMs?: number;
}) {
  return `const lease = ${JSON.stringify(lease ?? null)};
     const owner = ${owner.pid};
     const birth = ${JSON.stringify(owner.birth)};
     const deadline = Date.now() + ${deadlineMs};
     let nextBirthCheck = Date.now() + ${birthCheckMs};
     ${BIRTH_SOURCE}
     setInterval(() => {
       if (Date.now() >= deadline) process.exit(0);
       if (lease !== null) {
         try { require('node:fs').statSync(lease); } catch { process.exit(0); }
       }
       try { process.kill(owner, 0); } catch { process.exit(0); }
       if (Date.now() >= nextBirthCheck) {
         if (birthOf(owner) !== birth) process.exit(0);
         nextBirthCheck = Date.now() + ${birthCheckMs};
       }
     }, 100);`;
}
