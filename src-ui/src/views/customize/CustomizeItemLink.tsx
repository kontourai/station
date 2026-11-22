import type { MouseEvent, ReactNode } from 'react';
import { destinationIcon } from '../../components/project-sidebar/nav-items';
import { useNavigation } from '../../contexts/NavigationContext';
import type { CustomizeItem } from './useCustomizeGroups';

/**
 * One Customize item as a link: icon, name, then its count and attention
 * dot. The dot's meaning joins the link's accessible name, because a dot
 * alone says nothing to assistive technology.
 */
export function CustomizeItemLink({
  item,
  current = false,
  className,
  trailing,
}: {
  item: CustomizeItem;
  current?: boolean;
  className: string;
  trailing?: ReactNode;
}) {
  const { navigate } = useNavigation();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    navigate(item.route);
  };
  return (
    <a
      href={item.route}
      className={className}
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
    >
      {item.icon ? destinationIcon(item.icon) : null}
      <span className="customize-item__label">{item.label}</span>
      {item.needsAttention ? (
        <span className="customize-item__dot" aria-hidden="true" />
      ) : null}
      {/* The spaces keep the accessible name "Engines 5", not "Engines5";
          a flex row does not render them. */}
      {item.count !== null ? (
        <>
          {' '}
          <span className="customize-item__count">{item.count}</span>
        </>
      ) : null}
      {item.needsAttention ? (
        <span className="sr-only">, needs attention</span>
      ) : null}
      {trailing}
    </a>
  );
}
