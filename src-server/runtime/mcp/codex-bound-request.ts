import { createHash } from 'node:crypto';

// Proof is attached to the exact Request Station dispatches in process. It
// cannot be recreated by sending its headers over a socket or cloning it.
const proofs = new WeakMap<
  Request,
  { digest: string; current: () => boolean }
>();

export function bindCodexToolRequest(
  request: Request,
  token: string,
  current: () => boolean,
): void {
  const path = new URL(request.url).pathname;
  if (
    proofs.has(request) ||
    request.method !== 'POST' ||
    !(
      path.startsWith('/api/browser-agent/') ||
      path.startsWith('/api/device-agent/')
    )
  )
    throw new Error('bound-tool-request-refused');
  proofs.set(request, {
    digest: createHash('sha256').update(token).digest('base64url'),
    current,
  });
}

export function codexToolRequestIsBound(
  request: Request,
  token: string,
): boolean {
  const proof = proofs.get(request);
  try {
    return (
      !!proof &&
      proof.digest === createHash('sha256').update(token).digest('base64url') &&
      proof.current()
    );
  } catch {
    return false;
  }
}

/** Move proof only to the bounded-body replacement made by runtime HTTP. */
export function transferCodexToolRequestProof(
  previous: Request,
  replacement: Request,
): void {
  const proof = proofs.get(previous);
  if (
    !proof ||
    previous.url !== replacement.url ||
    previous.method !== replacement.method
  )
    return;
  const token = replacement.headers.get('x-station-control-caller-token');
  if (!token || !codexToolRequestIsBound(previous, token)) return;
  proofs.delete(previous);
  proofs.set(replacement, proof);
}
