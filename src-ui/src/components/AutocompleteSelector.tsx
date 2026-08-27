import { type ReactNode, useEffect, useRef, useState } from 'react';

export interface AutocompleteItem {
  id: string;
  title: string;
  description?: string;
  metadata?: any;
  badge?: string;
  icon?: string;
  isCustomIcon?: boolean;
  isActive?: boolean;
}

interface AutocompleteSelectorProps {
  items: AutocompleteItem[];
  onSelect: (item: AutocompleteItem) => void;
  onClose: () => void;
  emptyMessage?: string;
  maxHeight?: string;
  renderIcon?: (item: AutocompleteItem) => ReactNode;
}

export function AutocompleteSelector({
  items,
  onSelect,
  onClose,
  emptyMessage = 'No results found',
  maxHeight,
  renderIcon,
}: AutocompleteSelectorProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedIndexRef = useRef(0);
  const itemsRef = useRef<AutocompleteItem[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Update refs
  selectedIndexRef.current = selectedIndex;
  itemsRef.current = items;

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    const selectedElement = itemRefs.current.get(selectedIndex);
    if (selectedElement && containerRef.current) {
      const container = containerRef.current;
      const elementTop = selectedElement.offsetTop;
      const elementBottom = elementTop + selectedElement.offsetHeight;
      const containerScrollTop = container.scrollTop;
      const containerHeight = container.clientHeight;

      // Scroll up if element is above visible area
      if (elementTop < containerScrollTop) {
        container.scrollTop = elementTop;
      }
      // Scroll down if element is below visible area
      else if (elementBottom > containerScrollTop + containerHeight) {
        container.scrollTop = elementBottom - containerHeight;
      }
    }
  }, [selectedIndex]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((prev) =>
          Math.min(prev + 1, itemsRef.current.length - 1),
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const item = itemsRef.current[selectedIndexRef.current];
        if (item) {
          e.preventDefault();
          e.stopPropagation();
          onSelect(item);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onSelect, onClose]);

  if (items.length === 0) {
    return (
      <div
        ref={containerRef}
        style={{
          position: 'absolute',
          bottom: '100%',
          left: 0,
          right: 0,
          marginBottom: '8px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          borderRadius: '4px',
          padding: '12px',
          zIndex: 1000,
          boxShadow: '0 -4px 12px rgba(0, 0, 0, 0.1)',
          color: 'var(--text-muted)',
          fontSize: '14px',
          textAlign: 'center',
        }}
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: '8px',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        borderRadius: '4px',
        maxHeight: maxHeight || 'min(300px, 40vh)',
        overflowY: 'auto',
        zIndex: 1000,
        boxShadow: '0 -4px 12px rgba(0, 0, 0, 0.1)',
      }}
    >
      {items.map((item, idx) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: mouse-only convenience; ArrowUp/ArrowDown/Enter navigate and select via the window-level listener above.
        <div
          key={item.id}
          ref={(el) => {
            if (el) itemRefs.current.set(idx, el);
            else itemRefs.current.delete(idx);
          }}
          onMouseDown={(e) => {
            e.preventDefault(); // Prevent blur
            onSelect(item);
          }}
          onMouseEnter={() => setSelectedIndex(idx)}
          style={{
            padding: '10px 12px',
            cursor: 'pointer',
            background:
              idx === selectedIndex ? 'var(--bg-hover)' : 'transparent',
            borderBottom:
              idx < items.length - 1
                ? '1px solid var(--border-primary)'
                : 'none',
            borderLeft:
              idx === selectedIndex
                ? '3px solid var(--accent-primary, #0066cc)'
                : '3px solid transparent',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          {(renderIcon || item.icon) &&
            (renderIcon ? (
              renderIcon(item)
            ) : (
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  background: 'var(--color-primary)',
                  color: 'var(--bg-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: item.isCustomIcon ? '18px' : '13px',
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {item.icon}
              </div>
            ))}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontWeight: 600,
                marginBottom: item.description ? '4px' : '0',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span>{item.title}</span>
              {item.isActive && (
                <span
                  style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '12px',
                    background: 'var(--accent-primary)',
                    color: 'white',
                    fontWeight: 500,
                  }}
                >
                  active
                </span>
              )}
              {item.badge && (
                <span
                  style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '12px',
                    background: 'var(--accent-primary)',
                    color: 'white',
                    fontWeight: 500,
                  }}
                >
                  {item.badge}
                </span>
              )}
            </div>
            {item.description && (
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                {item.description}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
