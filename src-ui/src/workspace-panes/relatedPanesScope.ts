import type {
  PaneRelatedPanesHost,
  RelatedPaneUnavailable,
} from '@kontourai/station-contracts/workspace-pane-host-contract';

/**
 * Narrowing a related-pane capability to a shorter lifetime than its
 * occurrence's: a frame's capability lives only as long as the frame
 * document that made the request. The host registers how to narrow each
 * capability it makes (`createRelatedPanesHost`), so the narrowed one is
 * re-admitted at every point the host re-admits — on arrival and inside the
 * lock, after any guard answered — and a request from a replaced document
 * changes nothing, rather than only losing its answer.
 *
 * Its own module so the frame transport can narrow without loading the
 * host's catalog and model dependencies.
 */
type Narrow = (alive: () => boolean) => PaneRelatedPanesHost;

const narrowers = new WeakMap<PaneRelatedPanesHost, Narrow>();

export function registerRelatedPanesScope(
  host: PaneRelatedPanesHost,
  narrow: Narrow,
): void {
  narrowers.set(host, narrow);
}

const REVOKED: RelatedPaneUnavailable = Object.freeze({
  status: 'unavailable',
  reason: 'context-mismatch',
});

/**
 * `host`, admitted only while `alive()` holds. A capability this module does
 * not know (another host's) can only be refused at arrival; it is never
 * passed through unnarrowed.
 */
export function scopeRelatedPanes(
  host: PaneRelatedPanesHost,
  alive: () => boolean,
): PaneRelatedPanesHost {
  const narrow = narrowers.get(host);
  if (narrow) return narrow(alive);
  return {
    version: 1,
    open: (request) =>
      alive() ? host.open(request) : Promise.resolve(REVOKED),
    reveal: (handle) =>
      alive() ? host.reveal(handle) : Promise.resolve(REVOKED),
    close: (handle) =>
      alive() ? host.close(handle) : Promise.resolve(REVOKED),
    target: () => (alive() ? host.target() : Promise.resolve(null)),
  };
}
