import { assertProductionConfig } from "./server/config";
import { refreshSeedfiActivation } from "./server/domain/credit-check";
import { assertNoDemoStaff } from "./server/demo/production-guard";
import { upgradeMaterialDigests } from "./server/security-maintenance";

/** Node.js startup: a misconfigured server exits instead of serving requests with safeguards off. */
async function startupChecks() {
  try {
    assertProductionConfig();
    if (process.env.APP_ENV === "production") await assertNoDemoStaff();
    // Replace unkeyed change-detection digests stored before 17 Nov 2026 (idempotent).
    await upgradeMaterialDigests().then((n) => n && console.log(`[startup] Upgraded ${n} stored digest(s) to the keyed form.`)).catch((e) => {
      if (process.env.APP_ENV === "production") throw e;
      console.warn("[startup] Could not upgrade digests:", e instanceof Error ? e.message : e);
    });
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
