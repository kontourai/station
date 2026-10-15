import { useLayoutEffect } from 'react';
import { retainInitialStartup } from '../lib/startup-presentation';
import { SkeletonBlock } from './state';

export function StartupScreen({ message }: { message?: string }) {
  useLayoutEffect(
    () => retainInitialStartup(message ?? 'Preparing Station'),
    [message],
  );
  return <SkeletonBlock label={message ?? 'Preparing Station'} />;
}
