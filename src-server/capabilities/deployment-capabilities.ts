/**
 * Deployment capability facts describe what the answering Station deployment
 * can provide. They are intentionally separate from `STATION_CAPABILITY_FLAGS`:
 * that registry is build/handshake support, while these facts are an operator
 * or distribution's runtime contract with its clients.
 */
export const DEPLOYMENT_CAPABILITY_IDS = ['web-push', 'scheduler'] as const;

export type DeploymentCapabilityId = (typeof DEPLOYMENT_CAPABILITY_IDS)[number];

export type DeploymentCapabilityState = 'supported' | 'unsupported' | 'unknown';

export interface DeploymentCapability {
  state: DeploymentCapabilityState;
}

export interface DeploymentCapabilities {
  features: Partial<Record<DeploymentCapabilityId, DeploymentCapability>>;
}

const UNKNOWN_DEPLOYMENT_CAPABILITIES: DeploymentCapabilities = {
  features: {
    'web-push': { state: 'unknown' },
    scheduler: { state: 'unknown' },
  },
};

function isDeploymentCapabilityState(
  value: unknown,
): value is DeploymentCapabilityState {
  return (
    value === 'supported' || value === 'unsupported' || value === 'unknown'
  );
}

/**
 * Resolves deployment facts from the optional distribution declaration.
 *
 * `STATION_DEPLOYMENT_CAPABILITIES` is a JSON object whose known keys are
 * `web-push` and `scheduler`, and whose values are `supported`,
 * `unsupported`, or `unknown`. Omitting it is not proof of a particular
 * distribution, so it remains unknown. A malformed declaration also fails
 * closed so newer clients do not start protected work from untrustworthy
 * deployment facts.
 */
export function resolveDeploymentCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentCapabilities {
  const declaration = env.STATION_DEPLOYMENT_CAPABILITIES;
  // The server cannot authenticate a distribution identity from process env.
  // Absence is therefore not capability evidence (including for repackaged
  // deployments), and must not authorize protected client work.
  if (declaration === undefined) return UNKNOWN_DEPLOYMENT_CAPABILITIES;
  const raw = declaration.trim();

  try {
    if (!raw) {
      throw new Error('Deployment capability declaration must not be empty');
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Deployment capability declaration must be an object');
    }

    const declared = parsed as Record<string, unknown>;
    const features: DeploymentCapabilities['features'] = {};
    for (const id of DEPLOYMENT_CAPABILITY_IDS) {
      const state = declared[id];
      features[id] = {
        state: isDeploymentCapabilityState(state) ? state : 'unknown',
      };
    }
    return { features };
  } catch {
    return {
      features: Object.fromEntries(
        DEPLOYMENT_CAPABILITY_IDS.map((id) => [id, { state: 'unknown' }]),
      ) as DeploymentCapabilities['features'],
    };
  }
}
