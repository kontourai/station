import type { PullRequestReviewGuideStop } from '@kontourai/station-contracts/pull-request-review-guide';
import { z } from 'zod';
import { ReviewGuideError } from './pull-request-review-guide-errors.js';

const text = z.string().max(4000);
const path = z.string().min(1).max(1024);
const line = z.number().int().positive().max(10_000_000);
export const guideOutputSchema = z
  .object({
    stops: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(160),
            summary: text,
            attention: z
              .object({
                kind: z.enum([
                  'tradeoff',
                  'contract',
                  'product',
                  'risk',
                  'accessibility',
                ]),
                note: text,
              })
              .strict()
              .nullable(),
            excerpts: z
              .array(
                z
                  .object({
                    path,
                    side: z.enum(['new', 'old']),
                    start: line.describe('Inclusive first line, 1–10000000.'),
                    end: line.describe(
                      'Inclusive last line: start <= end <= start + 24. An excerpt must contain at most 25 lines.',
                    ),
                    caption: z.string().max(500),
                  })
                  .strict()
                  .refine(
                    (excerpt) => excerpt.end - excerpt.start < 25,
                    'An excerpt exceeded 25 lines.',
                  )
                  .describe(
                    'At most 25 inclusive lines wholly inside one diff hunk.',
                  ),
              )
              .max(6),
            files: z
              .array(
                z
                  .object({ path, note: z.string().max(500).optional() })
                  .strict(),
              )
              .max(500),
            notes: z
              .array(
                z
                  .object({
                    path,
                    line,
                    title: z.string().min(1).max(160),
                    body: text,
                  })
                  .strict(),
              )
              .max(3),
            questions: z.array(z.string().min(1).max(500)).max(2),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

/** AI SDK validation errors retain the Zod issue behind their cause chain. */
export function isGuideExcerptLimitError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (
      current instanceof z.ZodError &&
      current.issues.some(
        (issue) =>
          issue.code === 'custom' &&
          issue.message === 'An excerpt exceeded 25 lines.',
      )
    )
      return true;
    current = current.cause;
  }
  return false;
}

export interface GuideChange {
  files: string[];
  hunks: Map<string, { side: 'new' | 'old'; start: number; end: number }[]>;
  lines: Map<string, { new: Map<number, string>; old: Map<number, string> }>;
}

/** Parse hunk bodies, not just declared ranges: missing/truncated lines cannot anchor excerpts. */
export function readGuideChange(files: string[], patch: string): GuideChange {
  const lines: GuideChange['lines'] = new Map();
  const hunks: GuideChange['hunks'] = new Map();
  let currentPath: string | null = null;
  let oldPath: string | null = null;
  let current: ReturnType<GuideChange['lines']['get']>;
  let old = 0;
  let next = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inHunks = false;
  const decode = (value: string, prefix: string) => {
    // Git quotes unusual paths as C strings; JSON handles its common escapes.
    // Octal-quoted names remain file-only rather than guessing an anchor.
    let name = value;
    if (name.startsWith('"')) {
      try {
        name = JSON.parse(name);
      } catch {
        return null;
      }
    }
    return name.startsWith(prefix)
      ? name.slice(prefix.length).split('\t')[0]!
      : null;
  };
  for (const row of patch.split('\n')) {
    if (row.startsWith('diff --git ')) {
      currentPath = null;
      current = undefined;
      oldPath = null;
      inHunks = false;
      oldLeft = 0;
      newLeft = 0;
      continue;
    }
    if (!inHunks && row.startsWith('--- ')) {
      oldPath = decode(row.slice(4), 'a/');
      continue;
    }
    if (!inHunks && row.startsWith('+++ ')) {
      const name =
        decode(row.slice(4), 'b/') ??
        (row.slice(4) === '/dev/null' ? oldPath : null);
      if (name && files.includes(name)) {
        current = { new: new Map(), old: new Map() };
        lines.set(name, current);
        currentPath = name;
        hunks.set(name, []);
      }
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (hunk) {
      inHunks = true;
      old = Number(hunk[1]);
      next = Number(hunk[3]);
      oldLeft = Number(hunk[2] ?? 1);
      newLeft = Number(hunk[4] ?? 1);
      if (currentPath) {
        if (oldLeft)
          hunks
            .get(currentPath)!
            .push({ side: 'old', start: old, end: old + oldLeft - 1 });
        if (newLeft)
          hunks
            .get(currentPath)!
            .push({ side: 'new', start: next, end: next + newLeft - 1 });
      }
      continue;
    }
    if (!current || !inHunks) continue;
    if ((row.startsWith(' ') || row.startsWith('-')) && oldLeft > 0) {
      current.old.set(old++, row.slice(1));
      oldLeft--;
    }
    if ((row.startsWith(' ') || row.startsWith('+')) && newLeft > 0) {
      current.new.set(next++, row.slice(1));
      newLeft--;
    }
  }
  return { files, lines, hunks };
}

/** Invalid model anchors fail the run. Coverage is completed with an honest file-only final stop. */
export function normalizeReviewGuide(
  raw: unknown,
  change: GuideChange,
): PullRequestReviewGuideStop[] {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 128 * 1024)
    throw Error('Guide output exceeds the size limit.');
  const parsed = guideOutputSchema.safeParse(raw);
  if (!parsed.success) {
    if (isGuideExcerptLimitError(parsed.error))
      throw new ReviewGuideError('excerpt-too-long');
    throw parsed.error;
  }
  const { stops } = parsed.data;
  const changed = new Set(change.files);
  const placed = new Set<string>();
  for (const stop of stops) {
    for (const file of stop.files) {
      if (!changed.has(file.path))
        throw Error(`Guide names an unchanged file: ${file.path}`);
      placed.add(file.path);
    }
    for (const excerpt of stop.excerpts) {
      const mapped = change.lines.get(excerpt.path)?.[excerpt.side];
      if (
        !changed.has(excerpt.path) ||
        excerpt.end < excerpt.start ||
        excerpt.end - excerpt.start >= 25 ||
        !mapped ||
        !change.hunks
          .get(excerpt.path)
          ?.some(
            (hunk) =>
              hunk.side === excerpt.side &&
              hunk.start <= excerpt.start &&
              hunk.end >= excerpt.end,
          )
      )
        throw Error('Invalid guide excerpt range.');
      for (let n = excerpt.start; n <= excerpt.end; n++) {
        if (!mapped.has(n)) throw Error('Guide excerpt is outside the diff.');
      }
      placed.add(excerpt.path);
    }
    for (const note of stop.notes) {
      if (
        !stop.excerpts.some(
          (e) =>
            e.path === note.path && note.line >= e.start && note.line <= e.end,
        )
      )
        throw Error('Guide note is outside its stop excerpts.');
    }
  }
  const missing = change.files.filter((file) => !placed.has(file));
  if (missing.length)
    stops.push({
      title: 'Other changed files',
      summary:
        'These files were not explained by the generated tour. Review them in the diff.',
      attention: null,
      excerpts: [],
      files: missing.map((path) => ({ path })),
      notes: [],
      questions: [],
    });
  return stops;
}
