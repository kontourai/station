import type { PaneSkillExperienceHost } from '@kontourai/station-contracts/workspace-pane-host-contract';

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

/** Narrow frame transport. Session, event scope and source identity stay in the host. */
export function createSkillExperiencePaneHost(
  target: PaneMessageTarget,
  origin: string,
): PaneSkillExperienceHost & { dispose(): void } {
  const pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(reason: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let serial = 0;
  const receive = (event: MessageEvent) => {
    if (event.source !== target || event.origin !== new URL(origin).origin)
      return;
    const message = event.data;
    if (
      !message ||
      typeof message !== 'object' ||
      !message.params ||
      typeof message.params.id !== 'string'
    )
      return;
    if (
      message.method !== 'pane-host/experience-result' &&
      message.method !== 'pane-host/refused'
    )
      return;
    const entry = pending.get(message.params.id);
    if (!entry) return;
    pending.delete(message.params.id);
    clearTimeout(entry.timer);
    if (message.method === 'pane-host/refused')
      entry.reject(new Error('The host refused this experience action.'));
    else entry.resolve(message.params.data);
  };
  window.addEventListener('message', receive);
  let disposed = false;
  const request = (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    if (disposed || pending.size >= 16)
      return Promise.reject(new Error('The experience host is unavailable.'));
    const id = `experience:${++serial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The experience host did not answer.'));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      target.postMessage({ method, params: { ...params, id } }, origin);
    });
  };
  return {
    async read() {
      const result = await request('pane-host/experience-read', {});
      if (
        !result ||
        typeof result !== 'object' ||
        !('viewJson' in result) ||
        typeof result.viewJson !== 'string'
      )
        throw new Error('Invalid experience projection.');
      return { viewJson: result.viewJson };
    },
    async answer(input) {
      await request('pane-host/experience-answer', input);
    },
    async continue(input) {
      await request('pane-host/experience-continue', input);
    },
    dispose() {
      disposed = true;
      window.removeEventListener('message', receive);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('The experience frame was retired.'));
      }
      pending.clear();
    },
  };
}
