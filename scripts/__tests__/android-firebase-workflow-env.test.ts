import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// The agent-activity plugin's Gradle build takes Firebase identity from four
// environment variables and fails on a partial set, so every job that builds
// the Android app must pass all four, and each job must name the Firebase app
// registered for the package it builds.
const FIREBASE_KEYS = [
  'STATION_FIREBASE_API_KEY',
  'STATION_FIREBASE_PROJECT_ID',
  'STATION_FIREBASE_SENDER_ID',
  'STATION_FIREBASE_APP_ID',
] as const;

const ANDROID_JOBS: Array<[string, string, string[]]> = [
  [
    '.github/workflows/build-android.yml',
    'build-android-verification',
    ['STATION_FIREBASE_APP_ID_DEBUG'],
  ],
  [
    '.github/workflows/nightly-native-stage.yml',
    'stage-android',
    ['STATION_FIREBASE_APP_ID_NIGHTLY'],
  ],
  [
    '.github/workflows/release.yml',
    'android',
    ['STATION_FIREBASE_APP_ID_BETA', 'STATION_FIREBASE_APP_ID_STABLE'],
  ],
];

type Workflow = {
  jobs: Record<
    string,
    { env?: Record<string, string>; steps?: Array<{ run?: string }> }
  >;
};

function job(path: string, name: string) {
  const workflow = load(readFileSync(path, 'utf8')) as Workflow;
  const found = workflow.jobs[name];
  if (!found) throw new Error(`${path} has no job ${name}`);
  return found;
}

describe('Android build jobs carry the Firebase client identity', () => {
  it.each(ANDROID_JOBS)('%s %s', (path, name, appIdVariables) => {
    const { env = {}, steps = [] } = job(path, name);
    // Guard the premise: the job must still be the one that builds Android.
    expect(
      steps.some((step) => step.run?.includes('tauri android build')),
    ).toBe(true);
    for (const key of FIREBASE_KEYS) {
      expect(env[key], key).toMatch(/\$\{\{\s*.*vars\./);
    }
    for (const variable of appIdVariables) {
      expect(env.STATION_FIREBASE_APP_ID).toContain(`vars.${variable}`);
    }
  });

  it('covers every workflow step that builds the Android app', () => {
    const covered = new Set(
      ANDROID_JOBS.map(([path, name]) => `${path}#${name}`),
    );
    for (const path of [
      '.github/workflows/build-android.yml',
      '.github/workflows/nightly-native-stage.yml',
      '.github/workflows/release.yml',
    ]) {
      const workflow = load(readFileSync(path, 'utf8')) as Workflow;
      for (const [name, definition] of Object.entries(workflow.jobs)) {
        if (
          definition.steps?.some((step) =>
            step.run?.includes('tauri android build'),
          )
        ) {
          expect(covered.has(`${path}#${name}`), `${path}#${name}`).toBe(true);
        }
      }
    }
  });
});
