export const DEV_HOME_SEED_MARKER: 'dev-home-seed.json';
export const DROP_CATEGORIES: Readonly<Record<string, string>>;
export const ROOT_DECISIONS: Readonly<Record<string, string>>;
export const ORCHESTRATION_KEEP_TABLES: readonly string[];

export interface DevHomeSeedMarker {
  schema: 'station.dev-home-seed/v1';
  createdAt: string;
  source: string;
  kept: string[];
  dropped: Record<string, string[]>;
  clearedTables: string[];
  skippedLinks: string[];
}

export function seedDevHome(options: {
  source: string;
  target: string;
  force?: boolean;
  now?: Date;
}): DevHomeSeedMarker;
