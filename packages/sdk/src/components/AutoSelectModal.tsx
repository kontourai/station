import React, { type ReactNode, useEffect, useState } from 'react';
import './AutoSelectModal.css';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import { useResponsiveVisualViewport } from './useResponsiveVisualViewport';

export interface AutoSelectItem<T = any> {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  metadata?: T;
  badge?: string;
  timestamp?: string;
  isActive?: boolean;
}

interface AutoSelectModalProps<T = any> {
  isOpen: boolean;
  title: string;
  placeholder?: string;
  items: AutoSelectItem<T>[];
  loading?: boolean;
  emptyMessage?: string;
  onSelect: (item: AutoSelectItem<T>) => void;
  onClose: () => void;
  renderIcon?: (item: AutoSelectItem<T>) => ReactNode;
  renderMetadata?: (item: AutoSelectItem<T>) => ReactNode;
  showCancel?: boolean;
}

export function AutoSelectModal<T = any>({
  isOpen,
  title,
  placeholder = 'Search...',
  items,
  loading = false,
  emptyMessage = 'No items found',
  onSelect,
  onClose,
  renderIcon,
  renderMetadata,
  showCancel = false,
}: AutoSelectModalProps<T>) {
  const visualViewportStyle = useResponsiveVisualViewport();
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  // This surface has carried `aria-modal="true"` since before the a11y sweep,
  // with nothing keeping focus inside it. The hook owns Escape here (see
  // `handleKeyDown` below, which no longer does) so one keypress is one
  // `onClose`, and so Escape works from the item list too, not only the search
  // field. It also owns the focus move on open: the search field is the first
  // focusable inside the dialog, so the hook lands exactly where this component
  // used to aim its own input-ref timer, and one focus authority cannot fight
  // itself.
  const dialogRef = useDialogFocusTrap<HTMLDivElement>({
    active: isOpen,
    onEscape: onClose,
  });

  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  const filteredItems = items.filter((item) => {
    const searchLower = search.toLowerCase();
    return (
      item.title.toLowerCase().includes(searchLower) ||
      item.subtitle?.toLowerCase().includes(searchLower) ||
      item.description?.toLowerCase().includes(searchLower)
    );
  });

  useEffect(() => {
    setSelectedIndex(0);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filteredItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && filteredItems[selectedIndex]) {
      e.preventDefault();
      onSelect(filteredItems[selectedIndex]);
    }
    // Escape is deliberately absent: `useDialogFocusTrap` handles it on
    // `document`, so keeping a branch here would call `onClose` twice for one
    // keypress.
  };

  if (!isOpen) return null;

  return (
    // biome-ignore lint/a11y: Backdrop click dismissal has an equivalent keyboard path — the dialog's Escape handler; the backdrop itself must not enter the tab order.
    <div
      className="auto-select-modal-overlay"
      style={visualViewportStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="auto-select-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-select-modal-title"
      >
        <div className="auto-select-modal__header">
          <h3 id="auto-select-modal-title" className="auto-select-modal__title">
            {title}
          </h3>
          <input
            type="text"
            placeholder={placeholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            className="auto-select-modal__search"
          />
        </div>

        <div className="auto-select-modal__content">
          {loading ? (
            // A non-verbal wait: skeleton rows hold the list's shape instead
            // of a bespoke "Loading..." sentence (the SHELL-13 rule; the SDK
            // cannot import src-ui's Skeleton, so it ships the same shape in
            // its own CSS). The accessible name carries the wait for screen
            // readers without printing a wait sentence on screen.
            <div
              className="auto-select-modal__loading"
              role="status"
              aria-label="Loading items"
            >
              {Array.from({ length: 4 }, (_, i) => (
                <div className="auto-select-modal__skeleton-row" key={i}>
                  <span className="auto-select-modal__skeleton-icon" />
                  <span className="auto-select-modal__skeleton-lines">
                    <span className="auto-select-modal__skeleton-line" />
                    <span className="auto-select-modal__skeleton-line auto-select-modal__skeleton-line--short" />
                  </span>
                </div>
              ))}
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="auto-select-modal__status" role="status">
              {emptyMessage}
            </div>
          ) : (
            filteredItems.map((item, idx) => (
              <button
                type="button"
                key={item.id}
                onClick={() => onSelect(item)}
                onMouseEnter={() => setSelectedIndex(idx)}
                className={`auto-select-modal__item ${idx === selectedIndex ? 'auto-select-modal__item--selected' : ''}`}
              >
                {renderIcon && (
                  <div className="auto-select-modal__icon">
                    {renderIcon(item)}
                  </div>
                )}

                <div className="auto-select-modal__item-content">
                  <div className="auto-select-modal__item-header">
                    <div className="auto-select-modal__item-title">
                      {item.isActive && (
                        <span className="auto-select-modal__active-indicator">
                          ●
                        </span>
                      )}
                      {item.title}
                      {item.badge && (
                        <span className="auto-select-modal__badge">
                          {item.badge}
                        </span>
                      )}
                    </div>
                    {item.timestamp && (
                      <div className="auto-select-modal__timestamp">
                        {item.timestamp}
                      </div>
                    )}
                  </div>

                  {item.subtitle && (
                    <div className="auto-select-modal__subtitle">
                      {item.subtitle}
                    </div>
                  )}
                  {item.description && (
                    <div className="auto-select-modal__description">
                      {item.description}
                    </div>
                  )}
                  {renderMetadata?.(item)}
                </div>
              </button>
            ))
          )}
        </div>

        {showCancel && (
          <div className="auto-select-modal__footer">
            <button
              type="button"
              onClick={onClose}
              className="auto-select-modal__cancel"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
