"use client";
import { useActionState } from "react";
import { adjust } from "../actions";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";

export function AdjustForm({ t, variantId, current }: { t: Dict; variantId: string; current: number }) {
  const [state, action] = useActionState(adjust, undefined);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="variantId" value={variantId} />
      <ErrorBox message={state?.error ? t.common.required : undefined} />
      {state?.ok && <p className="flex items-center gap-2 text-sm font-semibold text-brand-700"><Icon name="check" className="h-4 w-4" />{t.stock.adjusted}</p>}
      <Field label={t.stock.counted}><input name="counted" type="number" min={0} defaultValue={current} required className="input num" /></Field>
      <Field label={t.stock.adjustReason}><input name="reason" required minLength={2} className="input" /></Field>
      <SubmitButton className="btn-ghost w-full">{t.stock.adjust}</SubmitButton>
    </form>
  );
}
