import { useCallback } from 'react';
import {
  type RowProjectMarks,
  rowProjectMarks,
} from '../components/inbox-row/row-project-marks';
import type { HomeWorkItem } from '../views/home/home-view-model';
import { useProjectAccents } from './useProjectAccents';
import { useProjectIcons } from './useProjectIcons';

/**
 * `rowProjectMarks` bound to the shared accent and icon maps, for a surface
 * that renders work rows itself rather than receiving the maps from a parent
 * (the dock and Home thread them as props).
 */
export function useRowProjectMarks(): (
  item: Pick<HomeWorkItem, 'projectSlug' | 'environmentId'>,
) => RowProjectMarks {
  const accentBySlug = useProjectAccents();
  const iconBySlug = useProjectIcons();
  return useCallback(
    (item) => rowProjectMarks(item, accentBySlug, iconBySlug),
    [accentBySlug, iconBySlug],
  );
}
