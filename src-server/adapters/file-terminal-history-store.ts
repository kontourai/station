import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ITerminalHistoryStore } from '../domain/terminal-history-store.js';
import { resolveHomeDir } from '../utils/paths.js';

export class FileTerminalHistoryStore implements ITerminalHistoryStore {
  private baseDir: string;

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
      console.debug('Failed to load terminal history:', sessionId, e);
      return '';
    }
  }

  async save(sessionId: string, history: string): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.filePath(sessionId), history, 'utf8');
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await unlink(this.filePath(sessionId));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
}
