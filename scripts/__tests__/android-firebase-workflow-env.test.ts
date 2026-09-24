import { readdirSync, readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// The agent-activity plugin's Gradle build takes Firebase identity from four
// environment variables and fails on a partial set, so every job that builds
// the Android app must pass all four, each from its own repository variable,
// and name the Firebase app registered for the package that job builds.

type Step = { name?: string; env?: Record<string, string>; run?: string };
type Job = { env?: Record<string, string>; steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

const WORKFLOWS = '.github/workflows';
const SHARED = {
  STATION_FIREBASE_API_KEY: '${{ vars.STATION_FIREBASE_API_KEY }}',
  STATION_FIREBASE_PROJECT_ID: '${{ vars.STATION_FIREBASE_PROJECT_ID }}',
  STATION_FIREBASE_SENDER_ID: '${{ vars.STATION_FIREBASE_SENDER_ID }}',
};
const BUILDS_ANDROID = (step: Step) =>
  /tauri android build|npm run build:android/.test(step.run ?? '');

function job(file: string, name: string): Job {
  const workflow = load(
    readFileSync(`${WORKFLOWS}/${file}`, 'utf8'),
  ) as Workflow;
  const found = workflow.jobs?.[name];
  if (!found) throw new Error(`${file} has no job ${name}`);
  return found;
}

describe('Android build jobs carry the Firebase client identity', () => {
  it.each([
    [
      'build-android.yml',
      'build-android-verification',
      'STATION_FIREBASE_APP_ID_DEBUG',
    ],
    [
      'nightly-native-stage.yml',
      'stage-android',
      'STATION_FIREBASE_APP_ID_NIGHTLY',
    ],
  ])('%s %s uses its channel app', (file, name, appIdVariable) => {
    const { env = {}, steps = [] } = job(file, name);
    expect(steps.some(BUILDS_ANDROID)).toBe(true);
    expect(env).toMatchObject({
      ...SHARED,
      STATION_FIREBASE_APP_ID: `\${{ vars.${appIdVariable} }}`,
    });
  });

  it('release chooses the beta or stable app explicitly before building', () => {
    const { env = {}, steps = [] } = job('release.yml', 'android');
    expect(env).toMatchObject(SHARED);
    // No expression fallback in the job env: the step below decides.
    expect(env.STATION_FIREBASE_APP_ID).toBeUndefined();

    const selectIndex = steps.findIndex(
      (step) => step.name === "Select the channel's Firebase app",
    );
    const buildIndex = steps.findIndex(BUILDS_ANDROID);
    expect(selectIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(selectIndex);

    const select = steps[selectIndex];
    expect(select.env).toMatchObject({
      FIREBASE_APP_ID_BETA: '${{ vars.STATION_FIREBASE_APP_ID_BETA }}',
      FIREBASE_APP_ID_STABLE: '${{ vars.STATION_FIREBASE_APP_ID_STABLE }}',
    });
    const run = select.run ?? '';
    expect(run).toContain(
      'if [ "$RELEASE_CHANNEL" = preview ]; then app_id="$FIREBASE_APP_ID_BETA"; else app_id="$FIREBASE_APP_ID_STABLE"; fi',
    );
    expect(run).toMatch(/-z "\$app_id" \]; then[\s\S]*exit 1/);
    expect(run).toContain(
      'echo "STATION_FIREBASE_APP_ID=$app_id" >> "$GITHUB_ENV"',
    );
  });

  it('covers every workflow job that builds the Android app', () => {
    const covered = new Set([
      'build-android.yml#build-android-verification',
      'nightly-native-stage.yml#stage-android',
      'release.yml#android',
    ]);
    const building: string[] = [];
    for (const file of readdirSync(WORKFLOWS).filter((f) =>
      /\.ya?ml$/.test(f),
    )) {
      const workflow = load(
        readFileSync(`${WORKFLOWS}/${file}`, 'utf8'),
      ) as Workflow;
      for (const [name, definition] of Object.entries(workflow.jobs ?? {})) {
        if (definition.steps?.some(BUILDS_ANDROID))
          building.push(`${file}#${name}`);
      }
    }
    expect(building.sort()).toEqual([...covered].sort());
  });
});
