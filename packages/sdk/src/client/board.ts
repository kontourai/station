/**
 * station#4079 slice 1 — canonical React-free client for the board face:
 * pin/unpin/move and the board read, following the same envelope idiom as
 * `client/scheduler.ts` (a typed error class for the one refusal a caller
 * needs to distinguish, everything else a generic `BoardResponseError`).
 */
import type {
  Board,
  BoardReference,
  BoardWidgetSize,
} from '@kontourai/station-contracts/board';
import { apiErrorMessage } from './api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  StationHttpError,
} from './http';

interface BoardEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

/**
 * The board answered, and the answer was a failure. `code` mirrors the
 * route's `RouteError.code` (`src-server/routes/board.ts`) verbatim.
 */
export class BoardResponseError extends StationHttpError {
  constructor(
    status: number,
    message: string,
    readonly code: string | undefined,
  ) {
    super(status, message);
    this.name = 'BoardResponseError';
  }
}

/**
 * station#1399's pin-boundary refusal (station#4079 design: "the #1399
 * refusal applies at pin, not just at render"), surfaced as its own typed
 * class so a caller can distinguish "you tried to pin an unattestable claim"
 * from any other board failure — same typed-error-family intent as the
 * server's `UIBlockProvenanceRefusedError`.
 */
export class BoardProvenanceRefusedError extends BoardResponseError {
  constructor(message: string) {
    super(422, message, 'board_provenance_refused');
    this.name = 'BoardProvenanceRefusedError';
  }
}

async function unwrapBoardResponse<T>(response: Response): Promise<T> {
  let result: BoardEnvelope<T> | null = null;
  try {
    result = (await response.json()) as BoardEnvelope<T>;
  } catch {
    throw new BoardResponseError(
      response.status,
      `Board API error: ${response.status}`,
      undefined,
    );
  }
  if (!response.ok || !result.success) {
    const message = apiErrorMessage(
      result,
      `Board API error: ${response.status}`,
    );
    if (result.code === 'board_provenance_refused') {
      throw new BoardProvenanceRefusedError(message);
    }
    throw new BoardResponseError(response.status, message, result.code);
  }
  return result.data as T;
}

function referenceQuery(reference: BoardReference): string {
  const query = new URLSearchParams({ kind: reference.kind, id: reference.id });
  if (reference.kind === 'task') query.set('projectId', reference.projectId);
  return query.toString();
}

/** `GET /api/board?kind=...&id=...` — read one board (empty when unpinned). */
export async function getBoard(
  apiBase: string,
  reference: BoardReference,
  opts?: ClientRequestOptions,
): Promise<Board> {
  const response = await getJson(
    `${apiBase}/api/board?${referenceQuery(reference)}`,
    opts,
  );
  return unwrapBoardResponse<Board>(response);
}

export interface PinBoardWidgetInput {
  readonly reference: BoardReference;
  readonly name: string;
  readonly block: Record<string, unknown>;
  readonly tabId?: string;
  readonly tabTitle?: string;
  readonly size?: BoardWidgetSize;
  readonly after?: string;
}

/** `POST /api/board/pin` — refuses (`BoardProvenanceRefusedError`) a claiming block with no `derivedFrom`. */
export async function pinBoardWidget(
  apiBase: string,
  input: PinBoardWidgetInput,
  opts?: ClientRequestOptions,
): Promise<Board> {
  const response = await mutateJson(
    `${apiBase}/api/board/pin`,
    'POST',
    opts,
    input,
  );
  return unwrapBoardResponse<Board>(response);
}

/** `POST /api/board/unpin` — removes a widget by its stable `name`. */
export async function unpinBoardWidget(
  apiBase: string,
  reference: BoardReference,
  name: string,
  opts?: ClientRequestOptions,
): Promise<Board> {
  const response = await mutateJson(
    `${apiBase}/api/board/unpin`,
    'POST',
    opts,
    { reference, name },
  );
  return unwrapBoardResponse<Board>(response);
}

export interface MoveBoardWidgetInput {
  readonly reference: BoardReference;
  readonly name: string;
  readonly tabId?: string;
  readonly after?: string;
}

/** `POST /api/board/move` — repositions a widget: `after: <name>` (never pixels), optionally into another tab. */
export async function moveBoardWidget(
  apiBase: string,
  input: MoveBoardWidgetInput,
  opts?: ClientRequestOptions,
): Promise<Board> {
  const response = await mutateJson(
    `${apiBase}/api/board/move`,
    'POST',
    opts,
    input,
  );
  return unwrapBoardResponse<Board>(response);
}
