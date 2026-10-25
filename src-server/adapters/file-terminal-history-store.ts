import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v3';
import type { ITerminalHistoryStore } from '../domain/terminal-history-store.js';
import { createLogger } from '../utils/logger.js';
import { resolveHomeDir } from '../utils/paths.js';

const logger = createLogger({ name: 'terminal-history-store' });
const ownershipSchema = z
  .object({
    sessionId: z.string(),
    projectId: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');

async function boundedText(path: string, maximum: number): Promise<string> {
  const stream = createReadStream(path, { highWaterMark: 16 * 1024 });
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximum)
      throw new Error('Legacy terminal file exceeds import bound');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function notFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class FileTerminalHistoryStore implements ITerminalHistoryStore {
  private baseDir: string;
  private writes: Promise<void> = Promise.resolve();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(resolveHomeDir(), 'terminal-history');
  }

  private filePath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9]/g, '-');
    return join(this.baseDir, `${safe}.txt`);
  }

  async load(sessionId: string): Promise<string> {
    try {
      return await readFile(this.filePath(sessionId), 'utf8');
    } catch (e) {
      logger.debug('Failed to load terminal history', { sessionId, error: e });
      return '';
    }
  }

  save(sessionId: string, history: string, projectId?: string): Promise<void> {
    const task = this.writes.then(() =>
      this.saveOwned(sessionId, history, projectId),
    );
    this.writes = task.catch(() => undefined);
    return task;
  }

  /** SUNSET(#3994): only provenance-bound legacy files may migrate automatically. */
  async loadForProject(
    sessionId: string,
    projectId: string,
  ): Promise<{ state: 'owned'; history: string } | { state: 'unavailable' }> {
    let history: string;
    try {
      history = await boundedText(this.filePath(sessionId), 2 * 1024 * 1024);
    } catch (error) {
      if (notFound(error)) return { state: 'owned', history: '' };
      throw error;
    }
    const owner = await this.readOwner(sessionId);
    if (
      !owner ||
      owner.sessionId !== sessionId ||
      owner.projectId !== projectId ||
      owner.sha256 !== digest(history)
    )
      return { state: 'unavailable' };
    return { state: 'owned', history };
  }

  private async readOwner(sessionId: string) {
    try {
      return ownershipSchema.parse(
        JSON.parse(
          await boundedText(`${this.filePath(sessionId)}.owner.json`, 4096),
        ),
      );
    } catch (error) {
      if (
        notFound(error) ||
        error instanceof z.ZodError ||
        error instanceof SyntaxError
      )
        return undefined;
      throw error;
    }
  }

  private async saveOwned(
    sessionId: string,
    history: string,
    projectId?: string,
  ): Promise<void> {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const path = this.filePath(sessionId);
    let previous: string | undefined;
    try {
      previous = await boundedText(path, 2 * 1024 * 1024);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    const owner = await this.readOwner(sessionId);
    // A raw old file cannot acquire invented provenance on its next rewrite.
    const owned =
      projectId &&
      (previous === undefined ||
        (owner?.sessionId === sessionId &&
          owner.projectId === projectId &&
          owner.sha256 === digest(previous)));
    await writeFile(path, history, { encoding: 'utf8', mode: 0o600 });
    const ownershipPath = `${path}.owner.json`;
    if (owned) {
      const temporary = `${ownershipPath}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({ sessionId, projectId, sha256: digest(history) }),
        { mode: 0o600 },
      );
      await rename(temporary, ownershipPath);
    } else {
      try {
        await unlink(ownershipPath);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    }
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await unlink(this.filePath(sessionId));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
    try {
      await unlink(`${this.filePath(sessionId)}.owner.json`);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }
}
