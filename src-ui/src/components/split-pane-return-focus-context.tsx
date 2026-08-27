import { captureReturnFocus } from '@kontourai/station-shared/return-focus';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
} from 'react';

type ReturnFocusChain = HTMLElement[];

interface SplitPaneExternalReturnFocusValue {
  captureExternalReturnFocus: (opener: HTMLElement | null) => void;
  takeExternalReturnFocus: () => ReturnFocusChain;
}

const SplitPaneExternalReturnFocusContext =
  createContext<SplitPaneExternalReturnFocusValue | null>(null);

/**
 * One surface-scoped handoff for an opener rendered outside a split pane.
 * Callers choose the provider boundary, so leaving that surface discards its
 * unconsumed return intent without a global store.
 */
export function SplitPaneReturnFocusProvider({
  children,
}: {
  children: ReactNode;
}) {
  const returnFocusRef = useRef<ReturnFocusChain>([]);
  const captureExternalReturnFocus = useCallback(
    (opener: HTMLElement | null) => {
      returnFocusRef.current = captureReturnFocus(opener);
    },
    [],
  );
  const takeExternalReturnFocus = useCallback(() => {
    const chain = returnFocusRef.current;
    returnFocusRef.current = [];
    return chain;
  }, []);
  const value = useMemo(
    () => ({ captureExternalReturnFocus, takeExternalReturnFocus }),
    [captureExternalReturnFocus, takeExternalReturnFocus],
  );
  return (
    <SplitPaneExternalReturnFocusContext.Provider value={value}>
      {children}
    </SplitPaneExternalReturnFocusContext.Provider>
  );
}

export function useSplitPaneExternalReturnFocus(): SplitPaneExternalReturnFocusValue | null {
  return useContext(SplitPaneExternalReturnFocusContext);
}
