import { compactTurnText } from '../../hooks/orchestration/replay/timeline';
import type { ChatMessage } from '../../types';
import type { ChildTranscriptRow } from './transcript-child-work';

/**
 * At most one per turn, and only a state the row model already carries:
 * `failed` is the durable projection's own `runtimeError` part marker on a
 * reply row; `subagent` is a standalone sub-agent row the transcript renders
 * inside the turn. A failure outranks a sub-agent.
 */
export type TranscriptTurnMarker = 'failed' | 'subagent';

/** One user turn of the live transcript, located in the full row model. */
export interface TranscriptTurnLandmark {
  /** The user row's transcript key, which the virtualizer can reveal. */
  readonly rowId: string;
  /** The user row's position among all transcript rows, mounted or not. */
  readonly rowIndex: number;
  /** One past the last row this turn owns. */
  readonly endRowIndex: number;
  readonly prompt: string;
  /** The opening of the turn's first reply, when it has one yet. */
  readonly reply?: string;
  readonly marker?: TranscriptTurnMarker;
}

const PROMPT_EXCERPT = 140;
const REPLY_EXCERPT = 160;

function textOf(message: ChatMessage): string | undefined {
  if (message.content.trim()) return message.content;
  return message.contentParts?.find(
    (part) => part.type === 'text' && part.content?.trim(),
  )?.content;
}

function rowFailed(row: ChildTranscriptRow): boolean {
  return (
    row.kind === 'message:assistant' &&
    (row.message.contentParts ?? []).some((part) => part.runtimeError === true)
  );
}

/**
 * The transcript's user turns, derived from the whole row model rather than
 * from mounted rows: a virtualized transcript mounts only the rows near the
 * reader, and every turn still needs its place on the rail.
 */
export function transcriptTurnLandmarks(
  rows: readonly ChildTranscriptRow[],
): readonly TranscriptTurnLandmark[] {
  const landmarks: TranscriptTurnLandmark[] = [];
  let open:
    | {
        rowId: string;
        rowIndex: number;
        prompt: string;
        reply?: string;
        failed: boolean;
        subagent: boolean;
      }
    | undefined;
  const close = (endRowIndex: number) => {
    if (!open) return;
    landmarks.push({
      rowId: open.rowId,
      rowIndex: open.rowIndex,
      endRowIndex,
      prompt: open.prompt,
      ...(open.reply ? { reply: open.reply } : {}),
      ...(open.failed
        ? { marker: 'failed' as const }
        : open.subagent
          ? { marker: 'subagent' as const }
          : {}),
    });
  };
  rows.forEach((row, index) => {
    if (row.kind === 'message:user') {
      close(index);
      open = {
        rowId: row.id,
        rowIndex: index,
        prompt:
          compactTurnText(textOf(row.message), PROMPT_EXCERPT) ??
          (row.message.attachments?.length ? 'Attachment' : 'Empty message'),
        failed: false,
        subagent: false,
      };
      return;
    }
    if (!open) return;
    if (row.kind === 'subagent') {
      open.subagent = true;
      return;
    }
    if (rowFailed(row)) open.failed = true;
    if (!open.reply && row.kind === 'message:assistant')
      open.reply = compactTurnText(textOf(row.message), REPLY_EXCERPT);
  });
  close(rows.length);
  return landmarks;
}

/**
 * The turn that owns row `rowIndex`: the last landmark starting at or before
 * it. Rows before the first user turn belong to the first turn.
 */
export function turnIndexForRow(
  landmarks: readonly TranscriptTurnLandmark[],
  rowIndex: number,
): number {
  let low = 0;
  let high = landmarks.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (landmarks[middle]!.rowIndex <= rowIndex) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}
