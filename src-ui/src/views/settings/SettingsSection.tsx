import type { ReactNode } from 'react';
import { PageSection } from '../../components/PageSection';
import { SETTINGS_SECTIONS } from './settings-catalog';

export function SettingsSection({
  id,
  icon,
  title,
  action,
  children,
}: {
  id?: string;
  icon: ReactNode;
  title: string;
  /**
   * One compact control on the header line, right-aligned (#3557). Optional:
   * a section without it renders exactly as before.
   */
  action?: ReactNode;
  children: ReactNode;
}) {
  const catalogTitle = SETTINGS_SECTIONS.find(
    (section) => `section-${section.id}` === id,
  )?.title;
  return (
    <PageSection
      id={id}
      className={
        action
          ? 'settings__section settings__section--with-action'
          : 'settings__section'
      }
      title={
        <>
          <span className="settings__section-icon" aria-hidden="true">
            {icon}
          </span>{' '}
          {catalogTitle ?? title}
        </>
      }
      bodyClassName="settings__section-body"
      {...(action ? { actions: action } : {})}
    >
      {children}
    </PageSection>
  );
}
