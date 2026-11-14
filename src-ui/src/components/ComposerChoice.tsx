import {
  type ComponentProps,
  type ReactNode,
  useContext,
  useId,
  useLayoutEffect,
} from 'react';
import { ComposerChoiceSummary } from './ComposerChoiceSummary';
import { ArrowDownGlyph } from './icons/Glyph';
import './ComposerChoice.css';

type ComposerChoiceProps = Omit<
  ComponentProps<'button'>,
  'children' | 'type' | 'value'
> & {
  'aria-label': string;
  caption: ReactNode;
  value: ReactNode;
  icon?: ReactNode;
  valueClassName?: string;
  safetyLabel?: string;
  changedForConversation?: boolean;
};

/** Shared presentation; the caller owns the selected value and picker. */
export function ComposerChoice({
  caption,
  safetyLabel,
  changedForConversation,
  value,
  icon,
  valueClassName,
  className = '',
  ...props
}: ComposerChoiceProps) {
  const publish = useContext(ComposerChoiceSummary);
  const id = useId();
  const label = props['aria-label'];
  useLayoutEffect(() => {
    publish?.(id, label, safetyLabel, changedForConversation);
    return () => publish?.(id, undefined);
  }, [publish, id, label, safetyLabel, changedForConversation]);
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
        {caption && <span className="chat-input__chip-caption">{caption}</span>}{' '}
        <span className={`composer-choice__value ${valueClassName ?? ''}`}>
          {value}
        </span>
      </span>
      <ArrowDownGlyph className="choice-caret" />
    </button>
  );
}
