// Loaded with `node --import` ahead of the real query-google-play-release.mjs
// entry point. It replaces GoogleAuth#getClient with a fake Android Publisher
// client chosen by PLAY_FAKE_SCENARIO, so the CLI's own argument handling,
// stdout/stderr split and exit status run unchanged. Errors use the shapes
// gaxios 7 rejects with (`status` plus a `response` carrying `Headers`).
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/package.json`);
const { GoogleAuth } = require('google-auth-library');

const scenario = process.env.PLAY_FAKE_SCENARIO;
const versionCode = 242801;
const versionName = '0.1.3-nightly.242801';
const httpError = (status) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    status,
    code: String(status),
    response: { status, headers: new Headers() },
  });

let creates = 0;
const client = {
  getAccessToken: async () => ({ token: 'fake-token' }),
  request: async (request) => {
    if (request.method === 'POST') {
      creates += 1;
      if (scenario === 'forbidden') throw httpError(403);
      if (scenario === 'unavailable-once' && creates === 1)
        throw httpError(503);
      return { data: { id: `edit-${creates}` } };
    }
    if (request.method === 'DELETE') {
      if (scenario === 'cleanup-fails') throw httpError(500);
      return { data: {} };
    }
    if (request.url.endsWith('/tracks/internal'))
      return {
        data: {
          releases: [
            {
              name: versionName,
              status: 'completed',
              versionCodes: [String(versionCode)],
            },
          ],
        },
      };
    return { data: { bundles: [{ versionCode, sha256: 'a'.repeat(64) }] } };
  },
};
GoogleAuth.prototype.getClient = async () => client;
