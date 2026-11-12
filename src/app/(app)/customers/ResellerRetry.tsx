"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { retryResellerAction } from "./actions";

/** „Erneut versuchen“: Action direkt aufrufen, danach Seite neu laden (kein mitgeschickter Seitenbaum, siehe „Hängender Übergang“) */
export function ResellerRetry({ customerId, label }: { customerId: string; label: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" disabled={busy} className="btn-ghost group mt-2 w-full justify-center px-3 py-2 text-xs"
      onClick={async () => { setBusy(true); try { await retryResellerAction(customerId); } finally { window.location.reload(); } }}>
      {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" /> : <Icon name="history" className="icon-pop h-4 w-4" />}{label}
    </button>
  );
}
