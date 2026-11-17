"use client";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { creditCheckAction } from "../../actions";

/** Customer identification and consent, then the SeedFi enquiry (server-side). */
export function CreditCheckForm({ applicationId, prefill, applicantType }: { applicationId: string; prefill: { firstName: string; lastName: string; dateOfBirth: string; gender: string; phone: string }; applicantType: string }) {
  const [key] = useState(() => crypto.randomUUID());
  return (
    <ActionForm action={creditCheckAction}>
      {(state) => (
        <>
          <input type="hidden" name="applicationId" value={applicationId} />
          <input type="hidden" name="idempotencyKey" value={key} />
          <p className="small muted" style={{ margin: 0 }}>
            {applicantType === "LIMITED"
              ? "Identify the principal director (the BVN holder) whose credit history SeedFi will check. Enter the details exactly as on the BVN record."
              : applicantType === "ENTERPRISE"
                ? "Identify the proprietor whose credit history SeedFi will check. Enter the details exactly as on the BVN record."
                : "Enter the customer's details exactly as on the BVN record."}
          </p>
          <div className="grid-2">
            <Field id="firstName" label="First name" err={state.fields?.firstName}><input id="firstName" name="firstName" defaultValue={prefill.firstName} autoComplete="off" required /></Field>
            <Field id="lastName" label="Last name" err={state.fields?.lastName}><input id="lastName" name="lastName" defaultValue={prefill.lastName} autoComplete="off" required /></Field>
            <Field id="bvn" label="BVN" hint="11 digits. Encrypted; only the last four digits are shown afterwards." err={state.fields?.bvn}><input id="bvn" name="bvn" inputMode="numeric" maxLength={11} autoComplete="off" required /></Field>
            <Field id="dateOfBirth" label="Date of birth" err={state.fields?.dateOfBirth}><input id="dateOfBirth" name="dateOfBirth" type="date" defaultValue={prefill.dateOfBirth} required /></Field>
            <Field id="gender" label="Gender (as on BVN record)" err={state.fields?.gender}>
              <select id="gender" name="gender" defaultValue={prefill.gender}>
                <option value="">Select…</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
              </select>
            </Field>
            <Field id="phone" label="Mobile number" err={state.fields?.phone}><input id="phone" name="phone" inputMode="tel" defaultValue={prefill.phone} required /></Field>
          </div>
          <fieldset className="consent-box">
            <legend>Customer consent</legend>
            <div className="field">
              <label htmlFor="consentMethod">How consent was given</label>
              <select id="consentMethod" name="consentMethod" defaultValue="SIGNED_FORM">
                <option value="SIGNED_FORM">Signed consent form (attach it to the request)</option>
                <option value="IN_APP_WITNESSED">Given in person to me and witnessed</option>
              </select>
              {state.fields?.consentMethod && <span className="err">{state.fields.consentMethod}</span>}
            </div>
            <label className="check">
              <input type="checkbox" name="consent" /> The customer has consented to The Alternative Bank making a credit enquiry through SeedFi for this financing request.
            </label>
            {state.fields?.consent && <span className="err">{state.fields.consent}</span>}
          </fieldset>
          <div>
            <SubmitButton>
              <ShieldCheck className="icon" aria-hidden="true" /> Run SeedFi credit check
            </SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

function Field({ id, label, hint, err, children }: { id: string; label: string; hint?: string; err?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !err && <span className="hint">{hint}</span>}
      {err && <span className="err">{err}</span>}
    </div>
  );
}
