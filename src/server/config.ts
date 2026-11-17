/**
 * Central configuration, read from environment variables (see .env.example).
 * Values are read lazily so tests can override process.env before first use.
 */
function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}
function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${name}`);
  return n;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (!v) return fallback;
  return v === "true" || v === "1";
}

export type AppEnv = "development" | "test" | "production";

export const config = {
  get appEnv(): AppEnv {
    const v = str("APP_ENV", "development");
    if (v !== "development" && v !== "test" && v !== "production") throw new Error("APP_ENV invalid");
    return v;
  },
  get isProduction() {
    return this.appEnv === "production";
  },
  get appUrl() {
    return str("APP_URL", "http://localhost:3000").replace(/\/$/, "");
  },
  get databaseUrl() {
    return str("DATABASE_URL");
  },
  get fieldKey() {
    return keyFrom("FIELD_ENCRYPTION_KEY");
  },
  get hmacKey() {
    return keyFrom("APP_HMAC_KEY");
  },
  get storageKey() {
    return keyFrom("STORAGE_ENCRYPTION_KEY");
  },
  /** Previous keys still accepted for decryption during a key rotation (comma-separated base64). */
  get previousFieldKeys(): Buffer[] {
    return keyList("FIELD_ENCRYPTION_KEYS_PREVIOUS");
  },
  get previousStorageKeys(): Buffer[] {
    return keyList("STORAGE_ENCRYPTION_KEYS_PREVIOUS");
  },
  get sessionIdleSeconds() {
    return int("SESSION_IDLE_SECONDS", 300);
  },
  get sessionAbsoluteHours() {
    return int("SESSION_ABSOLUTE_HOURS", 12);
  },
  get otpTtlSeconds() {
    return int("OTP_TTL_SECONDS", 300);
  },
  get otpMaxAttempts() {
    return int("OTP_MAX_ATTEMPTS", 5);
  },
  /** Wrong codes, across all codes, after which an account's sign-in locks (rolling 24 hours). */
  get otpLockFailures() {
    return int("OTP_LOCK_FAILURES_PER_24H", 10);
  },
  /** Wrong codes across all accounts in an hour that trigger an alert to Super Admins. */
  get otpGlobalAlertPerHour() {
    return int("OTP_GLOBAL_FAILURE_ALERT_PER_HOUR", 100);
  },
  get otpIssueLimit() {
    return int("OTP_ISSUE_LIMIT_PER_15_MIN", 5);
  },
  get trustedProxyHops() {
    return int("TRUSTED_PROXY_HOPS", 0);
  },
  get cookieSecure() {
    // Always HTTPS-only in production, whatever COOKIE_SECURE says.
    return config.isProduction || bool("COOKIE_SECURE", false);
  },
  get staffEmailDomain() {
    return str("STAFF_EMAIL_DOMAIN", "altbank.ng").toLowerCase();
  },
  get storageDriver() {
    return str("STORAGE_DRIVER", "local") as "local" | "s3";
  },
  get storageLocalDir() {
    return str("STORAGE_LOCAL_DIR", ".data/objects");
  },
  get s3() {
    return {
      bucket: str("S3_BUCKET", ""),
      region: str("S3_REGION", "eu-west-1"),
      endpoint: process.env.S3_ENDPOINT || undefined,
      kmsKeyId: process.env.S3_KMS_KEY_ID || undefined,
      forcePathStyle: bool("S3_FORCE_PATH_STYLE", false),
      serverSideEncryption: str("S3_SERVER_SIDE_ENCRYPTION", "AES256") as "AES256" | "aws:kms" | "none",
    };
  },
  get maxUploadBytes() {
    return int("MAX_UPLOAD_BYTES", 15 * 1024 * 1024);
  },
  get scannerDriver() {
    return str("SCANNER_DRIVER", "dev") as "dev" | "clamd" | "defer";
  },
  get clamd() {
    return { host: str("CLAMD_HOST", "127.0.0.1"), port: int("CLAMD_PORT", 3310) };
  },
  get retentionYears() {
    return int("RETENTION_YEARS", 10);
  },
  get retentionPurgeEnabled() {
    // On by default in production (security review M12); a deliberate RETENTION_PURGE_ENABLED=false logs a warning.
    return bool("RETENTION_PURGE_ENABLED", config.isProduction);
  },
  get mailDriver() {
    return str("MAIL_DRIVER", "resend") as "dev" | "smtp" | "resend";
  },
  get mailFrom() {
    return str("MAIL_FROM", "WakeelBoost Work Desk <noreply@wakeelboost.ng>");
  },
  get smtp() {
    return {
      host: str("SMTP_HOST", ""),
      port: int("SMTP_PORT", 587),
      user: process.env.SMTP_USER || undefined,
      pass: process.env.SMTP_PASS || undefined,
      secure: bool("SMTP_SECURE", false),
    };
  },
  get resend() {
    return {
      apiKey: str("RESEND_API_KEY", ""),
      baseUrl: str("RESEND_BASE_URL", "https://api.resend.com").replace(/\/$/, ""),
      replyTo: process.env.RESEND_REPLY_TO || undefined,
    };
  },
  get closureMaxAttachmentBytes() {
    return int("CLOSURE_MAX_ATTACHMENT_BYTES", 10 * 1024 * 1024);
  },
  get aprCalculator() {
    return str("APR_CALCULATOR", "wakeelboost-pricing@2026.1");
  },
  /**
   * SeedFi Loan Engine (Seed Score). Server-side only. The API key is read from the environment or
   * the secrets manager and is never sent to the browser, logged or stored in the database.
   * Staging: https://stg-loan-engine.theseedfi.com · Production: https://loanengine.theseedfi.com
   */
  get seedfi() {
    const baseUrl = str("SEEDFI_BASE_URL", "").replace(/\/$/, "");
    const apiKey = str("SEEDFI_API_KEY", "");
    // Alternative to an API key: the Altmall SeedFi account sign-in. The app obtains and renews the
    // 30-minute access token itself (login + refresh endpoints), so no key has to be created by hand.
    const username = str("SEEDFI_USERNAME", "");
    const password = str("SEEDFI_PASSWORD", "");
    const accountAuth = !!username && !!password;
    return {
      baseUrl,
      apiKey,
      username,
      password,
      authMode: (apiKey ? "API_KEY" : accountAuth ? "ACCOUNT" : "NONE") as "API_KEY" | "ACCOUNT" | "NONE",
      configured: !!baseUrl && (!!apiKey || accountAuth),
      environment: /\/\/loanengine\.theseedfi\.com/.test(baseUrl) ? "production" : baseUrl ? "staging" : "unconfigured",
      timeoutMs: int("SEEDFI_TIMEOUT_MS", 45_000),
      // SeedFi partner organisation: WakeelBoost uses the Altmall integration (SeedFi API v2.0, April 2026).
      organization: str("SEEDFI_ORGANIZATION", "Altmall"),
    };
  },
  get workerPollMs() {
    return int("WORKER_POLL_MS", 5000);
  },
};

/** Development keys published in .env.example; refused when APP_ENV=production. */
const DEV_KEYS = new Set([
  "ZGV2LW9ubHktZmllbGQta2V5LWNoYW5nZS1tZS0zMmI=",
  "ZGV2LW9ubHktaG1hYy1rZXktY2hhbmdlLW1lLTMyYnk=",
  "ZGV2LW9ubHktc3RvcmFnZS1rZXktY2hhbmdlLW1lLTM=",
]);

function keyList(name: string): Buffer[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw, i) => {
      const buf = Buffer.from(raw, "base64");
      if (buf.length !== 32) throw new Error(`${name} entry ${i + 1} must be 32 bytes, base64 encoded`);
      return buf;
    });
}

function keyFrom(name: string): Buffer {
  const raw = str(name);
  if (process.env.APP_ENV === "production" && DEV_KEYS.has(raw)) throw new Error(`${name} is the published development key; set a real secret in production`);
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes, base64 encoded`);
  return buf;
}

/**
 * Startup checks (security review H2). Called when the web server and the worker start; any failure
 * stops the process, so a misconfigured production server never serves requests.
 *  - A production build (NODE_ENV=production) must state APP_ENV explicitly: a missing APP_ENV would
 *    otherwise default to development and switch every production safeguard off.
 *  - With APP_ENV=production: the three keys must be real secrets (not the published dev keys), and
 *    TRUSTED_PROXY_HOPS must be at least 1 (the app is only served behind the bank's reverse proxy,
 *    which is the only trustworthy source of the client IP).
 */
export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production" && !env.APP_ENV) {
    throw new Error("APP_ENV is not set. Set APP_ENV=production on production servers (or APP_ENV=development for a local demo).");
  }
  if (!config.isProduction) {
    if (env.NODE_ENV === "production") console.warn(`[config] WARNING: running a production build with APP_ENV=${config.appEnv}. Production safeguards are OFF. Never use this for real customer data.`);
    return;
  }
  void config.fieldKey;
  void config.hmacKey;
  void config.storageKey;
  if (config.trustedProxyHops < 1) throw new Error("TRUSTED_PROXY_HOPS must be at least 1 in production: serve WakeelBoost only behind the bank's reverse proxy.");
  void config.previousFieldKeys;
  void config.previousStorageKeys;
  // Documents at rest must be encrypted (security review M10).
  if (config.storageDriver === "s3" && config.s3.serverSideEncryption === "none") throw new Error("S3_SERVER_SIDE_ENCRYPTION=none is not allowed in production: use AES256 or aws:kms.");
  if (!config.retentionPurgeEnabled) console.warn("[config] WARNING: RETENTION_PURGE_ENABLED=false. Personal data on requests past their retention date will not be purged.");
  // Email (sign-in codes, closure files, reminders) goes through Resend by the bank's decision (17 Nov 2026).
  if (config.mailDriver === "dev") throw new Error("MAIL_DRIVER=dev cannot be used in production.");
  if (config.mailDriver === "resend" && !config.resend.apiKey) throw new Error("RESEND_API_KEY is not set: staff could not receive sign-in codes.");
  if (config.mailDriver === "resend" && !config.resend.baseUrl.startsWith("https://")) throw new Error("RESEND_BASE_URL must use https.");
  if (config.mailDriver === "smtp" && !config.smtp.host) throw new Error("SMTP_HOST is not set: staff could not receive sign-in codes.");
}

/** Guard used by development-only adapters. */
export function assertNotProduction(what: string) {
  if (config.isProduction) {
    throw new Error(`${what} is a development adapter and cannot be used when APP_ENV=production`);
  }
}
