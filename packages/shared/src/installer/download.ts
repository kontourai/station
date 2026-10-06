/**
 * Byte-capped downloads for the Windows installer core (#2675 slice W).
 *
 * install.sh bounds a download with curl's `--max-filesize`, which older curl
 * enforces only on a declared Content-Length. Here the body is counted as it
 * streams: a declared length over the cap is refused before any byte is
 * read, and the transfer is aborted at the first byte past the cap, so a
 * chunked response cannot exceed it either. The caller still checks the exact
 * size and digest afterwards.
 *
 * `file:` and `http:` URLs are accepted only under the installer's test-only
 * flag; everything a real install fetches is HTTPS.
 */
import { closeSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class DownloadTooLarge extends Error {}

export type DownloadOptions = {
  /** The largest body accepted, in bytes. */
  maxBytes: number;
  /** http: and file: URLs are allowed (STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1). */
  allowTestUrls: boolean;
  /** Abort when no byte arrives for this long. */
  idleTimeoutMs?: number;
  attempts?: number;
};

function tooLarge(url: string, maxBytes: number): DownloadTooLarge {
  return new DownloadTooLarge(`${url} is larger than ${maxBytes} bytes`);
}

function copyFileCapped(
  source: string,
  destination: string,
  url: string,
  maxBytes: number,
): void {
  if (statSync(source).size > maxBytes) throw tooLarge(url, maxBytes);
  const input = openSync(source, 'r');
  const output = openSync(destination, 'wx', 0o600);
  try {
    const buffer = Buffer.alloc(1 << 20);
    let total = 0;
    for (;;) {
      const read = readSync(input, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw tooLarge(url, maxBytes);
      writeSync(output, buffer, 0, read);
    }
  } finally {
    closeSync(input);
    closeSync(output);
  }
}

class RetryableDownloadError extends Error {}

async function fetchCapped(
  url: string,
  destination: string,
  options: DownloadOptions,
): Promise<void> {
  const controller = new AbortController();
  const idle = options.idleTimeoutMs ?? 60_000;
  let timer = setTimeout(() => controller.abort(), idle);
  const output = openSync(destination, 'w', 0o600);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (error) {
      throw new RetryableDownloadError(
        `could not fetch ${url}: ${(error as Error).message}`,
      );
    }
    // A redirect must not leave HTTPS (GitHub release assets redirect to
    // their object store, which is HTTPS).
    if (
      !options.allowTestUrls &&
      new URL(response.url || url).protocol !== 'https:'
    )
      throw new Error(`${url} redirected away from HTTPS`);
    if (!response.ok) {
      const message = `${url} answered HTTP ${response.status}`;
      if (response.status >= 500) throw new RetryableDownloadError(message);
      throw new Error(message);
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > options.maxBytes) {
      await response.body?.cancel();
      throw tooLarge(url, options.maxBytes);
    }
    if (!response.body) throw new Error(`${url} answered with no body`);
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw new RetryableDownloadError(
          `download of ${url} failed: ${(error as Error).message}`,
        );
      }
      if (chunk.done) break;
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), idle);
      total += chunk.value.length;
      if (total > options.maxBytes) {
        controller.abort();
        throw tooLarge(url, options.maxBytes);
      }
      writeSync(output, chunk.value);
    }
  } finally {
    clearTimeout(timer);
    closeSync(output);
  }
}

/**
 * Downloads `url` into `destination` (created, mode 0600), refusing a body
 * larger than `maxBytes`. Network failures and 5xx answers are retried.
 */
export async function downloadCapped(
  url: string,
  destination: string,
  options: DownloadOptions,
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol === 'file:') {
    if (!options.allowTestUrls) throw new Error(`${url} is not an HTTPS URL`);
    copyFileCapped(fileURLToPath(parsed), destination, url, options.maxBytes);
    return;
  }
  if (
    parsed.protocol !== 'https:' &&
    !(options.allowTestUrls && parsed.protocol === 'http:')
  )
    throw new Error(`${url} is not an HTTPS URL`);
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fetchCapped(url, destination, options);
      return;
    } catch (error) {
      if (!(error instanceof RetryableDownloadError) || attempt >= attempts)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
  }
}
