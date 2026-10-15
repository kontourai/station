import { lazy, Suspense, useState } from 'react';
import { Button } from '../../components/Button';
import { PageHeaderScope } from '../../components/page-frame';
import { SkeletonList } from '../../components/state';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';

const Registry = lazy(() =>
  import('../RegistryView').then((module) => ({
    default: module.RegistryView,
  })),
);
const Connections = lazy(() =>
  import('../IntegrationsView').then((module) => ({
    default: module.IntegrationsView,
  })),
);

export function AgentToolDiscovery({
  onInstalled,
}: {
  onInstalled: () => void;
}) {
  return (
    <PageHeaderScope>
      <div className="agent-tool-discovery">
        <Suspense
          fallback={<SkeletonList count={3} label="Loading catalogs" />}
        >
          <Registry
            initialTab="integrations"
            toolPicker
            onInstalled={onInstalled}
          />
        </Suspense>
      </div>
    </PageHeaderScope>
  );
}

export function AgentToolConnection({
  id,
  onBack,
  onDirtyChange,
}: {
  id: string;
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(id);
  const [dirty, setDirty] = useState(false);
  const { guard, DiscardModal } = useUnsavedGuard(dirty);
  return (
    <PageHeaderScope>
      <div className="agent-tool-picker__setup">
        <Button variant="ghost" onClick={() => guard(onBack)}>
          Back to tools
        </Button>
        <Suspense
          fallback={<SkeletonList count={3} label="Loading connection" />}
        >
          <Connections
            selection={{
              selectedId,
              saved: (next) => {
                setDirty(false);
                onDirtyChange(false);
                setSelectedId(next);
              },
              select: (next) => guard(() => setSelectedId(next)),
              deselect: () => guard(onBack),
            }}
            onDirtyChange={(next) => {
              setDirty(next);
              onDirtyChange(next);
            }}
          />
        </Suspense>
        <DiscardModal />
      </div>
    </PageHeaderScope>
  );
}
