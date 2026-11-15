import { useEffect, useRef } from 'react';

/**
 * "New channel" from the sidebar or the phone's channel list (#4794): open the
 * Project's room and its own create form. The room's channel header owns the
 * form, its guards and the create mutation, so the list asks rather than
 * creating a second implementation (the same idiom as `requestNewBoard`).
 *
 * The request is held until a header for that Project takes it, because the
 * room usually mounts after the navigation the request rides on.
 */
const NEW_CHANNEL_REQUEST_EVENT = 'station-new-channel-request';
const pending = new Set<string>();

export function requestNewChannel(projectSlug: string): void {
  pending.add(projectSlug);
  window.dispatchEvent(
    new CustomEvent(NEW_CHANNEL_REQUEST_EVENT, { detail: projectSlug }),
  );
}

/**
 * Calls `onRequest` for a held or new request for `projectSlug` once `ready`
 * (the header can show its form). Each request is taken once.
 */
export function useNewChannelRequest(
  projectSlug: string | undefined,
  ready: boolean,
  onRequest: () => void,
): void {
  const handler = useRef(onRequest);
  handler.current = onRequest;
  useEffect(() => {
    if (!projectSlug || !ready) return;
    const take = () => {
      if (pending.delete(projectSlug)) handler.current();
    };
    take();
    const listener = (event: Event) => {
      if ((event as CustomEvent<string>).detail === projectSlug) take();
    };
    window.addEventListener(NEW_CHANNEL_REQUEST_EVENT, listener);
    return () =>
      window.removeEventListener(NEW_CHANNEL_REQUEST_EVENT, listener);
  }, [projectSlug, ready]);
}
