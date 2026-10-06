/**
 * #3406: the helper process `attached-session-path-probe.ts` runs, so a
 * session folder on a hung mount blocks this process instead of Station's
 * main thread. Bundled beside the server (`esbuild.config.mjs`).
 */
import {
  realAttachedPathReads,
  serveAttachedPathReads,
} from './attached-session-path-probe.js';

serveAttachedPathReads(realAttachedPathReads);
