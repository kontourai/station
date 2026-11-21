import type { ReactNode } from 'react';

export function ComposerMessageField({ children }: { children: ReactNode }) {
  return (
    <fieldset
      className="chat-input__textarea-wrapper"
      aria-label="Message composer"
      tabIndex={-1}
    >
      {children}
    </fieldset>
  );
}
