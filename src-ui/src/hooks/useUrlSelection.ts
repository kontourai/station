/**
 * useUrlSelection — sync a selected item ID with the URL path.
 *
 * Given a base path like "/agents", reads the selection from
 * the URL (e.g. "/agents/my-agent") and provides setters that
 * update both state and URL together.
 */
import { useCallback, useMemo } from 'react';
import { decodeUrlSelection } from '../app-shell/routing';
import { useNavigation } from '../contexts/NavigationContext';

export function useUrlSelection(basePath: string) {
  const { pathname, navigate } = useNavigation();

  const selectedId = useMemo(() => {
    if (!pathname.startsWith(`${basePath}/`)) return null;
    return decodeUrlSelection(pathname.slice(basePath.length + 1));
  }, [basePath, pathname]);

  const select = useCallback(
    (id: string) => navigate(`${basePath}/${encodeURIComponent(id)}`),
    [basePath, navigate],
  );

  const deselect = useCallback(() => navigate(basePath), [basePath, navigate]);

  return { selectedId, select, deselect };
}
