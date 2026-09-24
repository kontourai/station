/**
 * A fake ssh child for SSH device host tests (#1973): records its argv and
 * everything written to stdin, and exits when told (with OpenSSH-style
 * stderr when a test wants a typed failure).
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SshChild } from '../ssh-device-session.js';

export class FakeSsh implements SshChild {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly events = new EventEmitter();
  stdinText = '';
  stdinBytes = Buffer.alloc(0);
  stdinEnded = false;
  killed: string[] = [];
  released = false;
  exited = false;
  constructor(readonly args: string[]) {
    this.stdin.on('data', (chunk: Buffer) => {
      this.stdinText += chunk.toString();
      this.stdinBytes = Buffer.concat([this.stdinBytes, chunk]);
    });
    this.stdin.on('finish', () => {
      this.stdinEnded = true;
    });
  }
  onExit(listener: (code: number | null, signal: string | null) => void) {
    this.events.once('exit', listener);
  }
  onError(listener: (error: Error) => void) {
    this.events.once('error', listener);
  }
  kill(signal: 'SIGTERM' | 'SIGKILL') {
    this.killed.push(signal);
    this.exit(null);
  }
  release() {
    this.released = true;
  }
  exit(code: number | null, stderr = '') {
    if (this.exited) return;
    this.exited = true;
    if (stderr) this.stderr.write(stderr);
    setImmediate(() => this.events.emit('exit', code, null));
  }
  /** The params the hub sent in its header line. */
  params(): Record<string, unknown> {
    const line = this.stdinText.split('\n')[0] ?? '';
    return (JSON.parse(line) as { p: Record<string, unknown> }).p;
  }
  isForward() {
    return this.args[0] === '-N';
  }

  /** What OpenSSH prints (DEBUG1) once it holds a forward's listener. */
  announceListening() {
    const spec = this.args[this.args.indexOf('-L') + 1] ?? '';
    const port = spec.split(':')[1];
    this.stderr.write(
      `debug1: Local forwarding listening on 127.0.0.1 port ${port}.\n`,
    );
  }

  /** Every byte written to stdin after the header line. */
  payload(): Buffer {
    const at = this.stdinBytes.indexOf(10);
    return at === -1 ? Buffer.alloc(0) : this.stdinBytes.subarray(at + 1);
  }
}
