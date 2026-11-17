"use client";
import { useEffect, useRef, useState } from "react";
import { Eraser, PenLine } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { signOnTabletAction } from "../../../actions";

export interface SignerSlot {
  role: "CUSTOMER" | "WITNESS" | "SIGNATORY_1" | "SIGNATORY_2";
  title: string;
  required: boolean;
  defaultName: string;
  fields: ("designation" | "address" | "occupation")[];
}

const FIELD_LABEL = { designation: "Designation", address: "Address", occupation: "Occupation" } as const;

/** Signature pad: finger or stylus on a tablet, mouse on a desktop. Writes a PNG data URL into a hidden input. */
function SignaturePad({ name, label, error }: { name: string; label: string; error?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [value, setValue] = useState("");
  const drawing = useRef(false);
  const inked = useRef(0);
  useEffect(() => {
    const c = canvas.current!;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.lineWidth = 3.2;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = "#0b1f3a";
  }, []);
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) * c.width) / r.width, ((e.clientY - r.top) * c.height) / r.height] as const;
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    canvas.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    const g = canvas.current!.getContext("2d")!;
    const [x, y] = pos(e);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + 0.1, y + 0.1);
    g.stroke();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    e.preventDefault();
    const g = canvas.current!.getContext("2d")!;
    const [x, y] = pos(e);
    g.lineTo(x, y);
    g.stroke();
    inked.current += 1;
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    // A tap is not a signature: require some strokes before accepting it.
    if (inked.current > 12) setValue(canvas.current!.toDataURL("image/png"));
  };
  const clear = () => {
    const c = canvas.current!;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    inked.current = 0;
    setValue("");
  };
  return (
    <div className="field">
      <label>{label}</label>
      <canvas
        ref={canvas}
        width={900}
        height={300}
        className="signature-pad"
        aria-label={`${label}: sign with a finger, stylus or mouse`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={up}
      />
      <input type="hidden" name={name} value={value} />
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <span className="hint">{value ? <><PenLine className="icon" aria-hidden="true" /> Signature captured</> : "Sign inside the box"}</span>
        <button type="button" className="btn btn-sm" onClick={clear}>
          <Eraser className="icon" aria-hidden="true" /> Clear
        </button>
      </div>
      {error && <span className="err">{error}</span>}
    </div>
  );
}

export function SignForm({ applicationId, doc, label, slots }: { applicationId: string; doc: string; label: string; slots: SignerSlot[] }) {
  const [optional, setOptional] = useState<Record<string, boolean>>({});
  return (
    <ActionForm action={signOnTabletAction} doneHref={`/requests/${applicationId}?done=1`}>
      {(state) => (
        <>
          <input type="hidden" name="applicationId" value={applicationId} />
          <input type="hidden" name="doc" value={doc} />
          {slots.map((s) => {
            const on = s.required || optional[s.role];
            return (
              <fieldset key={s.role} className="consent-box">
                <legend>
                  {s.title}
                  {!s.required && " (optional)"}
                </legend>
                {!s.required && (
                  <label className="check">
                    <input type="checkbox" checked={!!optional[s.role]} onChange={(e) => setOptional((o) => ({ ...o, [s.role]: e.target.checked }))} /> Add a {s.title.toLowerCase()}
                  </label>
                )}
                {on && (
                  <>
                    <div className="grid-2">
                      <div className="field">
                        <label htmlFor={`${s.role}.name`}>Full name</label>
                        <input id={`${s.role}.name`} name={`${s.role}.name`} defaultValue={s.defaultName} autoComplete="off" required />
                        {state.fields?.[`${s.role}.name`] && <span className="err">{state.fields[`${s.role}.name`]}</span>}
                      </div>
                      {s.fields.map((f) => (
                        <div key={f} className="field">
                          <label htmlFor={`${s.role}.${f}`}>{FIELD_LABEL[f]}</label>
                          <input id={`${s.role}.${f}`} name={`${s.role}.${f}`} autoComplete="off" required />
                        </div>
                      ))}
                    </div>
                    {(state.fields?.[`${s.role}.details`] || state.fields?.[`${s.role}.designation`]) && <span className="err">{state.fields?.[`${s.role}.details`] ?? state.fields?.[`${s.role}.designation`]}</span>}
                    <SignaturePad name={`${s.role}.signature`} label={`${s.title}'s signature`} error={state.fields?.[s.role]} />
                  </>
                )}
              </fieldset>
            );
          })}
          <label className="check">
            <input type="checkbox" name="confirm" /> The signer{slots.length > 1 ? "s" : ""} read the {label.toLowerCase().replace("murabaha", "Murabaha")} on this screen (or a printed copy) before signing, in my presence.
          </label>
          {state.fields?.confirm && <span className="err">{state.fields.confirm}</span>}
          <SubmitButton className="btn btn-primary">Sign and file the {label.toLowerCase().replace("murabaha", "Murabaha")}</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
