import type { ElementType, ReactNode } from 'react';

interface PageSectionProps {
  id?: string;
  eyebrow?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  headingAs?: ElementType;
  tone?: 'default' | 'danger';
}

function classes(...values: Array<string | false | undefined>) {
  return values.filter(Boolean).join(' ');
}

/** A domain-neutral boundary for a bounded group of page content. */
export function PageSection({
  id,
  eyebrow,
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  headingAs: Heading = 'h2',
  tone = 'default',
}: PageSectionProps) {
  const hasHeader = eyebrow || title || description || actions;

  return (
    <section
      id={id}
      className={classes(
        'page-section',
        tone === 'danger' && 'page-section--danger',
        className,
      )}
      data-page-section
      tabIndex={-1}
    >
      {hasHeader && (
        <div className="page-section__header">
          <div className="page-section__heading">
            {eyebrow && <div className="page-section__eyebrow">{eyebrow}</div>}
            {title && (
              <Heading className="page-section__title">{title}</Heading>
            )}
            {description && (
              <p className="page-section__description">{description}</p>
            )}
          </div>
          {actions && <div className="page-section__actions">{actions}</div>}
        </div>
      )}
      <div className={classes('page-section__body', bodyClassName)}>
        {children}
      </div>
    </section>
  );
}
