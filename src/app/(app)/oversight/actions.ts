"use server";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import { setStageTarget } from "@/server/domain/oversight";

export async function stageTargetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const raw = String(fd.get("hours") ?? "").trim();
  try {
    await setStageTarget(ctx, String(fd.get("stage") ?? ""), raw ? Number(raw) : null);
    return { ok: true, message: raw ? `Target saved: ${raw} hours.` : "Target removed.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
