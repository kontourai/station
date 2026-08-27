import type { ReactNode } from 'react';
import { PageSection } from '../../components/PageSection';
import { SETTINGS_SECTIONS } from './settings-catalog';

export function SettingsSection({
  id,
  icon,
  title,
  children,
}: {
  id?: string;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  const catalogTitle = SETTINGS_SECTIONS.find(
    (section) => `section-${section.id}` === id,
  )?.title;
  return (
    <PageSection
      id={id}
      className="settings__section"
      title={
        <>
          <span className="settings__section-icon" aria-hidden="true">
            {icon}
          </span>{' '}
          {catalogTitle ?? title}
        </>
      }
      bodyClassName="settings__section-body"
    >
      {children}
    </PageSection>
  );
}
