import { afterEach, describe, expect, test, vi } from 'vitest';
import { resetPublicStationCapabilities } from '../client/publicStationCapabilities.js';
import { resumeTask, TaskResumeError } from '../task-resume.js';

/** The shape a host serves at the public handshake path; only `capabilities` varies. */
const hostHandshake = (capabilities: Record<string, boolean>) => ({
  schemaVersion: 1,
  environmentId: '00000000-0000-4000-8000-000000000000',
  authentication: { scheme: 'bearer', protocolVersion: 1 },
  transports: { http: 1, sse: 1, websocket: 1 },
  compatibility: {
    serverVersion: '0.1.11',
    protocolVersion: 3,
    minClientProtocol: 1,
    capabilities: {
      productTelemetryAcknowledgement: 2,
      remoteAuth: 1,
      devicePairing: 1,
      environmentProof: 1,
      clientProtocolHeader: 1,
    },
  },
  capabilities,
});

const REQUEST = {
  resumeId: 'resume-1',
  expectedCreatedAt: '2026-11-01T00:00:00.000Z',
  expectedEndedAt: '2026-11-02T00:00:00.000Z',
  reason: 'One more test',
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetPublicStationCapabilities();
});

describe('task resume client (#4554)', () => {
  test('an unreadable capability handshake refuses before sending a resume request', async () => {
    const fetchMock = vi.fn(
      async (_url: string) => new Response('{}', { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      resumeTask('task-1', REQUEST, { apiBase: 'http://station.test' }),
    ).rejects.toMatchObject({ code: 'task_resume_unavailable', status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('/resume');
  });

  test('a host without taskResume is reported as unable to resume, and no resume request is sent', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/.well-known/')
        ? new Response(JSON.stringify(hostHandshake({})))
        : new Response('{}', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const error = await resumeTask('task-1', REQUEST, {
      apiBase: 'http://station.test',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaskResumeError);
    expect((error as TaskResumeError).code).toBe('unsupported');
    expect((error as TaskResumeError).message).toMatch(/Updating Station/);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/resume')),
    ).toBe(false);
  });

  test('a host with the flag gets the request, and its refusal code reaches the caller', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.includes('/.well-known/')
        ? new Response(JSON.stringify(hostHandshake({ taskResume: true })))
        : new Response(
            JSON.stringify({
              success: false,
              code: 'task_resume_canceled',
              error: 'A canceled Task stays ended.',
            }),
            { status: 409 },
          ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const error = await resumeTask('task-1', REQUEST, {
      apiBase: 'http://station.test',
    }).catch((caught: unknown) => caught);
    expect((error as TaskResumeError).code).toBe('task_resume_canceled');
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/api/tasks/task-1/resume'),
    ) as [string, RequestInit];
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(String(call[1].body))).toEqual(REQUEST);
  });
});
