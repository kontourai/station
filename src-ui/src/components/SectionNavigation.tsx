import { Select } from '@kontourai/ui/react';
import { type ReactNode, useId } from 'react';
import { SectionNav, type SectionNavItem } from './SectionNav';

/** One responsive section selector for Settings and diagnostic workspaces. */
export function SectionNavigation({
  items,
  activeKey,
  onNavigate,
  label,
  pickerLabel = label,
  children,
  showSelection = true,
}: {
  items: readonly SectionNavItem[];
  activeKey: string;
  onNavigate: (key: string) => void;
  label: string;
  pickerLabel?: string;
  children?: ReactNode;
  showSelection?: boolean;
}) {
  const pickerId = useId();
  return (
    <div className="section-navigation section-nav--rail">
      {children}
      <div className="section-navigation__picker">
        <label htmlFor={pickerId}>{pickerLabel}</label>
        <Select
          id={pickerId}
          value={activeKey}
          onChange={(event) => onNavigate(event.target.value)}
        >
          {!items.some((item) => item.key === activeKey) && (
            <option value={activeKey}>All sections</option>
          )}
          {items.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </Select>
      </div>
      <SectionNav
        className="section-navigation__links section-nav--rail"
        aria-label={label}
        items={items}
        activeKey={showSelection ? activeKey : ''}
        onNavigate={onNavigate}
      />
    </div>
  );
}
