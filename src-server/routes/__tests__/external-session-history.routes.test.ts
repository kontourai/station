import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EXTERNAL_SESSION_HISTORY_PREVIEW,
  type ExternalSessionHistoryImport,
  type ExternalSessionHistoryPage,
  type ExternalSessionTranscriptPage,
} from '@kontourai/station-contracts/orchestration';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ClaudeTranscriptSessionSource } from '../../providers/sessions/claude-transcript-session-source.js';
import { bindRuntimeLocalOperator } from '../../security/runtime-request-security.js';
import { FeaturePreviewRegistry } from '../../services/feature-previews/feature-preview-registry.js';
import { AttachedSessionFollowService } from '../../services/orchestration/attached-session-follow-service.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { createLogger } from '../../utils/logger.js';
import { createExternalSessionHistoryRoutes } from '../external-session-history.js';

const temp = trackTempDirs();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test('owner can browse a provider transcript without saving it, then cancel or import explicitly', async () => {
  const home = temp('station-external-history-');
  const cwd = join(home, 'work');
  const transcripts = join(home, 'projects', 'work');
  await mkdir(cwd);
  await mkdir(transcripts, { recursive: true });
  const prompt = `Read the old log. ${'x'.repeat(26 * 1024)}`;
  const rows = [
    {
      type: 'user',
      uuid: 'u',
      message: { role: 'user', content: prompt },
    },
    {
      type: 'assistant',
      uuid: 'a',
      message: {
        content: [{ type: 'text', text: 'The old log is readable.' }],
      },
    },
  ].map((row) =>
    JSON.stringify({
      sessionId: 'source-history',
      cwd,
      timestamp: '2026-04-01T00:00:00.000Z',
      ...row,
    }),
  );
  await writeFile(
    join(transcripts, 'source-history.jsonl'),
    `${rows.join('\n')}\n`,
  );
  const early = new Date('2026-04-01T00:00:00.000Z');
  await utimes(join(transcripts, 'source-history.jsonl'), early, early);
  await writeFile(
    join(transcripts, 'recent-history.jsonl'),
    `${rows.map((row) => row.replace('source-history', 'recent-history')).join('\n')}\n`,
  );
  const source = new ClaudeTranscriptSessionSource({
    configDir: home,
    maxEvents: 1,
    maxCandidates: 1,
  });
  const store = new EventStore(join(home, 'orchestration.sqlite'));
  const follow = new AttachedSessionFollowService({
    sources: [source],
    eventStore: store,
    eventBus: new EventBus(),
    listProjects: () => [],
  });
  const registry = new FeaturePreviewRegistry(
    home,
    createLogger({ name: 'external-history-test', level: 'error' }),
  );
  const preview = registry.bind({
    id: EXTERNAL_SESSION_HISTORY_PREVIEW,
    label: 'Third-party history',
    description: 'Browse older third-party conversations.',
  });
  const app = new Hono();
  let owner = true;
  app.use('*', async (c, next) => {
    bindRuntimeLocalOperator(c.req.raw, {
      credential: 'device',
      authority: 'device-credential',
      source: 'session',
      ...(owner ? { standing: 'owner-device' as const } : {}),
    });
    await next();
  });
  app.route(
    '/external-history',
    createExternalSessionHistoryRoutes({
      follow,
      preview,
      isOwnerCurrent: () => owner,
    }),
  );
  try {
    const discover = vi.spyOn(source, 'discover');
    const disabled = await app.request('/external-history');
    expect(disabled.status).toBe(404);
    await expect(disabled.json()).resolves.toMatchObject({
      code: 'feature_preview_disabled',
    });
    await registry.setEnabled(EXTERNAL_SESSION_HISTORY_PREVIEW, true);
    owner = false;
    expect((await app.request('/external-history')).status).toBe(403);
    expect(discover).not.toHaveBeenCalled();

    owner = true;
    const catalog = await app.request('/external-history?search=claude');
    expect(catalog.status).toBe(200);
    const { data: recent } = (await catalog.json()) as {
      data: ExternalSessionHistoryPage;
    };
    expect(recent.sessions).toHaveLength(1);
    expect(recent.partial).toBe(true);
    const older = await app.request(
      '/external-history?provider=claude&offset=1',
    );
    expect(older.status).toBe(200);
    const {
      data: { sessions: listed },
    } = (await older.json()) as { data: ExternalSessionHistoryPage };
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      provider: 'claude',
      hasTranscript: true,
    });
    expect(listed[0]).not.toHaveProperty('sourceHandle');
    const id = listed[0].id;
    const transcript = await app.request(`/external-history/${id}/transcript`);
    expect(transcript.headers.get('Cache-Control')).toBe('no-store');
    const { data: firstPage } = (await transcript.json()) as {
      data: ExternalSessionTranscriptPage;
    };
    expect(firstPage.messages).toMatchObject([
      { role: 'user', text: expect.stringMatching(/^Read the old log[.]/) },
    ]);
    expect(firstPage.truncated).toBe(true);
    expect(
      JSON.stringify(firstPage.messages[0].text).length,
    ).toBeLessThanOrEqual(24 * 1024);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const nextPage = await app.request(
      `/external-history/${id}/transcript?cursor=${firstPage.nextCursor}`,
    );
    await expect(nextPage.json()).resolves.toMatchObject({
      data: {
        messages: [{ role: 'assistant', text: 'The old log is readable.' }],
        nextCursor: null,
      },
    });
    expect(store.readSessions()).toEqual([]);
    expect(discover).toHaveBeenCalledTimes(2);

    const operationId = 'a'.repeat(32);
    const signal = AbortSignal.abort();
    const canceled = await app.request(
      `/external-history/${id}/import?operationId=${operationId}`,
      {
        method: 'POST',
        signal,
      },
    );
    expect(canceled.status).toBe(409);
    expect(store.readSessions()).toEqual([]);

    const entered = deferred();
    const release = deferred();
    const read = source.read.bind(source);
    vi.spyOn(source, 'read').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return read(...args);
    });
    const pending = app.request(
      `/external-history/${id}/import?operationId=${operationId}`,
      { method: 'POST' },
    );
    await entered.promise;
    const interrupted = app.request(
      `/external-history/${id}/import/${operationId}`,
      { method: 'DELETE' },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    release.resolve();
    expect((await interrupted).status).toBe(204);
    expect((await pending).status).toBe(409);
    for (const session of store.readSessions()) {
      expect(
        store.listEvents(session.threadId).map(({ payload }) => payload.method),
      ).not.toContain('content.text-delta');
    }

    const imported = await app.request(
      `/external-history/${id}/import?operationId=${'b'.repeat(32)}`,
      {
        method: 'POST',
      },
    );
    expect(imported.status).toBe(200);
    const {
      data: { threadId },
    } = (await imported.json()) as { data: ExternalSessionHistoryImport };
    expect(store.readSessionByThread(threadId)?.controlMode).toBe(
      'read-only-attached',
    );
    expect(store.listEvents(threadId).map(({ payload }) => payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'turn.started' }),
        expect.objectContaining({ method: 'content.text-delta' }),
      ]),
    );
    expect(discover).toHaveBeenCalledTimes(2);
  } finally {
    await follow.stop();
    store.close();
  }
});
