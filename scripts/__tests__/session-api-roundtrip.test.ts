import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  continueForegroundMessageSchema,
  foregroundMessageObjectSchema,
} from '../../src-server/routes/orchestration/orchestration.js';
import { runSessionApiRoundtrip } from '../session-api-roundtrip.mjs';

const tempDir = trackTempDirs();

function fixture(
  fault?:
    | 'indeterminate'
    | 'approval'
    | 'aborted'
    | 'wrong-turn'
    | 'missing-id'
    | 'reused-turn'
    | 'receipt-unavailable',
) {
  const workspaceDir = tempDir('session-api-roundtrip-');
  let nonce = '';
  let firstCompleted = false;
  let polls = 0;
  const fetchImpl = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (!init) throw new Error('Expected request options');
      const url = new URL(input instanceof Request ? input.url : input);
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer fixture-credential',
      });
      expect(init.redirect).toBe('error');
      const path = url.pathname;
      if (path === '/api/orchestration/chat') {
        const body = JSON.parse(String(init.body));
        expect(foregroundMessageObjectSchema.parse(body)).toEqual(body);
        expect(body.target).toEqual({
          environment: { kind: 'current' },
          agent: 'configured-agent',
          workspace: { kind: 'directory', cwd: workspaceDir },
        });
        const noncePath = body.message.match(
          /^Read the file at (.+) and reply with/,
        )[1];
        nonce = await readFile(noncePath, 'utf8');
        expect(body.message).not.toContain(nonce);
        if (fault === 'receipt-unavailable')
          return Response.json({
            success: true,
            receiptStatus: 'unavailable',
            data: {
              conversationId: 'conversation-a',
              sessionId: 'session-first',
              providerTurnId: 'turn-first',
            },
          });
        if (fault === 'indeterminate')
          return Response.json(
            {
              success: false,
              outcome: 'indeterminate',
              receiptStatus: 'unavailable',
              code: 'foreground_message_indeterminate',
            },
            { status: 503 },
          );
        return Response.json({
          success: true,
          data: {
            conversationId: 'conversation-a',
            sessionId: 'session-first',
            ...(fault === 'missing-id' ? {} : { providerTurnId: 'turn-first' }),
          },
        });
      }
      if (path === '/api/orchestration/chat/conversation-a/continue') {
        expect(firstCompleted).toBe(true);
        const body = JSON.parse(String(init.body));
        expect(continueForegroundMessageSchema.parse(body)).toEqual(body);
        expect(body).not.toHaveProperty('target');
        return Response.json({
          success: true,
          data: {
            conversationId: 'conversation-a',
            sessionId:
              fault === 'reused-turn' ? 'session-first' : 'session-replacement',
            providerTurnId:
              fault === 'reused-turn' ? 'turn-first' : 'turn-second',
          },
        });
      }
      const match = path.match(
        /^\/api\/orchestration\/sessions\/(session-first|session-replacement)\/(events|messages)$/,
      );
      if (!match) throw new Error(`Unexpected endpoint: ${path}`);
      expect(init.method).toBe('GET');
      const turnId =
        match[1] === 'session-first' ? 'turn-first' : 'turn-second';
      if (match[2] === 'events') {
        if (fault === 'approval')
          return Response.json({
            success: true,
            data: [
              { method: 'request.opened', turnId, requestId: 'approval-1' },
            ],
          });
        if (fault === 'aborted')
          return Response.json({
            success: true,
            data: [{ method: 'turn.aborted', turnId }],
          });
        if (++polls === 1)
          return Response.json({
            success: true,
            data: [{ method: 'turn.completed', turnId: 'older-turn' }],
          });
        if (turnId === 'turn-first') firstCompleted = true;
        return Response.json({
          success: true,
          data: [{ method: 'turn.completed', turnId }],
        });
      }
      return Response.json({
        success: true,
        data: [
          {
            role: 'user',
            metadata: { turnId },
            parts: [{ type: 'text', text: nonce }],
          },
          {
            role: 'assistant',
            metadata: {
              turnId: fault === 'wrong-turn' ? 'older-turn' : turnId,
            },
            parts: [
              { type: 'text', text: nonce.slice(0, 15) },
              { type: 'tool-invocation', text: 'not assistant prose' },
              { type: 'text', text: nonce.slice(15) },
            ],
          },
        ],
      });
    },
  );
  return {
    fetchImpl,
    workspaceDir,
    run: () =>
      runSessionApiRoundtrip({
        baseUrl: 'http://atlas.test',
        credential: 'fixture-credential',
        agent: 'configured-agent',
        workspaceDir,
        pollIntervalMs: 0,
        fetchImpl,
      }),
  };
}

describe('Session API live diagnostic protocol', () => {
  it('uses canonical schemas, waits for the exact turn, follows returned identities and reads every text part', async () => {
    const subject = fixture();
    const result = await subject.run();
    expect(result.continued.sessionId).toBe('session-replacement');
    expect(
      subject.fetchImpl.mock.calls.filter(
        ([, init]) => init?.method === 'POST',
      ),
    ).toHaveLength(2);
    expect(await readdir(subject.workspaceDir)).toEqual([]);
  });

  it('refuses a continuation handle that reuses the already-proven turn', async () => {
    const subject = fixture('reused-turn');
    await expect(subject.run()).rejects.toThrow('previous turn');
    expect(
      subject.fetchImpl.mock.calls.filter(
        ([, init]) => init?.method === 'POST',
      ),
    ).toHaveLength(2);
    expect(await readdir(subject.workspaceDir)).toEqual([]);
  });

  it.each([
    ['indeterminate', /inspect the Session before retrying/],
    ['receipt-unavailable', /inspect the Session before retrying/],
    ['approval', /No decision was sent/],
    ['aborted', /failed or was aborted/],
    ['wrong-turn', /did not return the nonce/],
    ['missing-id', /Missing providerTurnId/],
  ] as const)(
    'refuses %s without a second dispatch and cleans its nonce file',
    async (fault, message) => {
      const subject = fixture(fault);
      await expect(subject.run()).rejects.toThrow(message);
      expect(
        subject.fetchImpl.mock.calls.filter(
          ([, init]) => init?.method === 'POST',
        ),
      ).toHaveLength(1);
      expect(await readdir(subject.workspaceDir)).toEqual([]);
    },
  );
});
