import 'dotenv/config';
import { consumeStationCompileCacheEnv } from './station-compile-cache.js';

// Node consumes the cache setting at process startup. Load .env first so it
// cannot restore that setting after deletion; Node's active cache survives,
// and only Station's own bundled children are handed it again.
// This is the first server import, but external ESM dependencies can evaluate
// before bundled bootstrap code.
consumeStationCompileCacheEnv();
