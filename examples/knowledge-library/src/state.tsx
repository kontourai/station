import {
  Empty,
  type EmptyProps,
  Skeleton,
  type SkeletonProps,
} from '@kontourai/ui/react';
import type { ReactNode } from 'react';

export type { EmptyProps, SkeletonProps };
export { Empty, Skeleton };

export interface ErrorStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  variant?: EmptyProps['variant'];
}

export function ErrorState({
  title,
  description,
  action,
  variant = 'prominent',
}: ErrorStateProps) {
  return (
    <div role="alert" className="kl-error-state">
      <Empty
        variant={variant}
        icon={<span aria-hidden="true">⚠</span>}
        label={title}
        description={description}
        action={action}
      />
    </div>
  );
}
