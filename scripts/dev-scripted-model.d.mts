import type { Server } from 'node:http';

export type ScriptedModelStep =
  | { text: string }
  | { finish: 'stop' | 'length' }
  | { error: string };

export interface ScriptedModelScenario {
  description: string;
  steps(prompt: string): ScriptedModelStep[];
}

export const SCRIPTED_MODEL_SCENARIOS: Readonly<
  Record<string, ScriptedModelScenario>
>;

export function chunkText(text: string): string[];

export function startScriptedModelServer(options?: {
  port?: number;
  host?: string;
  delayMs?: number;
  scenarios?: Readonly<Record<string, ScriptedModelScenario>>;
}): Promise<{ server: Server; origin: string; close(): Promise<void> }>;
