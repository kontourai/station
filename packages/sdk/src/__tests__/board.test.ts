import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoardProvenanceRefusedError,
  BoardResponseError,
  getBoard,
  moveBoardWidget,
  pinBoardWidget,
  unpinBoardWidget,
} from '../client/board';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('board client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('getBoard issues a GET with the reference in the query string', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: { schemaVersion: 1, tabs: [], widgets: [] },
      }),
    );
    await getBoard('http://example.test', { kind: 'session', id: 's-1' });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://example.test/api/board?kind=session&id=s-1');
  });

  it('getBoard includes projectId for a task reference', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: { schemaVersion: 1, tabs: [], widgets: [] },
      }),
    );
    await getBoard('http://example.test', {
      kind: 'task',
      id: 't-1',
      projectId: 'p-1',
    });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('kind=task');
    expect(url).toContain('id=t-1');
    expect(url).toContain('projectId=p-1');
  });

  it('pinBoardWidget POSTs to /api/board/pin and returns the board', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const board = { schemaVersion: 1, tabs: [], widgets: [] };
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { success: true, data: board }),
    );
    const result = await pinBoardWidget('http://example.test', {
      reference: { kind: 'session', id: 's-1' },
      name: 'a',
      block: { type: 'card', body: 'x' },
    });
    expect(result).toEqual(board);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://example.test/api/board/pin');
    expect(init.method).toBe('POST');
  });

  it('pinBoardWidget throws BoardProvenanceRefusedError on a refused pin', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        success: false,
        code: 'board_provenance_refused',
        error:
          "render_component: a 'card' block claiming data values requires 'derivedFrom' source references; emission without them is refused.",
      }),
    );
    await expect(
      pinBoardWidget('http://example.test', {
        reference: { kind: 'session', id: 's-1' },
        name: 'a',
        block: {
          type: 'card',
          body: 'x',
          fields: [{ label: 'l', value: 'v' }],
        },
      }),
    ).rejects.toBeInstanceOf(BoardProvenanceRefusedError);
  });

  it('a non-provenance failure surfaces as the generic BoardResponseError, not the typed refusal', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, {
        success: false,
        code: 'board_widget_not_found',
        error: 'Board widget not found.',
      }),
    );
    const failure = await unpinBoardWidget(
      'http://example.test',
      { kind: 'session', id: 's-1' },
      'nope',
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BoardResponseError);
    expect(failure).not.toBeInstanceOf(BoardProvenanceRefusedError);
    expect((failure as BoardResponseError).code).toBe('board_widget_not_found');
  });

  it('moveBoardWidget POSTs to /api/board/move', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: { schemaVersion: 1, tabs: [], widgets: [] },
      }),
    );
    await moveBoardWidget('http://example.test', {
      reference: { kind: 'session', id: 's-1' },
      name: 'a',
      after: 'b',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://example.test/api/board/move');
    expect(init.method).toBe('POST');
  });
});
