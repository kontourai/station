/**
 * useMessageContext — returns getComposedContext() from the active
 * context providers. Thin wrapper over MessageContextContext.
 */
import { useMessageContextContext } from '../contexts/MessageContextContext';

export function useMessageContext() {
  const { providers, toggleProvider, getComposedContext } =
    useMessageContextContext();
  return { providers, toggleProvider, getComposedContext };
}
