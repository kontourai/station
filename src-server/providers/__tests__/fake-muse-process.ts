import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/**
 * Structural stand-in for one `muse exec --json` child.
 *
 * Deliberately NOT a real spawn and deliberately not typed against
 * `node:child_process`: a direct import of that module here would require an
 * explicit process-heavy classification in `scripts/vitest-resource-manifest.mjs`,
 * and this suite has no reason to start a process at all.
 */
export class FakeMuseProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | number> = [];

  constructor() {
    super();
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    this.exit(null);
    return true;
  }

  /** Emit the child's exit exactly as the real per-turn process would. */
  exit(code: number | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 0;
    this.emit('exit', code);
  }
}
