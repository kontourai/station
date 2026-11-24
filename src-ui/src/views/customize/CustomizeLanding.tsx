import type { MouseEvent, ReactNode } from 'react';
import { APP_DESTINATION_REGISTRY } from '../../app-shell/destination-registry';
import { useNavigation } from '../../contexts/NavigationContext';
import { COMPUTERS_PATH } from '../connections-hub/connection-sections';
import { CustomizeItemLink } from './CustomizeItemLink';
import { useCustomizeGroups } from './useCustomizeGroups';
import './customize.css';

/** Apps is not a Customize item; this page links to it from a note. */
const APPS_PATH = APP_DESTINATION_REGISTRY.get('plugins')!.route;

/** A link inside a note, opened in place unless a modifier asks otherwise. */
function NoteLink({ to, children }: { to: string; children: ReactNode }) {
  const { navigate } = useNavigation();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick}>
      {children}
    </a>
  );
}

/**
 * The Customize landing: every item, grouped. On a phone this list is the
 * way into each item, since the left list is hidden there.
 */
export function CustomizeLanding() {
  const groups = useCustomizeGroups();
  return (
    <div className="customize-landing">
      {groups.map((group) => (
        <section
          key={group.id}
          className="customize-landing__group"
          aria-labelledby={`customize-landing-${group.id}`}
        >
          <h2
            id={`customize-landing-${group.id}`}
            className="customize-landing__heading"
          >
            {group.label}
            <span className="customize-landing__description">
              {group.description}
            </span>
          </h2>
          <ul className="customize-landing__list">
            {group.items.map((item) => (
              <li key={item.id}>
                <CustomizeItemLink
                  item={item}
                  className="customize-landing__item"
                  trailing={
                    <span
                      className="customize-landing__chevron"
                      aria-hidden="true"
                    >
                      ›
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="customize-landing__note">
        <NoteLink to={APPS_PATH}>Apps</NoteLink> finds screens built for one job
        and manages the ones you added.
      </p>
      <p className="customize-landing__note">
        <NoteLink to={COMPUTERS_PATH}>Computers</NoteLink> lists paired devices
        and SSH computers. Pairing and other Stations are in the Station menu at
        the top right.
      </p>
    </div>
  );
}
