import { assertProductionConfig } from "./server/config";
import { refreshSeedfiActivation } from "./server/domain/credit-check";

/** Node.js startup: a misconfigured server exits instead of serving requests with safeguards off. */
async function startupChecks() {
  try {
    assertProductionConfig();
    // Record (and load) whether SeedFi has been activated, so the credit check fails closed from then on.
    await refreshSeedfiActivation().catch((e) => {
      if (process.env.APP_ENV === "production") throw e;
      console.warn("[startup] Could not read SeedFi activation:", e instanceof Error ? e.message : e);
    });
  } catch (e) {
    console.error(`[startup] Refusing to start: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
await startupChecks();
