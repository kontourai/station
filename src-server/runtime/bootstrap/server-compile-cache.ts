import 'dotenv/config';

// Node consumes the cache setting at process startup. Load .env first so it
// cannot restore that setting after deletion; Node's active cache survives.
// This is the first server import, but external ESM dependencies can evaluate
// before bundled bootstrap code.
delete process.env.NODE_COMPILE_CACHE;
