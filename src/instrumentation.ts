/**
 * Runs once when the Next.js server starts. The production configuration checks run here so a
 * misconfigured server exits instead of serving requests with safeguards switched off.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertProductionConfig } = await import("./server/config");
  try {
    assertProductionConfig();
    // Record (and load) whether SeedFi has been activated, so the credit check fails closed from then on.
    const { refreshSeedfiActivation } = await import("./server/domain/credit-check");
    await refreshSeedfiActivation().catch((e) => {
      if (process.env.APP_ENV === "production") throw e;
      console.warn("[startup] Could not read SeedFi activation:", e instanceof Error ? e.message : e);
    });
  } catch (e) {
    console.error(`[startup] Refusing to start: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
