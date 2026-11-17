/**
 * Project memory, tier 0 (#5065): short markdown notes an agent or the
 * person saves in a Project, plus a generated `MEMORY.md` index, kept in the
 * Project's data directory (`<home>/projects/<slug>/memory/`), never in a
 * repository.
 *
 * Each note is one file, `notes/<id>.md`: a JSON header between `---` lines,
 * then the markdown body. The note files are the only source of truth. Every
 * read goes to disk, with no cache, so a deleted note is gone from the very
 * next Session's briefing. `MEMORY.md` is written after every change for a
 * person reading the directory; Station never reads it back.
 *
 * Audience: the Project owner only, until multiplayer Projects (#3278)
 * decide who else may read it. The routes and tools enforce that.
 */
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  PROJECT_MEMORY_FULL_CODE,
  PROJECT_MEMORY_MAX_NOTES,
  PROJECT_MEMORY_NOTE_ID_PATTERN,
  type ProjectMemoryNote,
  type ProjectMemoryNoteAuthor,
  type ProjectMemoryNoteSummary,
  type ProjectMemoryNoteWrite,
} from '@kontourai/station-contracts/project-session-context';

const NOTE_SUFFIX = '.md';
const HEADER_FENCE = '---';

/** The fixed refusal a full memory answers; routes send this, never `error.message`. */
export const PROJECT_MEMORY_FULL_MESSAGE = `This Project's memory holds ${PROJECT_MEMORY_MAX_NOTES} notes. Forget one before saving another.`;

export class ProjectMemoryLimitError extends Error {
  readonly code = PROJECT_MEMORY_FULL_CODE;
  constructor() {
    super(PROJECT_MEMORY_FULL_MESSAGE);
  }
}

function isAuthor(value: unknown): value is ProjectMemoryNoteAuthor {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    (raw.kind === 'person' || raw.kind === 'agent') &&
    typeof raw.label === 'string' &&
    (raw.sessionId === undefined || typeof raw.sessionId === 'string')
  );
}

/** Parse one note file; `undefined` for a file of any other shape. */
export function parseProjectMemoryNoteFile(
  id: string,
  content: string,
): ProjectMemoryNote | undefined {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(`${HEADER_FENCE}\n`)) return undefined;
  const end = normalized.indexOf(`\n${HEADER_FENCE}\n`, HEADER_FENCE.length);
  if (end < 0) return undefined;
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(normalized.slice(HEADER_FENCE.length + 1, end));
  } catch {
    return undefined;
  }
  if (
    !header ||
    header.id !== id ||
    typeof header.title !== 'string' ||
    typeof header.createdAt !== 'string' ||
    typeof header.updatedAt !== 'string' ||
    !isAuthor(header.createdBy) ||
    !isAuthor(header.updatedBy)
  )
    return undefined;
  return {
    id,
    title: header.title,
    body: normalized.slice(end + HEADER_FENCE.length + 2).replace(/\n$/, ''),
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
    createdBy: header.createdBy,
    updatedBy: header.updatedBy,
  };
}

function noteFile(note: ProjectMemoryNote): string {
  const { body, ...header } = note;
  return `${HEADER_FENCE}\n${JSON.stringify(header)}\n${HEADER_FENCE}\n${body}\n`;
}

function summaryOf(note: ProjectMemoryNote): ProjectMemoryNoteSummary {
  const { body: _body, ...summary } = note;
  return summary;
}

export class ProjectMemoryStore {
  /** Serializes writes per Project, so the count limit and index hold. */
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(
    private readonly projectHomeDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private memoryDir(projectSlug: string): string {
    return join(this.projectHomeDir, 'projects', projectSlug, 'memory');
  }

  private notesDir(projectSlug: string): string {
    return join(this.memoryDir(projectSlug), 'notes');
  }

  private async serialized<T>(
    projectSlug: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const prior = this.writes.get(projectSlug) ?? Promise.resolve();
    const next = prior.then(work, work);
    const settled = next.catch(() => undefined);
    this.writes.set(projectSlug, settled);
    try {
      return await next;
    } finally {
      if (this.writes.get(projectSlug) === settled)
        this.writes.delete(projectSlug);
    }
  }

  /** Every note, newest change first. Reads disk every time. */
  async listNotes(projectSlug: string): Promise<ProjectMemoryNote[]> {
    let entries: string[];
    try {
      entries = await readdir(this.notesDir(projectSlug));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const notes: ProjectMemoryNote[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(NOTE_SUFFIX)) continue;
      const id = entry.slice(0, -NOTE_SUFFIX.length);
      if (!PROJECT_MEMORY_NOTE_ID_PATTERN.test(id)) continue;
      const note = await this.getNote(projectSlug, id);
      if (note) notes.push(note);
    }
    return notes.sort((a, b) =>
      a.updatedAt === b.updatedAt
        ? a.id.localeCompare(b.id)
        : b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  async listSummaries(
    projectSlug: string,
  ): Promise<ProjectMemoryNoteSummary[]> {
    return (await this.listNotes(projectSlug)).map(summaryOf);
  }

  async getNote(
    projectSlug: string,
    id: string,
  ): Promise<ProjectMemoryNote | undefined> {
    if (!PROJECT_MEMORY_NOTE_ID_PATTERN.test(id)) return undefined;
    let content: string;
    try {
      content = await readFile(
        join(this.notesDir(projectSlug), `${id}${NOTE_SUFFIX}`),
        'utf8',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return parseProjectMemoryNoteFile(id, content);
  }

  /** Save a new note. */
  async createNote(
    projectSlug: string,
    write: ProjectMemoryNoteWrite,
    author: ProjectMemoryNoteAuthor,
  ): Promise<ProjectMemoryNote> {
    return this.serialized(projectSlug, async () => {
      const existing = await this.listNotes(projectSlug);
      if (existing.length >= PROJECT_MEMORY_MAX_NOTES)
        throw new ProjectMemoryLimitError();
      const at = this.now().toISOString();
      const note: ProjectMemoryNote = {
        id: randomUUID().slice(0, 8) + randomUUID().slice(0, 4),
        title: write.title,
        body: write.body,
        createdAt: at,
        updatedAt: at,
        createdBy: author,
        updatedBy: author,
      };
      await this.writeNote(projectSlug, note);
      await this.writeIndex(projectSlug, [note, ...existing]);
      return note;
    });
  }

  /** Change a note; `undefined` when it does not exist. */
  async updateNote(
    projectSlug: string,
    id: string,
    write: ProjectMemoryNoteWrite,
    author: ProjectMemoryNoteAuthor,
  ): Promise<ProjectMemoryNote | undefined> {
    return this.serialized(projectSlug, async () => {
      const current = await this.getNote(projectSlug, id);
      if (!current) return undefined;
      const note: ProjectMemoryNote = {
        ...current,
        title: write.title,
        body: write.body,
        updatedAt: this.now().toISOString(),
        updatedBy: author,
      };
      await this.writeNote(projectSlug, note);
      await this.writeIndex(projectSlug, await this.listNotes(projectSlug));
      return note;
    });
  }

  /** Forget a note. `false` when there was none. */
  async deleteNote(projectSlug: string, id: string): Promise<boolean> {
    if (!PROJECT_MEMORY_NOTE_ID_PATTERN.test(id)) return false;
    return this.serialized(projectSlug, async () => {
      const path = join(this.notesDir(projectSlug), `${id}${NOTE_SUFFIX}`);
      try {
        await rm(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      await this.writeIndex(projectSlug, await this.listNotes(projectSlug));
      return true;
    });
  }

  private async writeNote(
    projectSlug: string,
    note: ProjectMemoryNote,
  ): Promise<void> {
    const dir = this.notesDir(projectSlug);
    await mkdir(dir, { recursive: true });
    await writeAtomically(
      join(dir, `${note.id}${NOTE_SUFFIX}`),
      noteFile(note),
    );
  }

  /** The person-readable index; never read back by Station. */
  private async writeIndex(
    projectSlug: string,
    notes: readonly ProjectMemoryNote[],
  ): Promise<void> {
    const lines = [
      '# Project memory',
      '',
      'Background notes for Sessions in this Project. Edit them in Project settings › Memory.',
      '',
      ...notes.map((note) => `- [${note.title}](notes/${note.id}.md)`),
      '',
    ];
    await mkdir(this.memoryDir(projectSlug), { recursive: true });
    await writeAtomically(
      join(this.memoryDir(projectSlug), 'MEMORY.md'),
      lines.join('\n'),
    );
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, 'utf8');
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
