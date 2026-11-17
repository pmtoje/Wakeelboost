/**
 * Test stand-in for the SeedFi HTTP transport (tests only). It answers in the documented Seed Score
 * response shape; scores are chosen per BVN so tests can exercise each routing path. Production code
 * always uses the real HTTPS transport.
 */
import { setSeedfiTransportForTests, type SeedfiTransport } from "@/server/integrations/seedfi";

export const BVN_ADVERSE = "12345678901"; // mirrors SeedFi staging "John Doe": overall 544, reviewed 444
export const BVN_FAIR = "09876567890"; // mirrors "Nathan Smith": 532 / 532
export const BVN_DOWN = "99999999999"; // provider outage (HTTP 503)
export const BVN_BADAUTH = "88888888888"; // provider refuses credentials (HTTP 401)
export const BVN_GARBAGE = "77777777777"; // 200 without Seed Score fields

export const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];

function score(overall: number, reviewed: number, history: boolean) {
  return {
    credit_score: {
      payment_history: { payment_history_score: 16.5, payment_history_seedfi_score: 132 },
      depth_of_credit: { depth_of_credit_score: 19, depth_of_credit_seedfi_score: 152 },
      open_credit: { open_credit_score: 22, open_credit_seedfi_score: 176 },
      demographics: { demographics_score: 9, demographics_seedfi_score: 72 },
      overall_seedfi_score: overall,
      reviewed_seedfi_score: reviewed,
      user_has_credit_history: history,
    },
  };
}

export const stubTransport: SeedfiTransport = {
  async post(url, headers, body) {
    const b = body as Record<string, unknown>;
    calls.push({ url, body: b, headers });
    switch (b.bvn) {
      case BVN_ADVERSE:
        return { status: 200, json: { status: 200, data: score(544, 444, true) } };
      case BVN_FAIR:
        return { status: 200, json: score(532, 532, true) };
      case BVN_DOWN:
        return { status: 503, json: { detail: "Service temporarily offline", status_code: 503 } };
      case BVN_BADAUTH:
        return { status: 401, json: { detail: "Invalid API key", status_code: 401 } };
      case BVN_GARBAGE:
        return { status: 200, json: { status: 200, data: { message: "ok" } } };
      default:
        return { status: 200, json: score(712, 712, true) };
    }
  },
};

export function installSeedfiStub() {
  process.env.SEEDFI_BASE_URL = "https://stg-loan-engine.theseedfi.com";
  process.env.SEEDFI_API_KEY = "test-key-not-real";
  setSeedfiTransportForTests(stubTransport);
}
