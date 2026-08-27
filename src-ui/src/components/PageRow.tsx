import type { ReactNode } from 'react';

interface PageRowProps {
  label?: ReactNode;
  title?: ReactNode;
  id?: string;
  'data-catalog-id'?: string;
  description?: ReactNode;
  status?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** A domain-neutral label/description/status/control alignment primitive. */
export function PageRow({
  label,
  title,
  id,
  'data-catalog-id': catalogId,
  description,
  status,
  control,
  children,
  className,
}: PageRowProps) {
  return (
    <div
      id={id}
      data-catalog-id={catalogId}
      tabIndex={catalogId ? -1 : undefined}
      className={`page-row${className ? ` ${className}` : ''}`}
    >
      <div className="page-row__content">
        <div className="page-row__label">{title ?? label}</div>
        {description && (
          <div className="page-row__description">{description}</div>
        )}
        {children}
      </div>
      {(status || control) && (
        <div className="page-row__aside">
          {status && <div className="page-row__status">{status}</div>}
          {control && <div className="page-row__control">{control}</div>}
        </div>
      )}
    </div>
  );
}
