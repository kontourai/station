import { reportGroupStreamCursor } from '@kontourai/station-contracts/report-group';
import { outsideStationServerScope } from '../../security/station-server-scope.js';

/** Byte budgets include the public envelope, cursors and explicit omissions. */
export function pageByBytes<T, C extends string | number, P>(input: {
  rows: readonly { cursor: C; value: T | undefined }[];
  after: C;
  hasMore: boolean;
  maxItems: number;
  maxBytes: number;
  format(
    items: T[],
    unavailable: { cursor: C; code: 'item_too_large' }[],
    cursor: C,
    hasMore: boolean,
  ): P;
}): P {
  const items: T[] = [];
  const unavailable: { cursor: C; code: 'item_too_large' }[] = [];
  let cursor = input.after;
  let consumed = 0;
  const fits = (page: P) =>
    new TextEncoder().encode(JSON.stringify({ success: true, data: page }))
      .length <= input.maxBytes;
  for (const row of input.rows) {
    if (consumed >= input.maxItems) break;
    const more = input.hasMore || consumed + 1 < input.rows.length;
    const next = row.value === undefined ? items : [...items, row.value];
    if (!fits(input.format(next, unavailable, row.cursor, more))) {
      if (items.length || unavailable.length) break;
      const omission = { cursor: row.cursor, code: 'item_too_large' as const };
      if (!fits(input.format(items, [omission], row.cursor, more)))
        throw new Error('group_page_budget_too_small');
      unavailable.push(omission);
    } else if (row.value !== undefined) items.push(row.value);
    cursor = row.cursor;
    consumed++;
  }
  const result = input.format(
    items,
    unavailable,
    cursor,
    input.hasMore || consumed < input.rows.length,
  );
  if (!fits(result)) throw new Error('group_page_budget_too_small');
  return result;
}

export async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error('group_stream_aborted');
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      outsideStationServerScope(() =>
        reject(signal.reason ?? new Error('group_stream_aborted')),
      );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export type GroupStreamHint = { event: string; data?: Record<string, unknown> };

/** Resource lifetime is independent of reads, consumer suspension, and iterator.return(). */
export interface GroupPageIterator<T> extends AsyncIterableIterator<T> {
  readonly signal: AbortSignal;
}

export function watchGroupPages<T>(options: {
  signal: AbortSignal;
  lifetimeMs: number;
  refreshMs: number;
  subscribe(listener: (hint: GroupStreamHint) => void): () => void;
  relevant(hint: GroupStreamHint): boolean;
  read(signal: AbortSignal): Promise<T>;
  fingerprint(page: T): string;
  hasMore(page: T): boolean;
}): GroupPageIterator<T> {
  return outsideStationServerScope(() => {
    const lifetime = new AbortController();
    let pending = true;
    let wake: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setInterval> | undefined;
    const stop = () =>
      outsideStationServerScope(() => {
        if (lifetime.signal.aborted) return;
        lifetime.abort(new Error('group_stream_stopped'));
        options.signal.removeEventListener('abort', stop);
        if (deadline) clearTimeout(deadline);
        if (refresh) clearInterval(refresh);
        unsubscribe?.();
        unsubscribe = undefined;
        wake?.();
        wake = undefined;
      });
    const notify = () =>
      outsideStationServerScope(() => {
        pending = true;
        wake?.();
      });
    options.signal.addEventListener('abort', stop, { once: true });
    if (options.signal.aborted) stop();
    if (!lifetime.signal.aborted) {
      try {
        unsubscribe = options.subscribe((hint) =>
          outsideStationServerScope(() => {
            if (options.relevant(hint)) notify();
          }),
        );
        if (lifetime.signal.aborted) {
          unsubscribe();
          unsubscribe = undefined;
        } else deadline = setTimeout(stop, options.lifetimeMs);
        if (!lifetime.signal.aborted)
          refresh = setInterval(notify, options.refreshMs);
      } catch (error) {
        stop();
        throw error;
      }
    }
    const iterator = (async function* () {
      let fingerprint: string | undefined;
      try {
        while (!lifetime.signal.aborted) {
          pending = false;
          const page = await awaitWithAbort(
            Promise.resolve().then(() => {
              if (lifetime.signal.aborted) throw lifetime.signal.reason;
              return options.read(lifetime.signal);
            }),
            lifetime.signal,
          );
          if (lifetime.signal.aborted) return;
          const next = options.fingerprint(page);
          if (next !== fingerprint) {
            fingerprint = next;
            yield page;
          }
          if (options.hasMore(page) || pending) continue;
          await awaitWithAbort(
            new Promise<void>((resolve) => {
              wake = () => {
                wake = undefined;
                resolve();
              };
              if (pending || lifetime.signal.aborted) wake();
            }),
            lifetime.signal,
          );
        }
      } catch (error) {
        if (!lifetime.signal.aborted) throw error;
      } finally {
        stop();
      }
    })();
    return {
      signal: lifetime.signal,
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => outsideStationServerScope(() => iterator.next()),
      return: () =>
        outsideStationServerScope(() => {
          stop();
          return iterator.return();
        }),
      throw: (error?: unknown) =>
        outsideStationServerScope(() => {
          stop();
          return iterator.throw(error);
        }),
    };
  });
}

export type GroupStreamCursorDomain =
  | { kind: 'group' | 'report'; groupId: string }
  | { kind: 'member'; groupId: string; seatId: string };

export function encodeGroupStreamCursor(
  domain: GroupStreamCursorDomain,
  cursor: number,
): string {
  if (domain.kind === 'report')
    return reportGroupStreamCursor(domain.groupId, cursor);
  return domain.kind === 'member'
    ? `member:${encodeURIComponent(domain.groupId)}:${encodeURIComponent(domain.seatId)}:${cursor}`
    : `${domain.kind}:${encodeURIComponent(domain.groupId)}:${cursor}`;
}

/** A newer Last-Event-ID supersedes the initial URL cursor only in this exact domain. */
export function readGroupStreamCursor(
  domain: GroupStreamCursorDomain,
  initial: number | undefined,
  lastEventId: string | undefined,
): number {
  const max =
    domain.kind === 'group'
      ? 512
      : domain.kind === 'report'
        ? 1024
        : Number.MAX_SAFE_INTEGER;
  if (
    initial !== undefined &&
    (!Number.isSafeInteger(initial) || initial < 0 || initial > max)
  )
    throw new Error('group_stream_cursor_invalid');
  if (lastEventId === undefined) return initial ?? 0;
  const prefix = encodeGroupStreamCursor(domain, 0).slice(0, -1);
  if (!lastEventId.startsWith(prefix))
    throw new Error('group_stream_cursor_invalid');
  const text = lastEventId.slice(prefix.length);
  if (!/^(0|[1-9][0-9]{0,15})$/.test(text))
    throw new Error('group_stream_cursor_invalid');
  const cursor = Number(text);
  if (
    !Number.isSafeInteger(cursor) ||
    cursor > max ||
    (initial !== undefined && cursor < initial)
  )
    throw new Error('group_stream_cursor_invalid');
  return cursor;
}

export function createGroupStreamLifetime(
  parent: AbortSignal,
  lifetimeMs: number,
): { signal: AbortSignal; stop(): void } {
  return outsideStationServerScope(() => {
    const controller = new AbortController();
    const stop = () =>
      outsideStationServerScope(() => {
        if (controller.signal.aborted) return;
        controller.abort(new Error('group_stream_stopped'));
        clearTimeout(timer);
        parent.removeEventListener('abort', stop);
      });
    const timer = setTimeout(stop, lifetimeMs);
    parent.addEventListener('abort', stop, { once: true });
    if (parent.aborted) stop();
    return { signal: controller.signal, stop };
  });
}
