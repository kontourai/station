// Node consumes this setting at process startup. Its active compile cache
// survives deletion; descendants must not inherit the server-owned directory.
// Keep this the first server-entry import, before dependencies can spawn.
delete process.env.NODE_COMPILE_CACHE;
