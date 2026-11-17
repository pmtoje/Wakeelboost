import { loadEnv } from "./load-env";
loadEnv();
import { closePool } from "../src/server/db";
import { reencryptFields } from "../src/server/security-maintenance";

/**
 * Key rotation for encrypted fields (BVN, TIN, director BVNs, raw bureau responses).
 *  1. Generate a new 32-byte key. Set it as FIELD_ENCRYPTION_KEY and move the old key into
 *     FIELD_ENCRYPTION_KEYS_PREVIOUS (comma-separated). Restart the app: it reads both.
 *  2. Run `npm run security:reencrypt` (safe to re-run; rows already under the new key are skipped).
 *  3. Remove the old key from FIELD_ENCRYPTION_KEYS_PREVIOUS and restart.
 */
reencryptFields()
  .then((r) => {
    for (const [col, n] of Object.entries(r)) console.log(`${col.padEnd(34)} ${n} re-encrypted`);
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
