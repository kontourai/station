/** Recheck Project membership at transport release, including queued chunks. */
export async function guardProjectResponse(
  response: Response,
  current: () => Promise<boolean>,
): Promise<Response> {
  if (!(await current())) {
    void response.body?.cancel().catch(() => {});
    return Response.json(
      { success: false, error: 'Project not found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  if (!response.body)
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  const reader = response.body.getReader();
  let closed = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (closed) return;
        try {
          const next = await reader.read();
          if (next.done) {
            closed = true;
            controller.close();
            return;
          }
          if (!(await current()))
            throw new Error(
              'Project authorization ended before response delivery.',
            );
          controller.enqueue(next.value);
        } catch (error) {
          closed = true;
          void reader.cancel().catch(() => {});
          controller.error(error);
        }
      },
      cancel(reason) {
        closed = true;
        void reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
