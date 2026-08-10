// Resolves `server-only` to nothing for the worker process.
//
// The real package throws on import unless Next's bundler has marked the
// graph as server-side. That guard is worth keeping — it is what stops a
// module holding the service-role key from being pulled into a client
// bundle — but the worker is a plain Node process that legitimately imports
// those same modules, and there is no bundler to satisfy.
//
// So the marker is aliased away for this one entry point, via
// tsconfig.worker.json, rather than removed from the source.
export {}
