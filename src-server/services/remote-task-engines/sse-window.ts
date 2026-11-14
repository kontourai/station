/**
 * Reads a bounded window of a Server-Sent Events stream: the events already
 * waiting, then stop. A poll must end, so the window closes at the first of a
 * `heartbeat` or `done` event, `maxEvents` events, `idleMs` without a byte,
 * or `windowMs` in all. Parsing follows the SSE format: `id:`, `event:`,
 * `data:` lines (data lines joined by `\n`), a blank line ends an event,
 * `:` lines are comments.
 */
export interface SseEvent {
  readonly id?: string;
  readonly event: string;
  readonly data: string;
}

export interface SseWindowOptions {
  readonly maxEvents: number;
  readonly idleMs: number;
  readonly windowMs: number;
  /** Event names that end the window once read. */
  readonly stopAt: readonly string[];
}

export interface SseWindow {
  readonly events: SseEvent[];
  /** The stream ended (the server closed it). */
  readonly ended: boolean;
}

export async function readSseWindow(
  body: ReadableStream<Uint8Array>,
  options: SseWindowOptions,
  abort: () => void,
): Promise<SseWindow> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = '';
  let id: string | undefined;
  let event = '';
  let data: string[] = [];
  let ended = false;
  let stop = false;
  const deadline = Date.now() + options.windowMs;

  const dispatch = () => {
    if (data.length > 0 || event) {
      events.push({
        ...(id !== undefined ? { id } : {}),
        event: event || 'message',
        data: data.join('\n'),
      });
      if (options.stopAt.includes(event) || events.length >= options.maxEvents)
        stop = true;
    }
    id = undefined;
    event = '';
    data = [];
  };

  const line = (text: string) => {
    if (text === '') return dispatch();
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };

  try {
    while (!stop) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<'idle'>((resolve) => {
        timer = setTimeout(
          () => resolve('idle'),
          Math.min(options.idleMs, remaining),
        );
      });
      const next = await Promise.race([reader.read(), idle]);
      clearTimeout(timer);
      if (next === 'idle') break;
      if (next.done) {
        ended = true;
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      let newline = buffer.search(/\r\n|\n|\r/);
      while (newline !== -1 && !stop) {
        const length = buffer.startsWith('\r\n', newline) ? 2 : 1;
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + length);
        newline = buffer.search(/\r\n|\n|\r/);
      }
    }
  } finally {
    abort();
    reader.cancel().catch(() => {});
  }
  return { events, ended };
}
