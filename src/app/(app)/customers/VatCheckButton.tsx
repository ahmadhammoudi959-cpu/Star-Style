"use client";
import { useActionState } from "react";
import { runVatCheck } from "./actions";
import { SubmitButton } from "@/components/Forms";
import type { Dict } from "@/i18n/de";

export function VatCheckButton({ t, customerId }: { t: Dict; customerId: string }) {
  const [state, action] = useActionState(runVatCheck, undefined);
  const msg = state?.error === "unavailable" ? t.customer.checkUnavailable : state?.error === "ownVatMissing" ? t.customer.ownVatMissing : undefined;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="customerId" value={customerId} />
      <SubmitButton className="btn-primary w-full">{t.customer.check}</SubmitButton>
      {msg && <p className="text-xs font-semibold text-amber-700">{msg}</p>}
    </form>
  );
}
