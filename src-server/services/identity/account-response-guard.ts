import { ACCOUNT_AUTHENTICATION_FAILURE_HEADER } from '@kontourai/station-contracts/application-session';

/** Recheck at release to the transport, including chunks queued by the producer. */
export async function guardAccountResponse(
  response: Response,
  current: () => Promise<'current' | 'invalid' | 'unavailable'>,
): Promise<Response> {
  const admission = await current();
  if (admission !== 'current') {
    await response.body?.cancel().catch(() => {});
    return Response.json(
      {
        error: {
          code:
            admission === 'invalid'
              ? 'account_authentication_invalid'
              : 'authentication_unavailable',
        },
      },
      {
        status: admission === 'invalid' ? 401 : 503,
        headers: {
          'Cache-Control': 'no-store',
          ...(admission === 'invalid'
            ? { [ACCOUNT_AUTHENTICATION_FAILURE_HEADER]: 'account' }
            : {}),
        },
      },
    );
  }
  if (!response.body) return response;
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
          if ((await current()) !== 'current')
            throw new Error(
              'Account authorization ended before response delivery.',
            );
          controller.enqueue(next.value);
        } catch (error) {
          closed = true;
          await reader.cancel().catch(() => {});
          controller.error(error);
        }
      },
      async cancel(reason) {
        closed = true;
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
