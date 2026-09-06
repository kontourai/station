import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { knowledgeRootIncarnationKey } from '@kontourai/station-shared/knowledge-root-identity';
import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { LazyBoundary } from '../../components/LazyBoundary';
import { ErrorState, SkeletonList } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';

const loadSource = () =>
  import('./LearningSourceDialog').then((module) => ({
    default: module.LearningSourceDialog,
  }));
type Authority = NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;

export function LearningSourceAction({
  root,
  recordId,
}: {
  root: KnowledgeStoreRoot;
  recordId: string;
}) {
  const authority = useHostRequestAuthorityScope();
  const rootIdentity = knowledgeRootIncarnationKey(root);
  const [selected, setSelected] = useState<{
    authority: Authority;
    rootIdentity: string;
    recordId: string;
  } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity changes revoke this captured inspection intent.
  useEffect(() => {
    setSelected(null);
    setUnavailable(false);
  }, [authority?.authorityKey, rootIdentity, recordId]);
  if (root.scope.kind !== 'personal' || root.adapterId !== 'kit-default-store')
    return null;
  return (
    <>
      <Button
        onClick={() => {
          if (!authority?.isCurrent()) {
            setUnavailable(true);
            return;
          }
          setUnavailable(false);
          setSelected({ authority, rootIdentity, recordId });
        }}
      >
        Inspect learning source
      </Button>
      {unavailable ? (
        <ErrorState
          variant="compact"
          title="Source inspection is unavailable for this Station connection."
        />
      ) : null}
      {selected?.authority.isCurrent() &&
      selected.authority.authorityKey === authority?.authorityKey &&
      selected.rootIdentity === rootIdentity &&
      selected.recordId === recordId ? (
        <LazyBoundary
          load={loadSource}
          componentProps={{
            reference: { rootId: root.id, recordId, rootIdentity },
            authority: selected.authority,
            onClose: () => setSelected(null),
          }}
          pending={<SkeletonList count={1} label="Opening learning source" />}
        />
      ) : null}
    </>
  );
}
