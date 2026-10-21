import { useContext, useMemo } from 'react';
import { SDKContext } from './providers';
import { type RelatedPanes, UNSUPPORTED_RELATED_PANES } from './related-panes';

/**
 * The related-pane capability of the pane occurrence this component renders
 * in (docs/design/pane-relationships.md): open one of this plugin's own
 * descriptors for a bounded target key, reveal or close what this pane
 * opened, and read the target this pane was itself opened for.
 *
 * ```tsx
 * const related = useRelatedPanes();
 * const outcome = await related.open({
 *   descriptorId: 'pane:plugin%3Areports:report-detail',
 *   modeId: 'project',
 *   key: report.id,
 * });
 * if (outcome.status === 'unavailable') showInline(outcome.reason);
 * ```
 *
 * The host chooses the presentation and checks ownership, context and
 * current authorization; nothing a plugin passes widens what its panes may
 * read. Inside a sandboxed frame, use `createRelatedPanesPaneHost` instead.
 *
 * On the SDK root only: a plugin bundle receives the root from its host at
 * runtime, which is what binds this hook to the host's own provider.
 */
export function useRelatedPanes(): RelatedPanes {
  const host = useContext(SDKContext)?.relatedPanes;
  return useMemo(() => {
    const supported = host?.version === 1;
    const capability = supported ? host : UNSUPPORTED_RELATED_PANES;
    return {
      version: 1,
      supported,
      open: capability.open,
      reveal: capability.reveal,
      close: capability.close,
      target: capability.target,
    };
  }, [host]);
}
