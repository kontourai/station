import { useConnections } from '@kontourai/station-connect';
import type { WorkspacePaneAvailabilityInput } from '@kontourai/station-contracts/workspace-pane-availability';
import {
  getDeploymentCapabilityState,
  type ServerCapabilities,
  useServerCapabilitiesQuery,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useState } from 'react';
import type {
  NativeCapabilityId,
  NativeCapabilityStatus,
} from '../platform/native';
import { nativePlatformPromise } from '../platform/native';
import { usePlatformProfile } from '../platform/PlatformProfileContext';

type PaneCapability = NonNullable<
  NonNullable<WorkspacePaneAvailabilityInput['host']>['capabilities']
>[string];
type CapabilityFacts = NonNullable<WorkspacePaneAvailabilityInput['host']>;

export type NativeCapabilityReader = Pick<
  Awaited<typeof nativePlatformPromise>,
  'capability'
>;

export interface WorkspacePaneAvailabilityFacts {
  native?: NativeCapabilityReader;
  deployment?: ServerCapabilities;
  /** Exact endpoint provenance, never inferred from a URL string. */
  managedLoopback?: 'present' | 'missing' | 'unknown';
}

/**
 * The pane contract intentionally admits a wider set of names than the
 * native adapter. This is the one explicit mapping between the two vocabularies
 * so descriptor data never imports a host SDK or guesses from a platform name.
 */
const PANE_TO_NATIVE_CAPABILITY: Readonly<
  Record<string, NativeCapabilityId | undefined>
> = {
  'local-browser-preview': 'local-browser-preview',
};

function mergeCapabilityFacts(
  current: CapabilityFacts | undefined,
  patch: CapabilityFacts | undefined,
): CapabilityFacts | undefined {
  const state = patch?.state ?? current?.state;
  if (!state) return undefined;
  const capabilities = {
    ...current?.capabilities,
    ...patch?.capabilities,
  };
  return {
    state,
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
  };
}

function mergeAvailabilityInput(
  input: WorkspacePaneAvailabilityInput,
  patch: Pick<
    WorkspacePaneAvailabilityInput,
    'host' | 'deployment' | 'configuration' | 'permission'
  >,
): WorkspacePaneAvailabilityInput {
  return {
    ...input,
    ...(patch.configuration === undefined
      ? {}
      : { configuration: patch.configuration }),
    ...(patch.permission === undefined ? {} : { permission: patch.permission }),
    host: mergeCapabilityFacts(input.host, patch.host),
    deployment: mergeCapabilityFacts(input.deployment, patch.deployment),
  };
}

function nativeStateToPaneCapability(
  status: NativeCapabilityStatus | undefined,
): PaneCapability {
  if (status?.reportVerified === false) return 'unknown';
  if (status?.state === 'enabled') return 'supported';
  if (status?.state === 'disabled' || status?.state === 'unsupported') {
    return 'unsupported';
  }
  // A missing report/status is never optimistic. `permission-required` is
  // host support with a distinct consent step, handled below.
  return status?.state === 'permission-required' ? 'supported' : 'unknown';
}

/**
 * Pure translation from injected host and server facts to the portable Pane
 * availability contract. It neither obtains a native report nor reads a host
 * global, so it is equally usable by web, desktop, mobile, and tests.
 */
export function adaptWorkspacePaneAvailabilityInput(
  input: WorkspacePaneAvailabilityInput,
  facts: WorkspacePaneAvailabilityFacts,
): WorkspacePaneAvailabilityInput {
  const hostRequirements = input.requirements?.hostCapabilities ?? [];
  const hostCapabilities: Record<string, PaneCapability> = {};
  let nativePermissionRequired = false;

  for (const requirement of hostRequirements) {
    const nativeId = PANE_TO_NATIVE_CAPABILITY[requirement];
    if (!nativeId) {
      hostCapabilities[requirement] = 'unknown';
      continue;
    }
    const status = facts.native?.capability(nativeId);
    hostCapabilities[requirement] = nativeStateToPaneCapability(status);
    nativePermissionRequired ||= status?.state === 'permission-required';
  }

  const deploymentRequirements =
    input.requirements?.deploymentCapabilities ?? [];
  const deploymentCapabilities: Record<string, PaneCapability> = {};
  for (const requirement of deploymentRequirements) {
    deploymentCapabilities[requirement] = getDeploymentCapabilityState(
      facts.deployment,
      requirement as 'web-push' | 'scheduler',
    );
  }
  const requiresManagedLoopback = hostRequirements.includes(
    'local-browser-preview',
  );

  return mergeAvailabilityInput(input, {
    host:
      hostRequirements.length > 0
        ? {
            state: facts.native ? 'supported' : 'unknown',
            capabilities: hostCapabilities,
          }
        : undefined,
    deployment:
      deploymentRequirements.length > 0
        ? {
            state: facts.deployment ? 'supported' : 'unknown',
            capabilities: deploymentCapabilities,
          }
        : undefined,
    ...(requiresManagedLoopback
      ? { configuration: facts.managedLoopback ?? 'unknown' }
      : {}),
    ...(nativePermissionRequired ? { permission: 'required' as const } : {}),
  });
}

/**
 * Resolves the typed adapter once only after PlatformBootstrap has admitted
 * its children. This calls `capability`, never `getCapabilityReport`, because
 * PlatformBootstrap owns that one native report for profile resolution.
 */
export function useWorkspacePaneAvailabilityFacts(): WorkspacePaneAvailabilityFacts {
  usePlatformProfile();
  const [native, setNative] = useState<NativeCapabilityReader>();
  const deployment = useServerCapabilitiesQuery({ enabled: true }).data;
  const { activeConnection } = useConnections();

  useEffect(() => {
    let active = true;
    void nativePlatformPromise
      .then((adapter) => {
        if (active) setNative(adapter);
      })
      // A missing adapter is represented as unknown by the pure translator.
      .catch(() => {
        if (active) setNative(undefined);
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedEndpoint = activeConnection?.endpoints.find(
    (endpoint) => endpoint.id === activeConnection.selectedEndpointId,
  );
  const managedLoopback = !activeConnection
    ? 'unknown'
    : selectedEndpoint?.kind === 'managed-loopback'
      ? 'present'
      : 'missing';
  // station#3794: this object is a dependency of the resolved-catalog memo,
  // so a fresh literal per render rebuilt `catalog.entries` — and every
  // availability object inside it — on every render of every consumer, which
  // made any `useCallback(..., [catalog.entries])` downstream inert.
  return useMemo(
    () => ({ native, deployment, managedLoopback }),
    [native, deployment, managedLoopback],
  );
}
