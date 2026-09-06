import { readBoundedRequestBody as readBoundedHttpBody } from '../../security/bounded-request-body.js';
import type { PeerCredential } from '../peers/peer-credential-store.js';

type Peer = Readonly<PeerCredential & { credential: string }>;

/** Transport only. The binding owner validates every returned identity field. */
export function probeHomeTransferRoom(
  peer: Peer,
  input: Readonly<{ taskId: string; channelId: string; nonce: string }>,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  return requestRoomObservation(
    peer,
    input.taskId,
    'identity',
    { channelId: input.channelId, nonce: input.nonce },
    4096,
    fetcher,
  );
}

/** Reads an existing seal. This request cannot close or activate a remote room. */
export function readHomeTransferRoomSeal(
  peer: Peer,
  input: Readonly<{
    taskId: string;
    channelId: string;
    nonce: string;
    operationId: string;
    sourceHomeRef: string;
    targetHomeRef: string;
  }>,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  return requestRoomObservation(
    peer,
    input.taskId,
    'seal-observation',
    {
      channelId: input.channelId,
      nonce: input.nonce,
      operationId: input.operationId,
      sourceHomeRef: input.sourceHomeRef,
      targetHomeRef: input.targetHomeRef,
    },
    8192,
    fetcher,
  );
}

async function requestRoomObservation(
  peer: Peer,
  taskId: string,
  leaf: 'identity' | 'seal-observation',
  input: Record<string, string>,
  maximumBytes: number,
  fetcher: typeof fetch,
): Promise<unknown> {
  const origin = new URL(peer.apiBase);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('Invalid remote Station origin');
  const url = `${origin.origin}/api/home-authority/rooms/${encodeURIComponent(taskId)}/${leaf}`;
  const credential = peer.credential;
  const body = JSON.stringify(input);
  const controller = new AbortController();
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async () => {
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
      redirect: 'error',
      signal: controller.signal,
    });
    if (
      !response.ok ||
      response.redirected ||
      (response.url && response.url !== url)
    ) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Remote room identity unavailable');
    }
    const read = await readBoundedHttpBody(response, maximumBytes);
    controller.signal.throwIfAborted();
    if (performance.now() - started >= 15000 || read.status !== 'ok')
      throw new Error('Remote room identity unavailable');
    return JSON.parse(read.body) as unknown;
  };
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Remote room identity timed out'));
        }, 15000);
      }),
    ]);
  } catch {
    throw new Error('Remote room identity unavailable');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
