"use client";
import { ActionForm, SubmitButton } from "@/components/forms";
import { stageTargetAction } from "./actions";

export function StageTargetForm({ stages }: { stages: { stage: string; label: string; hours: number | null }[] }) {
  return (
    <div className="stack">
      {stages.map((s) => (
        <ActionForm key={s.stage} action={stageTargetAction} className="row">
          <input type="hidden" name="stage" value={s.stage} />
          <label htmlFor={`t-${s.stage}`} style={{ minWidth: 260 }}>{s.label}</label>
          <input id={`t-${s.stage}`} name="hours" type="number" min={1} max={2160} defaultValue={s.hours ?? ""} placeholder="hours" style={{ width: 110 }} />
          <SubmitButton className="btn btn-sm">Save</SubmitButton>
        </ActionForm>
      ))}
    </div>
  );
}
