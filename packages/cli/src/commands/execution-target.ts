import {
  type EnvironmentRef,
  environmentId,
} from '@kontourai/station-contracts/execution-target';
import type { ParsedCoreArgs } from './core-api.js';

const RETIRED_EXECUTION_FLAGS = [
  'connection',
  'engine',
  'environment',
] as const;

/**
 * Enforces the public #1418 execution surface before any network request.
 * Connections and engines remain management/Agent-authoring concepts; they
 * are never direct execution selectors.
 */
export function rejectRetiredExecutionSelectors(parsed: ParsedCoreArgs): void {
  for (const name of RETIRED_EXECUTION_FLAGS) {
    if (parsed.flags[name] !== undefined) {
      throw new Error(
        `--${name} is not an execution selector. Choose an Agent and use --on=<environment> to target a saved Environment.`,
      );
    }
  }
}

/** The shared CLI spelling for the canonical ExecutionTarget environment. */
export function executionEnvironment(parsed: ParsedCoreArgs): EnvironmentRef {
  const selected = parsed.flags.on;
  if (selected === undefined) return { kind: 'current' };
  if (typeof selected !== 'string' || !selected.trim()) {
    throw new Error('--on requires a non-empty Environment id.');
  }
  return { kind: 'saved', id: environmentId(selected) };
}
