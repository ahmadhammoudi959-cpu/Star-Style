import Link from "next/link";
import type { Dict } from "@/i18n/de";

type Ev = { id: string; channel: string; level: string; kind: string; ref: string; invoiceId: string | null; message: string; createdAt: Date };

export function evText(t: Dict, msg: string) {
  const E = t.shop.ev as Record<string, string>;
  if (E[msg]) return E[msg];
  const i = msg.indexOf(":");
  const key = i > 0 ? msg.slice(0, i) : msg, p = i > 0 ? msg.slice(i + 1) : "";
  if (key === "productsLoaded") { const [a, b, c] = p.split("|"); return E.productsLoaded.replace("{t}", a).replace("{m}", b).replace("{o}", c); }
  return E[key] ? E[key].replace("{p}", p) : msg;
}

export function EventList({ t, events, showShop }: { t: Dict; events: Ev[]; showShop?: boolean }) {
  if (!events.length) return <p className="text-sm text-ink-soft">{t.shop.noEvents}</p>;
  const tone = { info: "bg-brand-500", warn: "bg-amber-400", error: "bg-red-500" } as Record<string, string>;
  return (
    <ul className="divide-y divide-black/5">
      {events.map((e) => (
        <li key={e.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5 text-sm">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone[e.level] ?? "bg-slate-300"}`} />
          <span className="num w-32 shrink-0 text-xs text-ink-soft">{new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" }).format(e.createdAt)}</span>
          {showShop && <span className="badge bg-slate-100 text-slate-700">{t.shop.names[e.channel as "BRAND_SHOP"]}</span>}
          {e.ref && <span className="num font-semibold" dir="ltr">{e.ref}</span>}
          <span className={`min-w-0 flex-1 ${e.level === "error" ? "text-red-700" : e.level === "warn" ? "text-amber-800" : ""}`}>
            {evText(t, e.message)}
            {e.invoiceId && <Link href={`/sales/invoices/${e.invoiceId}`} className="ms-2 font-semibold text-brand-700 hover:underline">→</Link>}
          </span>
        </li>
      ))}
    </ul>
  );
}
