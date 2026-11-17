/**
 * SeedFi Loan Engine client: Seed Score calculation (POST /scoring/api/v1/seed-score/calculate).
 * Documentation: "SeedFi Loan Engine API Documentation" v2.0, April 2026.
 *
 * - Authenticates server-side either with a service API key (X-API-Key header) or, automatically,
 *   with the Altmall account sign-in: the client logs in, caches the 30-minute access token, renews
 *   it with the refresh token before it expires and signs in again when SeedFi rejects it.
 * - Never logs the API key, BVN or response body.
 * - Times out (SEEDFI_TIMEOUT_MS), retries once on network errors and 502/503/504, never on 4xx.
 * - Every failure is returned as a technical error: it is never interpreted as a credit decision.
 */
import { config } from "../config";

export interface SeedScoreRequest {
  customerId: string;
  firstName: string;
  lastName: string;
  bvn: string;
  dateOfBirth: string; // YYYY-MM-DD
  phoneNumber: string;
  gender: "male" | "female";
  loanDurationInMonths?: number;
}

export interface SeedScoreResult {
  overallScore: number;
  reviewedScore: number;
  hasCreditHistory: boolean;
  components: Record<string, Record<string, number>>;
  validityDate: string | null;
  providerReference: string | null;
  narration: string | null;
  raw: unknown;
}

export type SeedfiCall =
  | { ok: true; httpStatus: number; result: SeedScoreResult; respondedAt: Date }
  | { ok: false; httpStatus: number | null; code: string; message: string; respondedAt: Date };

/** Transport seam: tests inject a stand-in; production uses fetch against the configured base URL. */
export interface SeedfiTransport {
  post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<{ status: number; json: unknown }>;
}

const fetchTransport: SeedfiTransport = {
  async post(url, headers, body, timeoutMs) {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { detail: "Non-JSON response" };
    }
    return { status: res.status, json };
  },
};
let transport: SeedfiTransport = fetchTransport;
export function setSeedfiTransportForTests(t: SeedfiTransport | null) {
  transport = t ?? fetchTransport;
}
export function seedfiTransportIsStub() {
  return transport !== fetchTransport;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Map the documented response (with or without the {"status","data"} envelope) to verified fields. */
export function parseSeedScore(json: unknown): SeedScoreResult | null {
  const env = json as { data?: unknown } | null;
  const body = (env && typeof env === "object" && "data" in env && env.data && typeof env.data === "object" ? env.data : json) as Record<string, unknown> | null;
  const cs = body?.credit_score as Record<string, unknown> | undefined;
  if (!cs || typeof cs !== "object") return null;
  const overall = num(cs.overall_seedfi_score);
  const reviewed = num(cs.reviewed_seedfi_score);
  if (overall === null || reviewed === null || typeof cs.user_has_credit_history !== "boolean") return null;
  const components: Record<string, Record<string, number>> = {};
  for (const k of ["payment_history", "depth_of_credit", "open_credit", "demographics"]) {
    const c = cs[k] as Record<string, unknown> | undefined;
    if (c && typeof c === "object") components[k] = Object.fromEntries(Object.entries(c).filter(([, v]) => num(v) !== null).map(([kk, v]) => [kk, num(v)!]));
  }
  const validity = (cs.validity_date ?? body?.validity_date) as unknown;
  const ref = (body?.id ?? body?.score_id ?? body?.reference ?? cs.id) as unknown;
  const narration = (body?.narration ?? cs.narration) as unknown;
  return {
    overallScore: overall,
    reviewedScore: reviewed,
    hasCreditHistory: cs.user_has_credit_history,
    components,
    validityDate: typeof validity === "string" && /^\d{4}-\d{2}-\d{2}/.test(validity) ? validity.slice(0, 10) : null,
    providerReference: typeof ref === "string" || typeof ref === "number" ? String(ref).slice(0, 100) : null,
    narration: typeof narration === "string" ? narration.slice(0, 4000) : null,
    raw: json,
  };
}

function failure(httpStatus: number | null, json: unknown): { code: string; message: string } {
  const detail = (json as { detail?: unknown } | null)?.detail;
  const d = typeof detail === "string" ? detail.slice(0, 200) : "";
  if (httpStatus === null) return { code: "NETWORK", message: "SeedFi could not be reached." };
  if (httpStatus === 400 || httpStatus === 422) return { code: "REJECTED_REQUEST", message: `SeedFi rejected the request${d ? `: ${d}` : "."}` };
  if (httpStatus === 401 || httpStatus === 403) return { code: "AUTH", message: "SeedFi refused the credentials. An administrator must check the SeedFi sign-in or API key." };
  if (httpStatus === 404) return { code: "NOT_FOUND", message: "The SeedFi scoring endpoint was not found. Check the SeedFi base URL." };
  if (httpStatus === 409) return { code: "CONFLICT", message: `SeedFi reported a conflict${d ? `: ${d}` : "."}` };
  if (httpStatus === 429) return { code: "RATE_LIMITED", message: "SeedFi rate limit reached. Try again shortly." };
  return { code: "UNAVAILABLE", message: `SeedFi is unavailable (HTTP ${httpStatus}). Try again shortly.` };
}

// ------------------------------------------------------------------ automatic token management

interface TokenState {
  access: string;
  refresh: string | null;
  expiresAt: number;
  baseUrl: string;
}
let token: TokenState | null = null;
let pending: Promise<TokenState> | null = null;
export function resetSeedfiTokenForTests() {
  token = null;
  pending = null;
}
export function seedfiTokenStatus() {
  return token ? { expiresAt: new Date(token.expiresAt), hasRefresh: !!token.refresh } : null;
}

class AuthError extends Error {
  constructor(
    public httpStatus: number | null,
    message: string,
  ) {
    super(message);
  }
}

function tokenFrom(json: unknown, baseUrl: string): TokenState {
  const env = json as { data?: unknown } | null;
  const b = (env && typeof env === "object" && "data" in env && env.data && typeof env.data === "object" ? env.data : json) as Record<string, unknown> | null;
  const access = typeof b?.access_token === "string" ? b.access_token : null;
  if (!access) throw new AuthError(null, "SeedFi sign-in did not return an access token.");
  const ttl = typeof b?.expires_in === "number" && b.expires_in > 60 ? b.expires_in : 1800;
  // Renew two minutes early so a request never goes out with an expiring token.
  return { access, refresh: typeof b?.refresh_token === "string" ? b.refresh_token : null, expiresAt: Date.now() + (ttl - 120) * 1000, baseUrl };
}

async function signIn(): Promise<TokenState> {
  const s = config.seedfi;
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  const body = { email: s.username, password: s.password };
  // The documentation shows both paths for login (§2.3 table and its example).
  for (const path of ["/auth/api/v1/login", "/auth/api/v1/auth/login"]) {
    const r = await transport.post(`${s.baseUrl}${path}`, headers, body, s.timeoutMs);
    if (r.status === 404) continue;
    if (r.status >= 200 && r.status < 300) return tokenFrom(r.json, s.baseUrl);
    if (r.status === 401 || r.status === 403) throw new AuthError(r.status, "SeedFi refused the Altmall account sign-in. An administrator must check SEEDFI_USERNAME and SEEDFI_PASSWORD.");
    throw new AuthError(r.status, `SeedFi sign-in failed (HTTP ${r.status}).`);
  }
  throw new AuthError(404, "The SeedFi sign-in endpoint was not found. Check the SeedFi base URL.");
}

async function renew(t: TokenState): Promise<TokenState> {
  const s = config.seedfi;
  if (t.refresh) {
    const r = await transport.post(`${s.baseUrl}/auth/api/v1/refresh`, { "Content-Type": "application/json", Accept: "application/json" }, { refresh_token: t.refresh }, s.timeoutMs);
    if (r.status >= 200 && r.status < 300) {
      const n = tokenFrom(r.json, s.baseUrl);
      return { ...n, refresh: n.refresh ?? t.refresh };
    }
  }
  return signIn();
}

/** A valid access token, signing in or renewing as needed (one sign-in at a time per process). */
async function accessToken(force = false): Promise<string> {
  const s = config.seedfi;
  if (token && token.baseUrl !== s.baseUrl) token = null;
  if (!force && token && token.expiresAt > Date.now()) return token.access;
  if (!pending) {
    const current = token;
    pending = (current ? renew(current) : signIn())
      .then((t) => {
        token = t;
        return t;
      })
      .finally(() => {
        pending = null;
      });
  }
  return (await pending).access;
}

async function authHeaders(force = false): Promise<Record<string, string>> {
  const s = config.seedfi;
  const base = { "Content-Type": "application/json", Accept: "application/json" };
  if (s.authMode === "API_KEY") return { ...base, "X-API-Key": s.apiKey };
  return { ...base, Authorization: `Bearer ${await accessToken(force)}` };
}

export async function calculateSeedScore(req: SeedScoreRequest): Promise<SeedfiCall> {
  const s = config.seedfi;
  if (!s.configured) return { ok: false, httpStatus: null, code: "NOT_CONFIGURED", message: "SeedFi is not configured on this server (SEEDFI_BASE_URL with SEEDFI_USERNAME and SEEDFI_PASSWORD, or SEEDFI_API_KEY).", respondedAt: new Date() };
  // Live only in production: SeedFi staging returns fixed test personas, never real credit data.
  if (config.isProduction && s.environment !== "production") {
    return { ok: false, httpStatus: null, code: "NOT_LIVE", message: "Production must use the live SeedFi service (https://loanengine.theseedfi.com), not staging.", respondedAt: new Date() };
  }
  const url = `${s.baseUrl}/scoring/api/v1/seed-score/calculate`;
  let headers: Record<string, string>;
  try {
    headers = await authHeaders();
  } catch (e) {
    const ae = e instanceof AuthError ? e : null;
    console.error("[seedfi] sign-in failed", { httpStatus: ae?.httpStatus ?? null });
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, httpStatus: ae?.httpStatus ?? null, code: timeout ? "TIMEOUT" : ae?.httpStatus === 401 || ae?.httpStatus === 403 ? "AUTH" : "AUTH_UNAVAILABLE", message: ae ? ae.message : timeout ? "SeedFi sign-in timed out." : "SeedFi sign-in could not be completed.", respondedAt: new Date() };
  }
  let reauthed = false;
  const body = {
    customer_id: req.customerId,
    first_name: req.firstName,
    last_name: req.lastName,
    bvn: req.bvn,
    date_of_birth: req.dateOfBirth,
    phone_number: req.phoneNumber,
    gender: req.gender,
    ...(req.loanDurationInMonths ? { loan_duration_in_month: req.loanDurationInMonths } : {}),
    include_narration: true,
  };
  let last: SeedfiCall | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await transport.post(url, headers, body, s.timeoutMs);
      if (r.status >= 200 && r.status < 300) {
        const parsed = parseSeedScore(r.json);
        if (!parsed) return { ok: false, httpStatus: r.status, code: "UNEXPECTED_RESPONSE", message: "SeedFi returned a response without the expected Seed Score fields.", respondedAt: new Date() };
        return { ok: true, httpStatus: r.status, result: parsed, respondedAt: new Date() };
      }
      if ((r.status === 401 || r.status === 403) && s.authMode === "ACCOUNT" && !reauthed) {
        // Token rejected (expired or revoked): sign in again once and retry immediately.
        reauthed = true;
        try {
          headers = await authHeaders(true);
          attempt--;
          continue;
        } catch (e) {
          return { ok: false, httpStatus: e instanceof AuthError ? e.httpStatus : null, code: "AUTH", message: e instanceof Error ? e.message : "SeedFi sign-in failed.", respondedAt: new Date() };
        }
      }
      const f = failure(r.status, r.json);
      last = { ok: false, httpStatus: r.status, ...f, respondedAt: new Date() };
      if (![502, 503, 504].includes(r.status)) return last;
    } catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      last = { ok: false, httpStatus: null, code: timeout ? "TIMEOUT" : "NETWORK", message: timeout ? `SeedFi did not respond within ${Math.round(s.timeoutMs / 1000)} seconds.` : "SeedFi could not be reached.", respondedAt: new Date() };
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 1500));
  }
  console.error("[seedfi] seed score failed", last && !last.ok ? { code: last.code, httpStatus: last.httpStatus } : null);
  return last!;
}
