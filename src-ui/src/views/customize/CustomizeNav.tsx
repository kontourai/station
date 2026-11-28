import { useNavigation } from '../../contexts/NavigationContext';
import { CustomizeItemLink } from './CustomizeItemLink';
import { OVERVIEW_GLYPH } from './customize-glyphs';
import { useCustomizeGroups } from './useCustomizeGroups';
import './customize.css';

/**
 * The Customize page's left list: Overview, then each group and its items.
 * Hidden on a phone, where the landing's list is the way in.
 */
export function CustomizeNav({ activeId }: { activeId: string | null }) {
  const groups = useCustomizeGroups();
  const { navigate } = useNavigation();
  return (
    <nav className="customize-nav" aria-label="Customize">
      <p className="customize-nav__title" aria-hidden="true">
        Customize
      </p>
      <a
        href="/customize"
        className="customize-nav__item"
        aria-current={activeId === 'customize' ? 'page' : undefined}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          navigate('/customize');
        }}
      >
        {OVERVIEW_GLYPH}
        <span className="customize-item__label">Overview</span>
      </a>
      {groups.map((group) => (
        <section
          key={group.id}
          className="customize-nav__group"
          aria-labelledby={`customize-nav-${group.id}`}
        >
          <h2
            id={`customize-nav-${group.id}`}
            className="customize-nav__group-label"
          >
            {group.label}
          </h2>
          <ul className="customize-nav__list">
            {group.items.map((item) => (
              <li key={item.id}>
                <CustomizeItemLink
                  item={item}
                  current={item.id === activeId}
                  className="customize-nav__item"
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
