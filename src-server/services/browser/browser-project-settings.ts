/**
 * Per-Project browser settings (#90 D4): today one permission,
 * `browserEvaluate`, which lets agents run arbitrary JavaScript in the
 * Project's browser pages through the `browser_evaluate` tool. It defaults
 * OFF, and anything unreadable or absent reads as OFF.
 *
 * Stored beside the other per-Project browser state
 * (`<home>/browser/project-settings.json`), keyed by canonical Project ID —
 * NOT on the Project record: `PUT /api/projects/:slug` accepts extra fields
 * and is reachable by agents, so a permission stored there could be granted
 * by the very agent it constrains. Only the browser settings route writes
 * this: for operator or Project-admin standing, and never for a request
 * that is plainly an agent's (see `routes/browser.ts` for what that does and
 * does not exclude — a same-user shell has home possession).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface BrowserProjectSettings {
  browserEvaluate: boolean;
  /** Who last changed a setting (`operator` or `principal:<id>`). */
  updatedBy?: string;
  updatedAt?: string;
}

interface StoreShape {
  version: 1;
  projects: Record<string, BrowserProjectSettings>;
}

const DEFAULTS: BrowserProjectSettings = Object.freeze({
  browserEvaluate: false,
});

export class BrowserProjectSettingsStore {
  private readonly path: string;
  private readonly projects = new Map<string, BrowserProjectSettings>();

  constructor(
    private readonly stationHome: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(stationHome, 'browser', 'project-settings.json');
    this.load();
  }

  get(projectId: string): BrowserProjectSettings {
    return { ...(this.projects.get(projectId) ?? DEFAULTS) };
  }

  /** Whether agents may evaluate JavaScript in this Project's browser. */
  evaluateAllowed(projectId: string): boolean {
    return this.projects.get(projectId)?.browserEvaluate === true;
  }

  setBrowserEvaluate(
    projectId: string,
    enabled: boolean,
    updatedBy: string,
  ): BrowserProjectSettings {
    const next: BrowserProjectSettings = {
      ...(this.projects.get(projectId) ?? DEFAULTS),
      browserEvaluate: enabled === true,
      updatedBy,
      updatedAt: this.now().toISOString(),
    };
    this.projects.set(projectId, next);
    this.persist();
    return { ...next };
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoreShape;
      if (parsed?.version !== 1) return;
      for (const [projectId, settings] of Object.entries(
        parsed.projects ?? {},
      )) {
        // Only a literal `true` enables anything.
        this.projects.set(projectId, {
          browserEvaluate: settings?.browserEvaluate === true,
          ...(typeof settings?.updatedBy === 'string'
            ? { updatedBy: settings.updatedBy }
            : {}),
          ...(typeof settings?.updatedAt === 'string'
            ? { updatedAt: settings.updatedAt }
            : {}),
        });
      }
    } catch {
      // An unreadable store grants nothing: every permission reads as off.
    }
  }

  private persist(): void {
    const store: StoreShape = {
      version: 1,
      projects: Object.fromEntries(this.projects),
    };
    mkdirSync(join(this.stationHome, 'browser'), {
      recursive: true,
      mode: 0o700,
    });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
