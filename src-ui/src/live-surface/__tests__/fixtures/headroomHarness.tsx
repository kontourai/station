/**
 * Browser page for the input-headroom fixture (#2760): real `useLiveSurface`
 * viewers of distinct surfaces, over the real browser `fetch` and its
 * HTTP/1.1 connection pool. Bundled by the fixture test, never by the app.
 *
 * Query: `surfaces=a,b,c,d` (one viewer each), `cap=N` frame streams per
 * origin (`cap=0`: unbounded, the pre-#2760 baseline), `events=N` held
 * event streams (the always-on `/events` and orchestration streams).
 */
import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { createLiveSurfaceStreamAdmission } from '../../liveSurfaceStreamAdmission';
import {
  type UseLiveSurfaceResult,
  useLiveSurface,
} from '../../useLiveSurface';

declare global {
  interface Window {
    liveSurfaces: Record<string, UseLiveSurfaceResult>;
    liveSurfaceFrames: Record<string, number>;
  }
}

const query = new URLSearchParams(location.search);
const cap = Number(query.get('cap') ?? '2');
const admission = createLiveSurfaceStreamAdmission(
  cap > 0 ? cap : Number.POSITIVE_INFINITY,
);
const surfaces = (query.get('surfaces') ?? 'a,b,c,d').split(',');
window.liveSurfaces = {};
window.liveSurfaceFrames = {};

// The always-on event streams hold their connections for the page's life.
for (let i = 0; i < Number(query.get('events') ?? '2'); i += 1)
  void fetch(`/events/${i}`).then((response) =>
    response.body?.getReader().read(),
  );

const transport = ((url: string, init?: RequestInit) =>
  fetch(url, {
    method: init?.method ?? 'GET',
    headers: init?.headers ?? {},
    ...(init?.body ? { body: init.body } : {}),
    ...(init?.signal ? { signal: init.signal } : {}),
  })) as never;

function Viewer({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const surface = useLiveSurface({
    apiBase: location.origin,
    surfaceId: id,
    visibilityRef: ref,
    onFrame: () => {
      window.liveSurfaceFrames[id] = (window.liveSurfaceFrames[id] ?? 0) + 1;
    },
    transport,
    streamAdmission: admission,
  });
  window.liveSurfaces[id] = surface;
  return (
    <div ref={ref} data-surface={id} data-status={surface.status}>
      {id}: {surface.status}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <>
    {surfaces.map((id) => (
      <Viewer key={id} id={id} />
    ))}
  </>,
);
