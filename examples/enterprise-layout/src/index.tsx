/**
 * Enterprise Layout — Plugin entry point.
 *
 * Exports named components that match the `component` keys in layout.json.
 * Each component is wrapped with the provider context so data hooks work.
 */

import { useEffect, useState } from 'react';
import { Calendar } from './Calendar';
import { CRM } from './CRM';
import { useBackgroundRefresh } from './data';
import { ensureProviders } from './data/init';
import { EnterpriseProvider } from './EnterpriseContext';
import { Notes } from './Notes';
import { Portfolio } from './Portfolio';

function useProviders() {
  const [ready, setReady] = useState(() => ensureProviders());
  useEffect(() => {
    if (!ready) {
      const id = setInterval(() => {
        if (ensureProviders()) {
          setReady(true);
          clearInterval(id);
        }
      }, 100);
      return () => clearInterval(id);
    }
  }, [ready]);
  return ready;
}

function AppShell({ children }: { children: React.ReactNode }) {
  useBackgroundRefresh();
  return <>{children}</>;
}

function withContext(Component: React.ComponentType<Record<string, unknown>>) {
  return (props: Record<string, unknown>) => {
    const ready = useProviders();
    if (!ready) return null;
    return (
      <EnterpriseProvider>
        <AppShell>
          <Component {...props} />
        </AppShell>
      </EnterpriseProvider>
    );
  };
}

export const components = {
  'enterprise-portfolio': withContext(Portfolio),
  'enterprise-calendar': withContext(Calendar),
  'enterprise-crm': withContext(CRM),
  'enterprise-notes': withContext(Notes),
};

export type { ProviderType, ProviderTypeMap } from './data/providerTypes';
export { requiredProviders } from './data/providerTypes';

export default withContext(Portfolio);
