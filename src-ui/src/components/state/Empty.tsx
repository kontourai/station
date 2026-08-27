// The empty-state primitive is the shared @kontourai/ui primitive; re-export
// it so every migrated view imports from one discoverable, Station-owned
// path (mirrors the existing `../Skeleton` re-export pattern).
export { Empty, type EmptyProps } from '@kontourai/ui/react';
