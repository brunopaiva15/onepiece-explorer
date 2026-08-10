// Stub for the `server-only` marker package.
//
// In a Next.js build it throws if a server module is pulled into a client
// bundle. Under Vitest we import those modules directly in Node on purpose,
// so the marker resolves to nothing here. The build-time guard is unaffected.
export {}
