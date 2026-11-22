import { CustomizeItemLink } from './CustomizeItemLink';
import { useCustomizeGroups } from './useCustomizeGroups';
import './customize.css';

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
                    <span className="customize-landing__chevron" aria-hidden="true">
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
        Devices and other Stations are in the Station menu at the top right.
      </p>
    </div>
  );
}
