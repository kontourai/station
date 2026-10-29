import { useLayoutEffect } from 'react';
import {
  commitInitialStartup,
  dismissInitialStartup,
} from '../lib/startup-presentation';

export function StartupHandoff({ recovery = false }: { recovery?: boolean }) {
  useLayoutEffect(() => {
    if (recovery) dismissInitialStartup();
    else commitInitialStartup();
  }, [recovery]);
  return null;
}
