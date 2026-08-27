/**
 * station#1502 slice 4 fix round, MEDIUM-1 — the wire predicates are CALLED.
 *
 * `isWellFormedProjectResolutionView`'s own docblock says it exists for values
 * that arrive without a compiler and that this one "crosses the wire on every
 * settings render". The client did a bare unchecked cast, and the surface's
 * switches are exhaustive with NO `default:` (deliberately — a `default` is how
 * a renderer invents a state), so an unrecognised discriminant fell off the end
 * of the switch and React rendered NOTHING: a header and a description over an
 * empty body, with no error and no named gap. A nightly desktop app against a
 * stable server that has since added a state is exactly that scenario.
 *
 * Throwing routes it into the surface's existing `isError` → ErrorState +
 * Retry branch, which is the honest rendering of "this client cannot read this
 * answer".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bindProjectResource,
  closeProjectTerminal,
  getProjectResolution,
} from '../client/projects';

function okJsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('getProjectResolution — malformed wire payloads', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('accepts and returns a well-formed view', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJsonResponse({ success: true, data: { posture: 'not-backing' } }),
    );

    await expect(
      getProjectResolution('http://example.test', 'acme'),
    ).resolves.toEqual({ posture: 'not-backing' });
  });

  it('throws, naming the unrecognised posture, rather than handing the surface a value it renders as blank', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJsonResponse({
        success: true,
        data: { posture: 'partially-backing', resource: null },
      }),
    );

    await expect(
      getProjectResolution('http://example.test', 'acme'),
    ).rejects.toThrow(/posture "partially-backing"/);
  });

  it('throws on a view whose RESOURCE is ill-formed — the slot invariants have one authority', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJsonResponse({
        success: true,
        data: {
          posture: 'backing',
          // A path on a non-`bound` state: the answer-slot leak.
          resource: {
            state: 'unbound',
            resourceId: 'r',
            reason: 'x',
            path: '/somewhere',
          },
        },
      }),
    );

    await expect(
      getProjectResolution('http://example.test', 'acme'),
    ).rejects.toThrow(/does not understand/);
  });

  it('throws on a non-object payload without leaking it into the message', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJsonResponse({ success: true, data: '/Users/dev/secret/path' }),
    );

    const error = await getProjectResolution(
      'http://example.test',
      'acme',
    ).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('it is string, not an object');
    expect((error as Error).message).not.toContain('/Users/dev/secret/path');
  });
});

describe('bindProjectResource — the outcome envelope', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns a recorded write carrying the re-derived view', async () => {
    const view = { posture: 'not-backing' };
    vi.mocked(fetch).mockResolvedValue(
      okJsonResponse({ success: true, data: { recorded: true, view } }),
    );

    await expect(
      bindProjectResource('http://example.test', 'acme', { path: '/x' }),
    ).resolves.toEqual({ recorded: true, view });
  });

  it('returns a recorded write carrying a NAMED gap — never a rejection', async () => {
    const gap = 'The binding was recorded. This Station could not re-read it.';
    vi.mocked(fetch).mockResolvedValue(
      okJsonResponse({ success: true, data: { recorded: true, gap } }),
    );

    await expect(
      bindProjectResource('http://example.test', 'acme', { path: '/x' }),
    ).resolves.toEqual({ recorded: true, gap });
  });

  it('throws on an outcome that asserts neither a view nor a gap', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJsonResponse({ success: true, data: { recorded: true } }),
    );

    await expect(
      bindProjectResource('http://example.test', 'acme', { path: '/x' }),
    ).rejects.toThrow(/does not understand/);
  });

  it('still rejects a REFUSAL with the server reason verbatim', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        error: 'It is a different repository, so nothing was recorded',
      }),
    } as Response);

    await expect(
      bindProjectResource('http://example.test', 'acme', { path: '/x' }),
    ).rejects.toThrow('It is a different repository, so nothing was recorded');
  });
});

describe('closeProjectTerminal', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('uses the project-bound terminal route and returns its exact identity', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJsonResponse({
        success: true,
        data: {
          sessionId: 'acme:terminal-1',
          projectSlug: 'acme',
          terminalId: 'terminal-1',
        },
      }),
    );

    await expect(
      closeProjectTerminal('http://example.test', 'acme', 'terminal-1'),
    ).resolves.toEqual({
      sessionId: 'acme:terminal-1',
      projectSlug: 'acme',
      terminalId: 'terminal-1',
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/projects/acme/terminals/terminal-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
