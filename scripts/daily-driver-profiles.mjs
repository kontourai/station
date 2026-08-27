/**
 * Provider-neutral qualification inputs. Scenario execution must consume these
 * declarations; it must not branch on a profile id or engine name.
 */
export const DAILY_DRIVER_PROFILES = Object.freeze([
  {
    id: 'codex-default',
    engine: 'codex',
    modelSelector: 'connection-default',
    exposedParameters: ['model', 'reasoningEffort'],
    requiredCapabilities: [
      'exact-confirmation',
      'bounded-self-change',
      'liveness-settlement',
      'transcript-stability',
      'conversation-agreement',
      'agent-engine-handoff',
      'project-isolation',
      'image-attachment',
      'performance-stress',
    ],
    optionalCapabilities: [],
    availability: {
      deterministicHarness: true,
      liveQualification: false,
      liveReasonCode: 'LIVE_QUALIFICATION_NOT_REQUESTED',
    },
  },
  {
    id: 'claude-default',
    engine: 'claude',
    modelSelector: 'connection-default',
    exposedParameters: ['model', 'effort'],
    requiredCapabilities: [
      'exact-confirmation',
      'bounded-self-change',
      'liveness-settlement',
      'transcript-stability',
      'conversation-agreement',
      'agent-engine-handoff',
      'project-isolation',
      'image-attachment',
      'performance-stress',
    ],
    optionalCapabilities: [],
    availability: {
      deterministicHarness: true,
      liveQualification: false,
      liveReasonCode: 'LIVE_QUALIFICATION_NOT_REQUESTED',
    },
  },
]);

export const DAILY_DRIVER_SCENARIOS = Object.freeze([
  { id: 'exact-confirmation', capability: 'exact-confirmation' },
  { id: 'bounded-self-change', capability: 'bounded-self-change' },
  { id: 'liveness-settlement', capability: 'liveness-settlement' },
  { id: 'transcript-stability', capability: 'transcript-stability' },
  { id: 'conversation-agreement', capability: 'conversation-agreement' },
  { id: 'agent-engine-handoff', capability: 'agent-engine-handoff' },
  { id: 'project-isolation', capability: 'project-isolation' },
  { id: 'image-attachment', capability: 'image-attachment' },
  { id: 'performance-stress', capability: 'performance-stress' },
]);
