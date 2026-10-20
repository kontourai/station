/**
 * #3406 test child: the real path reads, except that a folder holding a
 * `.hang` FIFO stands in for a folder on a hung mount. Opening a FIFO for
 * reading blocks in the `open` syscall until a writer appears, which, like a
 * hung NFS `realpath`, no JavaScript timer or `terminate()` can interrupt.
 */
import { lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import {
  realAttachedPathReads,
  serveAttachedPathReads,
} from '../../attached-session-path-probe.js';

function blockIfHung(path: string): void {
  const fifo = join(path, '.hang');
  let isFifo = false;
  try {
    isFifo = lstatSync(fifo).isFIFO();
  } catch {
    return;
  }
  if (isFifo) openSync(fifo, 'r');
}

serveAttachedPathReads({
  canonical(path) {
    blockIfHung(path);
    return realAttachedPathReads.canonical(path);
  },
  async repository(path) {
    blockIfHung(path);
    return await realAttachedPathReads.repository(path);
  },
});
