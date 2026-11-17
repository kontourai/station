import {
  type ComponentProps,
  type ReactNode,
  useContext,
  useId,
  useLayoutEffect,
} from 'react';
import {
  ComposerChoiceSummary,
  ComposerRunSetupClose,
} from './ComposerChoiceSummary';
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
  /** Text after the label that stays whole while the label gives way. */
  notice?: ReactNode;
  valueClassName?: string;
  safetyLabel?: string;
  changedForConversation?: boolean;
  /** Close the Run setup panel this choice sits in when it is chosen. */
  closesRunSetup?: boolean;
};

/** Shared presentation; the caller owns the selected value and picker. */
export function ComposerChoice({
  caption,
  safetyLabel,
  changedForConversation,
  value,
  icon,
  notice,
  valueClassName,
  className = '',
  closesRunSetup = false,
  ...props
}: ComposerChoiceProps) {
  const publish = useContext(ComposerChoiceSummary);
  const closeRunSetup = useContext(ComposerRunSetupClose);
  const { onClick } = props;
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
      onClick={
        onClick && closesRunSetup
          ? (event) => {
              closeRunSetup?.();
              onClick(event);
            }
          : onClick
      }
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
      {notice}
      {/* The same mark the closed Run setup trigger carries, so the open
          panel shows which choice raised it. Outside the value, so the
          visible label (and its Label-in-Name match) stays the value alone. */}
      {safetyLabel && (
        <span
          className="composer-choice__safety"
          aria-hidden="true"
          title={safetyLabel}
        >
          ⚠
        </span>
      )}
      <ArrowDownGlyph className="choice-caret" />
    </button>
  );
}
