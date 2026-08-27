import type { ReactNode } from 'react';
import { PageSection } from '../../components/PageSection';

interface ConnectionsHubSectionProps {
  id: string;
  title: string;
  description: string;
  manageLabel?: string;
  onManage?: () => void;
  secondaryManageLabel?: string;
  onSecondaryManage?: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function ConnectionsHubSection({
  id,
  title,
  description,
  manageLabel,
  onManage,
  secondaryManageLabel,
  onSecondaryManage,
  children,
  footer,
}: ConnectionsHubSectionProps) {
  return (
    <PageSection
      id={`section-${id}`}
      className="connections-page__section"
      title={title}
      description={description}
      actions={
        manageLabel && onManage ? (
          <>
            {secondaryManageLabel && onSecondaryManage && (
              <button
                type="button"
                className="connections-page__section-action connections-page__section-action--secondary"
                onClick={onSecondaryManage}
              >
                {secondaryManageLabel}
              </button>
            )}
            <button
              type="button"
              className="connections-page__section-action"
              onClick={onManage}
            >
              {manageLabel}
            </button>
          </>
        ) : undefined
      }
    >
      <div className="connections-page__cards">{children}</div>
      {footer}
    </PageSection>
  );
}
