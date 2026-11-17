#!/usr/bin/env node
/**
 * Starts a command (the web app, dev server or worker) so outbound HTTPS calls (SeedFi, Resend) work on
 * servers that reach the internet through a proxy. When HTTPS_PROXY / HTTP_PROXY is set (in the
 * environment or .env) it turns on Node's built-in proxy support for fetch(), NODE_USE_ENV_PROXY=1,
 * which Node reads only at start-up. NO_PROXY is honoured. Without a proxy nothing changes.
 *
 * Usage: node scripts/with-proxy.mjs <command> [args...]   (Windows, macOS, Linux)
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const env = { ...process.env };
// Proxy settings may live in .env rather than the environment (Next.js loads .env later, too late here).
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*(HTTPS_PROXY|HTTP_PROXY|NO_PROXY|https_proxy|http_proxy|no_proxy|NODE_USE_ENV_PROXY)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
if (proxy && env.NODE_USE_ENV_PROXY === undefined) {
  env.NODE_USE_ENV_PROXY = "1";
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 21) || (maj === 23)) {
    console.warn(`[with-proxy] A proxy is configured but Node ${process.versions.node} cannot route fetch() through it. Use Node 22.21+ or 24+.`);
  }
  // Node prints an "experimental" notice for its proxy agent; it is expected and harmless.
  env.NODE_NO_WARNINGS = env.NODE_NO_WARNINGS ?? "1";
  console.log("[with-proxy] Outbound proxy detected: Node fetch() will use it (NODE_USE_ENV_PROXY=1).");
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("Usage: node scripts/with-proxy.mjs <command> [args...]");
  process.exit(2);
}
const child = spawn(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
