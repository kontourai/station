import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from 'react';

/** A different Station/account never renders the previous partition's draft. */
export function useProjectDraftState<T>(
  initial: T,
  partition?: string,
): [T, Dispatch<SetStateAction<T>>] {
  const livePartition = useRef(partition);
  livePartition.current = partition;
  const [state, setState] = useState(() => ({ partition, value: initial }));
  const value = state.partition === partition ? state.value : initial;
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      if (livePartition.current !== partition) return;
      setState((current) => {
        const previous =
          current.partition === partition ? current.value : initial;
        const value =
          typeof next === 'function'
            ? (next as (current: T) => T)(previous)
            : next;
        return current.partition === partition &&
          Object.is(current.value, value)
          ? current
          : { partition, value };
      });
    },
    [initial, partition],
  );
  return [value, set];
}
