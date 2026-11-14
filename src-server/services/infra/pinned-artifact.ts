/**
 * Download, verify and vet a pinned archive. Shared by every installer that
 * fetches code Station then runs: the Browser pane's Chromium
 * (`chromium-acquisition.ts`) and managed engine installs
 * (`services/engines/managed-install.ts`).
 *
 * Trust comes from the pin the caller holds, never from the server: the
 * archive must have exactly the pinned length and SHA-256. Entry names are
 * vetted before extraction ({@link unsafeArchiveEntry}) and the extracted
 * tree, symlinks included, after it ({@link findEscapingEntry}).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

export type PinnedArtifactFailure =
  | 'download-failed'
  | 'size-mismatch'
  | 'integrity-mismatch';

export class PinnedArtifactError extends Error {
  constructor(
    readonly reason: PinnedArtifactFailure,
    message: string,
  ) {
    super(message);
    this.name = 'PinnedArtifactError';
  }
}

export const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface PinnedArtifactDownload {
  fetch: typeof fetch;
  url: string;
  /** Written as it streams; the caller removes it on failure. */
  dest: string;
  /** Exact length in bytes. */
  bytes: number;
  /** Lowercase hex SHA-256: the trust root. */
  sha256: string;
  /** Base64 MD5, checked first when given. A transport check only, never trust. */
  md5?: string;
  /** Who is being downloaded from, for messages ("Chrome for Testing"). */
  sourceName: string;
  /** Called with the running byte count after each chunk. */
  onProgress?: (receivedBytes: number) => void;
}

/**
 * The chunks of a fetch body, read through its reader. Typed by the reader
 * alone, so it holds under both the DOM and Node stream declarations; a
 * consumer that stops early cancels the body.
 */
async function* webStreamChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Stream `url` to `dest`, refusing a declared or actual length other than
 * the pin and a digest other than the pin. Redirects are refused: the pinned
 * URL is the one fetched. Returns the digests it computed.
 */
export async function downloadPinnedArtifact(
  input: PinnedArtifactDownload,
): Promise<{ sha256: string; md5: string }> {
  let response: Response;
  try {
    response = await input.fetch(input.url, { redirect: 'error' });
  } catch (error) {
    throw new PinnedArtifactError(
      'download-failed',
      `Could not reach ${input.sourceName}: ${(error as Error).message}`,
    );
  }
  if (!response.ok || !response.body) {
    throw new PinnedArtifactError(
      'download-failed',
      `${input.sourceName} answered HTTP ${response.status}.`,
    );
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0 && declared !== input.bytes) {
    throw new PinnedArtifactError(
      'size-mismatch',
      `Archive length ${declared} does not match the pinned ${input.bytes}.`,
    );
  }
  const md5 = createHash('md5');
  const sha256 = createHash('sha256');
  let received = 0;
  const pinned = input.bytes;
  async function* checked(source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      received += chunk.byteLength;
      input.onProgress?.(received);
      if (received > pinned) {
        throw new PinnedArtifactError(
          'size-mismatch',
          `Archive exceeded the pinned ${pinned} bytes.`,
        );
      }
      md5.update(chunk);
      sha256.update(chunk);
      yield chunk;
    }
  }
  // pipeline owns the write stream's lifecycle: an open or write failure
  // (missing or unwritable destination, full disk) rejects here instead of
  // surfacing as an unhandled 'error' event, and a backpressure wait cannot
  // outlive a failed stream.
  const file = createWriteStream(input.dest);
  const closed = new Promise<void>((resolve) => file.once('close', resolve));
  try {
    await pipeline(webStreamChunks(response.body), checked, file);
  } catch (error) {
    // pipeline settles once the stream is destroyed, which can be before its
    // asynchronous open has finished: wait for the descriptor to close, or
    // the file appears after the caller has emptied its staging directory.
    await closed;
    if (error instanceof PinnedArtifactError) throw error;
    throw new PinnedArtifactError(
      'download-failed',
      `The download from ${input.sourceName} stopped: ${(error as Error).message}`,
    );
  }
  await closed;
  if (received !== input.bytes) {
    throw new PinnedArtifactError(
      'size-mismatch',
      `Archive was ${received} bytes; the pin is ${input.bytes}.`,
    );
  }
  const md5Digest = md5.digest('base64');
  if (input.md5 !== undefined && md5Digest !== input.md5) {
    throw new PinnedArtifactError(
      'integrity-mismatch',
      `Archive MD5 ${md5Digest} does not match the pinned ${input.md5}.`,
    );
  }
  const digest = sha256.digest('hex');
  if (!SHA256_HEX.test(input.sha256) || digest !== input.sha256) {
    throw new PinnedArtifactError(
      'integrity-mismatch',
      `Archive SHA-256 ${digest} does not match the pinned ${input.sha256}.`,
    );
  }
  return { sha256: digest, md5: md5Digest };
}

/** Run an archive tool by argv (no shell), killing it at the deadline. */
export function runArchiveTool(
  command: string,
  args: string[],
  timeoutMs: number,
  collect?: (chunk: Buffer) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', collect ? 'pipe' : 'ignore', 'ignore'],
      windowsHide: true,
    });
    if (collect) child.stdout?.on('data', collect);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code ?? signal}`));
    });
  });
}

/**
 * Zip-slip: an entry name that is absolute, has a drive or UNC prefix, or has
 * a `..` segment could land outside the install directory. Refused before
 * extraction.
 */
export function unsafeArchiveEntry(name: string): boolean {
  if (name.includes('\0')) return true;
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return true;
  return normalized.split('/').some((segment) => segment === '..');
}

/**
 * After extraction, every entry — and every symlink's target — must resolve
 * inside the extraction root (an app bundle's own relative symlinks do).
 * Returns the first escaping path, or undefined.
 */
export function findEscapingEntry(root: string): string | undefined {
  const realRoot = realpathSync(root);
  const within = (candidate: string) => {
    const rel = relative(realRoot, candidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const stack = [realRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = resolve(dir, readlinkSync(path));
        let real: string;
        try {
          real = realpathSync(target);
        } catch {
          // A dangling link is judged by where it points.
          real = target;
        }
        if (!within(real)) return path;
        continue;
      }
      if (!within(realpathSync(path))) return path;
      if (entry.isDirectory()) stack.push(path);
    }
  }
  return undefined;
}
