import { getAuthorityObservation } from '@kontourai/station-sdk/authority-observation';
import { useEngineLoginProfilesQuery } from '@kontourai/station-sdk/device-code-login';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Button } from '../components/Button';
import { Empty, SkeletonBlock } from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { CredentialProfileDeviceCodeLogin } from './CredentialProfileDeviceCodeLogin';

export function CredentialProfileAccess({
  connectionId,
  children,
  managementOnly = false,
}: {
  connectionId: string;
  children: ReactNode;
  managementOnly?: boolean;
}) {
  const requestScope = useHostRequestAuthorityScope();
  const authority = useQuery({
    queryKey: [
      'engine-profile-authority',
      requestScope?.apiBase,
      requestScope?.authorityKey,
    ],
    queryFn: ({ signal }) => {
      if (!requestScope)
        throw new Error('Station request scope is unavailable.');
      return getAuthorityObservation(requestScope.apiBase, {
        requestScope,
        signal,
      });
    },
    enabled: !!requestScope,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
  if (!requestScope)
    return <p>Connect to this Station to view sign-in profiles.</p>;
  if (authority.isLoading)
    return <SkeletonBlock count={1} label="Checking profile access" />;
  if (authority.isError || !authority.data)
    return (
      <div>
        <p>Could not check profile access.</p>
        <Button onClick={() => void authority.refetch()}>Retry</Button>
      </div>
    );
  const grant = authority.data.grant;
  if (
    grant.kind === 'operator' ||
    (grant.kind === 'device' && grant.grantedScopes.includes('access:manage'))
  )
    return children;
  if (managementOnly) return null;
  if (grant.kind === 'device' && grant.grantedScopes.includes('engine:login'))
    return (
      <LoginProfiles connectionId={connectionId} requestScope={requestScope} />
    );
  return <p>Manage credential entries on the Station.</p>;
}

function LoginProfiles({
  connectionId,
  requestScope,
}: {
  connectionId: string;
  requestScope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const query = useEngineLoginProfilesQuery(connectionId, requestScope);
  if (query.isLoading)
    return <SkeletonBlock count={1} label="Loading sign-in profiles" />;
  if (query.isError || !query.data)
    return (
      <div>
        <p>Could not load sign-in profiles.</p>
        <Button onClick={() => void query.refetch()}>Retry</Button>
      </div>
    );
  return (
    <section aria-label="Sign-in profiles">
      <h3>Sign-in profiles</h3>
      {query.data.profiles.length === 0 && (
        <Empty
          label="Add a sign-in profile on the Station."
          variant="compact"
        />
      )}
      {query.data.profiles.map((profile) => (
        <div key={profile.ref}>
          <h4>{profile.label || profile.ref}</h4>
          <p>
            {profile.authState === 'authenticated'
              ? 'Signed in'
              : profile.authState === 'unauthenticated'
                ? 'Signed out'
                : 'Sign-in status unknown'}
          </p>
          {profile.mechanisms.includes('device-code') ? (
            <CredentialProfileDeviceCodeLogin
              connectionId={connectionId}
              profileRef={profile.ref}
              authState={profile.authState}
              onCompleted={() => void query.refetch()}
            />
          ) : (
            <p>Sign in on the Station.</p>
          )}
        </div>
      ))}
    </section>
  );
}
