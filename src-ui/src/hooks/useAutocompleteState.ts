import { useCallback, useState } from 'react';

export function useAutocompleteState() {
  const [commandQuery, setCommandQuery] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState<string | null>(null);

  const updateFromInput = useCallback((value: string) => {
    if (value.startsWith('/model ')) {
      setModelQuery(value.slice(7));
      setCommandQuery(null);
    } else if (value.startsWith('/') && !value.includes(' ')) {
      setCommandQuery(value.slice(1));
      setModelQuery(null);
    } else {
      setCommandQuery(null);
      setModelQuery(null);
    }
  }, []);

  const closeAll = useCallback(() => {
    setCommandQuery(null);
    setModelQuery(null);
  }, []);

  // Called when input is programmatically cleared (not via onChange)
  const onInputCleared = useCallback(() => {
    closeAll();
  }, [closeAll]);

  return {
    commandQuery,
    modelQuery,
    updateFromInput,
    closeCommand: () => setCommandQuery(null),
    closeModel: () => setModelQuery(null),
    openModel: () => setModelQuery(''),
    closeAll,
    onInputCleared,
  };
}
