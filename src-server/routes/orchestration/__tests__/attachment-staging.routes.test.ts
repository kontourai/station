import { describe, expect, test } from 'vitest';
import { AttachmentStagingService } from '../../../services/orchestration/attachment-staging-service.js';
import { createAttachmentStagingRoutes } from '../attachment-staging.js';

const app = () =>
  createAttachmentStagingRoutes({
    service: new AttachmentStagingService(),
    currentOwner: (context) => ({
      principalId:
        context.req.raw.headers.get('x-owner') ?? 'human:local:operator',
    }),
  });

const descriptor = {
  clientAttachmentId: 'client-attachment-1',
  kind: 'file',
  name: 'note.txt',
  mimeType: 'text/plain',
  size: 5,
};

const DATA = 'data:text/plain;base64,aGVsbG8=';
type StageGrant = { stageId: string; uploadGrant: string };

function uploadHeaders(grant: { uploadGrant: string }, length = DATA.length) {
  return {
    Authorization: `Bearer ${grant.uploadGrant}`,
    'Content-Length': String(length),
    'Content-Type': 'text/plain;charset=utf-8',
  };
}

describe('attachment staging routes', () => {
  test('issues a one-use grant and keeps it out of reconciliation', async () => {
    const routes = app();
    const prepared = await routes.request('/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(descriptor),
    });
    expect(prepared.status).toBe(200);
    const grant = (await prepared.json()) as StageGrant;
    const uploaded = await routes.request(`/${grant.stageId}`, {
      method: 'PUT',
      headers: {
        ...uploadHeaders(grant),
      },
      body: DATA,
    });
    const reference = await uploaded.json();
    expect(reference).not.toHaveProperty('uploadGrant');
    const reconcile = await routes.request('/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stageIds: [grant.stageId] }),
    });
    const status = JSON.stringify(await reconcile.json());
    expect(status).not.toContain(grant.uploadGrant);
    expect(status).not.toContain('aGVsbG8');
  });

  test('uses the scoped grant for raw upload while another owner cannot observe the stage', async () => {
    const routes = app();
    const prepared = await routes.request('/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-owner': 'owner-a' },
      body: JSON.stringify(descriptor),
    });
    const grant = (await prepared.json()) as StageGrant;
    const upload = await routes.request(`/${grant.stageId}`, {
      method: 'PUT',
      headers: {
        ...uploadHeaders(grant),
        'x-owner': 'owner-b',
      },
      body: DATA,
    });
    expect(upload.status).toBe(200);
    const reconcile = await routes.request('/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-owner': 'owner-b' },
      body: JSON.stringify({ stageIds: [grant.stageId] }),
    });
    expect(await reconcile.json()).toEqual([
      { stageId: grant.stageId, state: 'missing' },
    ]);
  });

  test('fails closed for a missing or lying raw-body length, MIME, and URL grant', async () => {
    const routes = app();
    const prepared = await routes.request('/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(descriptor),
    });
    const grant = (await prepared.json()) as StageGrant;
    const missingLength = await routes.request(`/${grant.stageId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${grant.uploadGrant}`,
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: DATA,
    });
    expect(missingLength.status).toBe(400);

    const replay = await routes.request('/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(descriptor),
    });
    const replayGrant = (await replay.json()) as StageGrant;
    const lyingLength = await routes.request(`/${replayGrant.stageId}`, {
      method: 'PUT',
      headers: uploadHeaders(replayGrant, DATA.length - 1),
      body: DATA,
    });
    expect(lyingLength.status).toBe(400);

    const wrongMime = await routes.request(`/${replayGrant.stageId}`, {
      method: 'PUT',
      headers: { ...uploadHeaders(replayGrant), 'Content-Type': 'text/plain' },
      body: DATA,
    });
    expect(wrongMime.status).toBe(403);

    const inUrl = await routes.request(`/${replayGrant.stageId}?grant=x`, {
      method: 'PUT',
      headers: uploadHeaders(replayGrant),
      body: DATA,
    });
    expect(inUrl.status).toBe(403);
  });

  test('cancels a streamed overflow before parsing or service mutation', async () => {
    const routes = app();
    const prepared = await routes.request('/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...descriptor, size: 5 * 1024 * 1024 }),
    });
    const grant = (await prepared.json()) as StageGrant;
    const limit = Math.ceil((5 * 1024 * 1024 * 4) / 3) + 128;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(limit));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const response = await routes.request(
      new Request(`http://localhost/${grant.stageId}`, {
        method: 'PUT',
        headers: uploadHeaders(grant, limit),
        body,
        // Node's fetch implementation requires this for a streaming request.
        duplex: 'half',
      } as RequestInit),
    );
    expect(response.status).toBe(400);
  });

  test('rejects a data-url MIME or decoded-size mismatch before recording a reference', async () => {
    const routes = app();
    const prepared = await routes.request('/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(descriptor),
    });
    const grant = (await prepared.json()) as StageGrant;
    const badMime = 'data:image/png;base64,aGVsbG8=';
    const response = await routes.request(`/${grant.stageId}`, {
      method: 'PUT',
      headers: uploadHeaders(grant, badMime.length),
      body: badMime,
    });
    expect(response.status).toBe(400);
    const status = await routes.request('/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stageIds: [grant.stageId] }),
    });
    expect(await status.json()).toEqual([
      expect.objectContaining({ stageId: grant.stageId, state: 'pending' }),
    ]);
  });
});
