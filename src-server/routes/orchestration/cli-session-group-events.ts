import {
  type CliSessionGroupEventPage,
  cliSessionGroupStreamCursor,
  readCliSessionGroupStreamCursor,
} from '@kontourai/station-contracts/delegation-group';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { outsideStationServerScope } from '../../security/station-server-scope.js';
import {
  awaitWithAbort,
  createGroupStreamLifetime,
  watchGroupPages,
} from '../../services/orchestration/delegation-group-transport.js';
import { streamSSE } from '../sse-response.js';

const querySchema = z
  .object({
    afterRevision: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,15})$/)
      .transform(Number)
      .refine(Number.isSafeInteger)
      .optional(),
  })
  .strict();
export function createCliSessionGroupEventRoutes(owners: {
  bind(
    c: Context,
    groupId: string,
  ): {
    assertCurrent(): void;
    read(afterRevision: number): Promise<CliSessionGroupEventPage>;
    subscribe(listener: () => void): () => void;
  };
  failure(c: Context, error: unknown): Response;
}): Hono {
  const app = new Hono();
  app.get('/:groupId/events', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    try {
      const { afterRevision } = querySchema.parse(c.req.query());
      const host = owners.bind(c, c.req.param('groupId'));
      const page = await host.read(afterRevision ?? 0);
      host.assertCurrent();
      return c.json({ success: true, data: page });
    } catch (error) {
      return owners.failure(c, error);
    }
  });
  app.get('/:groupId/events/stream', (c) =>
    outsideStationServerScope(async () => {
      c.header('Cache-Control', 'private, no-store');
      const lifetime = createGroupStreamLifetime(c.req.raw.signal, 60_000);
      try {
        const groupId = c.req.param('groupId');
        const { afterRevision } = querySchema.parse(c.req.query());
        let cursor = readCliSessionGroupStreamCursor(
          groupId,
          afterRevision,
          c.req.header('Last-Event-ID'),
        );
        const host = owners.bind(c, groupId);
        await awaitWithAbort(host.read(cursor), lifetime.signal);
        host.assertCurrent();
        return streamSSE(c, (stream) =>
          outsideStationServerScope(async () => {
            const stop = () =>
              outsideStationServerScope(() => {
                lifetime.stop();
                stream.abort();
              });
            stream.onAbort(lifetime.stop);
            lifetime.signal.addEventListener('abort', stop, { once: true });
            const pages = watchGroupPages({
              signal: lifetime.signal,
              lifetimeMs: 60_000,
              refreshMs: 15_000,
              subscribe: (notify) =>
                host.subscribe(() => notify({ event: 'group-write' })),
              relevant: () => true,
              read: async () => {
                const page = await host.read(cursor);
                cursor = page.nextRevision;
                return page;
              },
              fingerprint: (page) =>
                JSON.stringify([
                  page.nextRevision,
                  page.events,
                  page.gap,
                  page.unavailable,
                ]),
              hasMore: (page) => page.hasMore,
            });
            try {
              for await (const page of pages) {
                const data = JSON.stringify(page);
                if (Buffer.byteLength(data) > 262_144)
                  throw new Error('group_response_too_large');
                host.assertCurrent();
                await awaitWithAbort(
                  stream.writeSSE({
                    event: 'cli-group-events',
                    id: cliSessionGroupStreamCursor(groupId, page.nextRevision),
                    data,
                  }),
                  lifetime.signal,
                );
              }
            } catch {
              if (!lifetime.signal.aborted)
                await awaitWithAbort(
                  stream.writeSSE({ event: 'unavailable', data: '{}' }),
                  lifetime.signal,
                ).catch(() => {});
            } finally {
              await pages.return?.();
              lifetime.signal.removeEventListener('abort', stop);
              stop();
            }
          }),
        );
      } catch (error) {
        lifetime.stop();
        return owners.failure(c, error);
      }
    }),
  );
  return app;
}
