/**
 * SeedFi Loan Engine client: Seed Score calculation (POST /scoring/api/v1/seed-score/calculate).
 * Documentation: "SeedFi Loan Engine API Documentation" v2.0, April 2026.
 *
 * - Authenticates with the service API key (X-API-Key header), server-side only.
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
  if (httpStatus === 401 || httpStatus === 403) return { code: "AUTH", message: "SeedFi refused the bank's credentials. An administrator must check the SeedFi API key." };
  if (httpStatus === 404) return { code: "NOT_FOUND", message: "The SeedFi scoring endpoint was not found. Check the SeedFi base URL." };
  if (httpStatus === 409) return { code: "CONFLICT", message: `SeedFi reported a conflict${d ? `: ${d}` : "."}` };
  if (httpStatus === 429) return { code: "RATE_LIMITED", message: "SeedFi rate limit reached. Try again shortly." };
  return { code: "UNAVAILABLE", message: `SeedFi is unavailable (HTTP ${httpStatus}). Try again shortly.` };
}

export async function calculateSeedScore(req: SeedScoreRequest): Promise<SeedfiCall> {
  const s = config.seedfi;
  if (!s.configured) return { ok: false, httpStatus: null, code: "NOT_CONFIGURED", message: "SeedFi is not configured on this server (SEEDFI_BASE_URL and SEEDFI_API_KEY).", respondedAt: new Date() };
  const url = `${s.baseUrl}/scoring/api/v1/seed-score/calculate`;
  const headers = { "Content-Type": "application/json", Accept: "application/json", "X-API-Key": s.apiKey };
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
