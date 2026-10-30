"use client";
import { useActionState } from "react";
import { deleteProductAction } from "../actions";
import { ErrorBox, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";

/** Löschen nur für Test- oder Fehleinträge (wird nur angezeigt, solange der Artikel nie verkauft/angeboten/als Verlust gebucht wurde) */
export function DeleteProduct({ t, id }: { t: Dict; id: string }) {
  const [state, action] = useActionState(deleteProductAction, undefined);
  const err = state?.error ? ((t.product as Record<string, unknown>)[state.error] as string | undefined) ?? t.common.error : undefined;
  return (
    <form action={action} onSubmit={(e) => { if (!confirm(t.product.deleteConfirm)) e.preventDefault(); }}
      className="card mt-6 flex animate-rise flex-wrap items-center justify-between gap-3 p-5">
      <input type="hidden" name="id" value={id} />
      <p className="min-w-0 flex-1 text-sm text-ink-soft">{t.product.deleteHint}</p>
      <SubmitButton className="btn-danger group"><Icon name="trash" className="h-4 w-4" />{t.product.delete}</SubmitButton>
      {err && <div className="w-full"><ErrorBox message={err} /></div>}
    </form>
  );
}
