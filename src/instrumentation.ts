/**
 * Runs once when the Next.js server starts. The production configuration checks (and the SeedFi
 * activation record) live in instrumentation-node.ts, loaded only in the Node.js runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
