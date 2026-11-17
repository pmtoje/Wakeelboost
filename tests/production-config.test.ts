import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { assertProductionConfig, config } from "@/server/config";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["APP_ENV", "FIELD_ENCRYPTION_KEY", "APP_HMAC_KEY", "STORAGE_ENCRYPTION_KEY", "TRUSTED_PROXY_HOPS", "COOKIE_SECURE"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const realKeys = () => {
  process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.APP_HMAC_KEY = randomBytes(32).toString("base64");
  process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
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
    expect(() => assertProductionConfig({ NODE_ENV: "production", APP_ENV: "production" } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("session cookies are always Secure in production", () => {
    process.env.APP_ENV = "production";
    process.env.COOKIE_SECURE = "false";
    expect(config.cookieSecure).toBe(true);
    process.env.APP_ENV = "test";
    expect(config.cookieSecure).toBe(false);
  });
});
