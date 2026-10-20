import type {
  PaneRelatedPanesHost,
  RelatedPaneUnavailable,
} from '@kontourai/station-contracts/workspace-pane-host-contract';

// React-free on purpose: the Pane subpath re-exports this module, and its
// consumers include frame code compiled without JSX. The hook a direct
// plugin uses is `related-panes-hook.ts`, on the root only.

const UNSUPPORTED: RelatedPaneUnavailable = Object.freeze({
  status: 'unavailable',
  reason: 'unsupported',
});

/**
 * What a host without the related-pane capability answers: every request is
 * `unavailable: unsupported` and the caller keeps showing its own pane. A
 * value, never a rejection, so a plugin needs no host-version branch.
 */
export const UNSUPPORTED_RELATED_PANES: PaneRelatedPanesHost = Object.freeze({
  version: 1 as const,
  open: () => Promise.resolve(UNSUPPORTED),
  reveal: () => Promise.resolve(UNSUPPORTED),
  close: () => Promise.resolve(UNSUPPORTED),
  target: () => Promise.resolve(null),
});

export interface RelatedPanes extends PaneRelatedPanesHost {
  /** False on a host without the capability: every request is `unsupported`. */
  supported: boolean;
}

interface PaneMessageTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

declare const window: {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent) => void,
  ): void;
};

/**
 * The related-pane capability for a plugin running in a sandboxed frame:
 * request/response messages to the host window (`target`, at exactly
 * `origin`), answered by the same host implementation a direct pane calls.
 * A host that predates the capability refuses the method by name, which
 * settles as `unsupported`; an unanswered request settles `refused` after 30
 * seconds. Like the contract, no promise here rejects.
 *
 * Self-contained on purpose: Station injects this function's source into the
 * frame (`window.__stationCreateRelatedPanesPaneHost`), so it may not refer
 * to anything outside its own body.
 */
export function createRelatedPanesPaneHost(
  target: PaneMessageTarget,
  origin: string,
): PaneRelatedPanesHost & { dispose(): void } {
  const REASONS = [
    'unsupported',
    'invalid-request',
    'unknown-descriptor',
    'mode-unsatisfiable',
    'not-authorized',
    'context-mismatch',
    'station-unverified',
    'capacity',
    'contended',
    'superseded',
    'rate-limited',
    'guard-cancelled',
    'unknown-handle',
    'refused',
  ];
  const PRESENTATIONS = ['beside', 'child', 'sheet', 'tool'];
  const expectedOrigin = new URL(origin).origin;
  type Method = 'open' | 'reveal' | 'close' | 'target';
  const pending = new Map<
    string,
    {
      method: Method;
      settle(value: unknown): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let serial = 0;
  let disposed = false;
  const unavailable = (reason: string) => ({ status: 'unavailable', reason });
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const isText = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max;
  const fallback = (method: Method, reason: string) =>
    method === 'target' ? null : unavailable(reason);
  // Only shapes the contract defines reach the plugin; anything else from
  // the host reads as a refusal rather than a value the plugin must guard.
  const decode = (method: Method, data: unknown): unknown => {
    if (method === 'target') {
      if (data === null) return null;
      return isObject(data) &&
        isText(data.descriptorId, 256) &&
        isText(data.modeId, 128) &&
        isText(data.key, 256)
        ? {
            descriptorId: data.descriptorId,
            modeId: data.modeId,
            key: data.key,
          }
        : null;
    }
    if (!isObject(data)) return unavailable('refused');
    if (data.status === 'unavailable')
      return unavailable(
        REASONS.includes(data.reason as string)
          ? (data.reason as string)
          : 'refused',
      );
    const presentation = PRESENTATIONS.includes(data.presentation as string)
      ? (data.presentation as string)
      : null;
    if (
      method === 'open' &&
      (data.status === 'opened' ||
        data.status === 'focused' ||
        data.status === 'replaced') &&
      isText(data.handle, 128) &&
      presentation
    )
      return { status: data.status, handle: data.handle, presentation };
    if (method === 'reveal' && data.status === 'focused' && presentation)
      return { status: 'focused', presentation };
    if (method === 'close' && data.status === 'closed')
      return { status: 'closed' };
    return unavailable('refused');
  };
  const settle = (id: string, value: unknown) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.settle(value);
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== target || event.origin !== expectedOrigin) return;
    const message = event.data;
    if (!isObject(message) || !isObject(message.params)) return;
    const params = message.params;
    if (message.method === 'pane-host/related-result') {
      const entry =
        typeof params.id === 'string' ? pending.get(params.id) : undefined;
      if (entry) settle(params.id as string, decode(entry.method, params.data));
      return;
    }
    // A host without the capability refuses the method by name, with no
    // id to correlate: the oldest request for that method is the refused one.
    if (message.method === 'pane-host/refused') {
      for (const [id, entry] of pending) {
        if (params.method === `pane-host/related-${entry.method}`) {
          settle(id, fallback(entry.method, 'unsupported'));
          return;
        }
      }
    }
  };
  window.addEventListener('message', receive);
  const request = (
    method: Method,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    if (disposed) return Promise.resolve(fallback(method, 'refused'));
    if (pending.size >= 16)
      return Promise.resolve(fallback(method, 'rate-limited'));
    serial += 1;
    const id = `related:${serial}`;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => settle(id, fallback(method, 'refused')),
        30000,
      );
      pending.set(id, { method, settle: resolve, timer });
      try {
        target.postMessage(
          { method: `pane-host/related-${method}`, params: { ...params, id } },
          origin,
        );
      } catch {
        // A value the structured clone cannot carry never left the frame.
        settle(id, fallback(method, 'invalid-request'));
      }
    });
  };
  return {
    version: 1,
    open: (openRequest) =>
      request('open', { request: openRequest }) as ReturnType<
        PaneRelatedPanesHost['open']
      >,
    reveal: (handle) =>
      request('reveal', { handle }) as ReturnType<
        PaneRelatedPanesHost['reveal']
      >,
    close: (handle) =>
      request('close', { handle }) as ReturnType<PaneRelatedPanesHost['close']>,
    target: () =>
      request('target', {}) as ReturnType<PaneRelatedPanesHost['target']>,
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('message', receive);
      for (const [id, entry] of pending)
        settle(id, fallback(entry.method, 'refused'));
    },
  };
}
