/**
 * SSE test helper — reads an SSE response stream and collects parsed events.
 * Works with Hono's streamSSE responses from app.request().
 */

/** Collect SSE events from a Response until the stream ends or timeout. */
export async function collectSSE(
  res: Response,
  opts?: { maxEvents?: number; timeoutMs?: number },
): Promise<Array<{ event?: string; data: string; parsed?: any }>> {
  const maxEvents = opts?.maxEvents ?? 50;
  const timeoutMs = opts?.timeoutMs ?? 2000;
  const events: Array<{ event?: string; data: string; parsed?: any }> = [];

  const reader = res.body?.getReader();
  if (!reader) return events;

  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | undefined;

  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, timeoutMs),
  );
  const read = async () => {
    try {
      while (events.length < maxEvents) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6);
            let parsed: any;
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = undefined;
            }
            events.push({ event: currentEvent, data, parsed });
            currentEvent = undefined;
          } else if (line === '') {
            // Empty line = end of event block, reset
            currentEvent = undefined;
          }
        }
      }
    } catch (_e) {
      // Stream aborted or errored — that's fine, return what we have
    }
  };

  await Promise.race([read(), timeout]);
  reader.cancel().catch(() => {});
  return events;
}

/**
 * Accumulate a raw SSE response stream (undecoded event/data framing, not
 * per-event parsed like `collectSSE`) until `matcher` finds what it's
 * looking for in the text accumulated so far, then return that text.
 * Rejects nothing on stream end — callers assert on the returned text, so a
 * dead/errored connection that never satisfies `matcher` fails the test's
 * own assertion instead of hanging (station#1164/#1197/#1205 real-service
 * ownership-gate suites use this to prove a connection is genuinely alive
 * — it received a marker frame it should — before asserting a leaked
 * payload is absent from the same accumulated text).
 */
export async function readStreamUntil(
  stream: ReadableStream<Uint8Array>,
  matcher: (payload: string) => boolean,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      if (matcher(output)) {
        return output;
      }
    }
  } finally {
    await reader.cancel();
  }

  return output;
}
