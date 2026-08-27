/**
 * Diff review comments — inline review notes anchored to a line of a file's
 * diff. Persisted per-project (under `<workspace>/.station/diff-comments.json`)
 * and surfaced in the coding-layout DiffPanel; the Review Queue surfacing is a
 * follow-up.
 *
 * `side` mirrors `@pierre/diffs`' annotation model: a comment hangs off either
 * a deleted line (`deletions`, the "before" side) or an added/context line
 * (`additions`, the "after" side), at `lineNumber` within `filePath`.
 */

/** Which side of the diff the comment anchors to (mirrors @pierre/diffs). */
export type DiffCommentSide = 'deletions' | 'additions';

export interface DiffComment {
  id: string;
  projectId: string;
  /** File the diff belongs to, relative to the repo/workspace root. */
  filePath: string;
  side: DiffCommentSide;
  /** 1-based line number on `side`. */
  lineNumber: number;
  body: string;
  authorId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Input shape for creating a comment; server assigns id + timestamps. */
export interface DiffCommentCreateInput {
  projectId: string;
  filePath: string;
  side: DiffCommentSide;
  lineNumber: number;
  body: string;
  authorId?: string;
}

const SIDES: readonly DiffCommentSide[] = ['deletions', 'additions'];

export function isDiffCommentSide(value: unknown): value is DiffCommentSide {
  return typeof value === 'string' && SIDES.includes(value as DiffCommentSide);
}
