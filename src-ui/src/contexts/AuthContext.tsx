import { useConnections } from '@kontourai/station-connect';
import type { AuthStatus as ContractAuthStatus } from '@kontourai/station-contracts/auth';
import { MS_PER_MINUTE } from '@kontourai/station-contracts/time';
import {
  useAuthStatusQuery,
  useRenewAuthMutation,
} from '@kontourai/station-sdk';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type AuthStatus = ContractAuthStatus['status'] | 'loading';

interface AuthState {
  status: AuthStatus;
  expiresAt: Date | null;
  provider: string;
  user: {
    alias: string;
    profileUrl?: string;
    name?: string;
    title?: string;
    email?: string;
  } | null;
  renew: () => Promise<void>;
  isRenewing: boolean;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

/**
 * The expiry we already hold, unless the server named a different instant.
 *
 * station#3796: `setExpiresAt(new Date(...))` on every poll manufactured a
 * new identity once a minute even when nothing about the session had
 * changed. Status, provider and user all bail out of `setState` on their own
 * (primitives, and TanStack's structural sharing for `user`), so this Date
 * was the sole reason the whole app-wide auth context was republished every
 * 60 seconds. `Object.is` on the epoch keeps the previous object for an
 * unparseable value too, rather than churning on NaN.
 */
function retainedExpiry(
  previous: Date | null,
  next: string | null | undefined,
): Date | null {
  if (!next) return previous === null ? previous : null;
  const parsed = new Date(next);
  return previous && Object.is(previous.getTime(), parsed.getTime())
    ? previous
    : parsed;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [provider, setProvider] = useState<string>('');
  const [user, setUser] = useState<{ alias: string } | null>(null);
  const [isRenewing, setIsRenewing] = useState(false);
  const { data, error, refetch: refreshAuthStatus } = useAuthStatusQuery();
  const renewAuthMutation = useRenewAuthMutation();
  const { activeConnection } = useConnections();
  const connectionEvidence = `${activeConnection?.id ?? ''}:${activeConnection?.lastSuccessAt ?? ''}:${activeConnection?.credentialState ?? ''}`;
  const previousConnectionEvidence = useRef(connectionEvidence);

  const checkStatus = useCallback(async () => {
    try {
      const result = await refreshAuthStatus();
      const authStatus = result.data;
      if (!authStatus) {
        throw result.error ?? new Error('Missing auth status');
      }
      setStatus(authStatus.status);
      setProvider(authStatus.provider);
      setExpiresAt((previous) =>
        retainedExpiry(previous, authStatus.expiresAt),
      );
      setUser(authStatus.user ?? null);
    } catch {
      setStatus('missing');
    }
  }, [refreshAuthStatus]);

  // `renewAuthMutation` itself is a fresh object every render (TanStack
  // returns a new result object); `mutateAsync` is the stable handle, so
  // depending on it is what makes `renew` — and the context value below —
  // hold their identity (station#3796).
  const renewAsync = renewAuthMutation.mutateAsync;
  const renew = useCallback(async () => {
    setIsRenewing(true);
    try {
      await renewAsync();
      setTimeout(() => {
        void checkStatus();
      }, 3000);
    } catch {
      /* ignore */
    } finally {
      setIsRenewing(false);
    }
  }, [checkStatus, renewAsync]);

  useEffect(() => {
    if (data) {
      setStatus(data.status);
      setProvider(data.provider);
      setExpiresAt((previous) => retainedExpiry(previous, data.expiresAt));
      setUser(data.user ?? null);
      return;
    }
    if (error) {
      setStatus('missing');
    }
  }, [data, error]);

  useEffect(() => {
    void checkStatus();
    const interval = setInterval(checkStatus, MS_PER_MINUTE);
    return () => clearInterval(interval);
  }, [checkStatus]);

  useEffect(() => {
    if (previousConnectionEvidence.current === connectionEvidence) return;
    previousConnectionEvidence.current = connectionEvidence;
    void checkStatus();
  }, [checkStatus, connectionEvidence]);

  const value = useMemo(
    () => ({ status, expiresAt, provider, user, renew, isRenewing }),
    [status, expiresAt, provider, user, renew, isRenewing],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
