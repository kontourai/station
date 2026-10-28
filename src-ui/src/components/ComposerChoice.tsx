import type { ComponentProps, ReactNode } from 'react';
import { ArrowDownGlyph } from './icons/Glyph';
import './ComposerChoice.css';

type ComposerChoiceProps = Omit<
  ComponentProps<'button'>,
  'children' | 'type'
> & {
  'aria-label': string;
  caption: ReactNode;
  value: ReactNode;
  icon?: ReactNode;
  valueClassName?: string;
};

/** Shared presentation; the caller owns the selected value and picker. */
export function ComposerChoice({
  caption,
  value,
  icon,
  valueClassName,
  className = '',
  ...props
}: ComposerChoiceProps) {
  return (
    <button
      type="button"
      {...props}
      className={`choice-trigger composer-choice ${className}`}
    >
      {icon && (
        <span className="composer-choice__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="chat-input__chip-stack" aria-hidden="true">
        <span className="chat-input__chip-caption">{caption}</span>
        <span className={`composer-choice__value ${valueClassName ?? ''}`}>
          {value}
        </span>
      </span>
      <ArrowDownGlyph className="choice-caret" />
    </button>
  );
}
