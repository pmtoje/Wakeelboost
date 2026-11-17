import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { assertProductionConfig, config } from "@/server/config";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["APP_ENV", "FIELD_ENCRYPTION_KEY", "APP_HMAC_KEY", "STORAGE_ENCRYPTION_KEY", "TRUSTED_PROXY_HOPS", "COOKIE_SECURE", "MAIL_DRIVER", "RESEND_API_KEY", "STORAGE_DRIVER", "SHAREPOINT_TENANT_ID", "SHAREPOINT_CLIENT_ID", "SHAREPOINT_CLIENT_SECRET", "SHAREPOINT_SITE"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const realKeys = () => {
  process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.APP_HMAC_KEY = randomBytes(32).toString("base64");
  process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  // Production document store: the bank's SharePoint library
  process.env.STORAGE_DRIVER = "sharepoint";
  process.env.SHAREPOINT_TENANT_ID = "tenant-1";
  process.env.SHAREPOINT_CLIENT_ID = "client-1";
  process.env.SHAREPOINT_CLIENT_SECRET = "test-only-placeholder";
  process.env.SHAREPOINT_SITE = "altbank.sharepoint.com:/sites/WakeelBoost";
};

describe("production startup checks (security review H2)", () => {
  it("a production build refuses to start when APP_ENV is missing", () => {
    expect(() => assertProductionConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/APP_ENV is not set/);
    expect(() => assertProductionConfig({ NODE_ENV: "production", APP_ENV: "development" } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("production refuses the published development keys", () => {
    process.env.APP_ENV = "production";
    process.env.FIELD_ENCRYPTION_KEY = "ZGV2LW9ubHktZmllbGQta2V5LWNoYW5nZS1tZS0zMmI=";
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(() => assertProductionConfig({ NODE_ENV: "production", APP_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/published development key/);
  });

  it("production requires a trusted reverse proxy, and passes with real keys and one", () => {
    process.env.APP_ENV = "production";
    realKeys();
    process.env.TRUSTED_PROXY_HOPS = "0";
    expect(() => assertProductionConfig({ NODE_ENV: "production", APP_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/TRUSTED_PROXY_HOPS/);
    process.env.TRUSTED_PROXY_HOPS = "1";
    process.env.MAIL_DRIVER = "resend";
    process.env.RESEND_API_KEY = "re_test_placeholder";
    expect(() => assertProductionConfig({ NODE_ENV: "production", APP_ENV: "production" } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("production refuses to start without working email (Resend key)", () => {
    process.env.APP_ENV = "production";
    realKeys();
    process.env.TRUSTED_PROXY_HOPS = "1";
    process.env.MAIL_DRIVER = "resend";
    delete process.env.RESEND_API_KEY;
    expect(() => assertProductionConfig({ NODE_ENV: "production", APP_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/RESEND_API_KEY/);
    process.env.MAIL_DRIVER = "dev";
    expect(() => assertProductionConfig({ NODE_ENV: "production", APP_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/MAIL_DRIVER=dev/);
  });

  it("session cookies are always Secure in production", () => {
    process.env.APP_ENV = "production";
    process.env.COOKIE_SECURE = "false";
    expect(config.cookieSecure).toBe(true);
    process.env.APP_ENV = "test";
    expect(config.cookieSecure).toBe(false);
  });

  it("production refuses local file storage and incomplete SharePoint settings", () => {
    process.env.APP_ENV = "production";
    realKeys();
    process.env.TRUSTED_PROXY_HOPS = "1";
    process.env.MAIL_DRIVER = "resend";
    process.env.RESEND_API_KEY = "re_test_placeholder";
    expect(() => assertProductionConfig({ NODE_ENV: "production", APP_ENV: "production" } as NodeJS.ProcessEnv)).not.toThrow();
    delete process.env.SHAREPOINT_SITE;
    expect(() => assertProductionConfig({ NODE_ENV: "production", APP_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/SHAREPOINT_SITE/);
    process.env.STORAGE_DRIVER = "local";
    expect(() => assertProductionConfig({ NODE_ENV: "production", APP_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/Local file storage/);
  });
});
