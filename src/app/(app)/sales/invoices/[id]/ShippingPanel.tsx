import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { fill } from "@/i18n";
import { Icon, type IconName } from "@/components/Icon";
import { formatDate, formatDateTime } from "@/lib/dates";
import { carrierLabel, isDeliveryState, shippingState, trackingUrl, type ShippingState } from "@/lib/shipping";
import type { Dict } from "@/i18n/de";
import { ClearShipNotice, NewShipment, PickupActions, ShipmentActions } from "./ShippingForms";
import { glsConfigured } from "@/lib/gls-client";
import { consigneeProblem } from "@/lib/gls";
import { glsConsigneeFor, PICKUP_NAME } from "@/lib/shipments";
import { can, getAuth } from "@/lib/auth";
import { carrierChoices } from "@/lib/carriers";
import { freightByProduct } from "@/lib/freight";
import { loadCarrierSettings } from "@/lib/carrier-settings";

const TONE: Record<ShippingState, string> = {
  none: "bg-amber-100 text-amber-900", partial: "bg-sky-100 text-sky-800", done: "bg-emerald-100 text-emerald-800", nothing: "bg-slate-100 text-slate-700",
};

type Ship = typeof schema.shipments.$inferSelect;
/** Sendung „Abholung“ (Kunde hat im Lager abgeholt) */
const isPickup = (s: Ship) => s.carrier === "OTHER" && s.carrierName === PICKUP_NAME && !s.trackingNumbers.length;

/** Zeile „Stand im Shop“ unter einer Sendung */
function shopLine(S: Dict["ship"], s: Ship): { text: string; tone: string; icon: IconName } | null {
  if (s.shopStatus === "none" || (s.source === "shop" && s.shopStatus === "sent" && !s.shopError)) return null;
  const err = S.err as Record<string, string>;
  const reason = (code: string) => {
    if (code.startsWith("missing:")) return fill(S.err.missing, { n: code.slice(8) });
    if (code.startsWith("cancelFailed:")) return `${S.err.cancelFailed} ${code.slice(13)}`;
    return err[code] ?? code;
  };
  if (s.shopStatus === "sent") {
    const extra = s.shopError ? ` · ${reason(s.shopError)}` : "";
    return { text: (s.notifyCustomer ? S.shop.sentMail : S.shop.sent) + extra, tone: s.shopError.startsWith("cancelFailed:") ? "text-red-700" : "text-emerald-700", icon: "check" };
  }
  if (s.shopStatus === "cancelled") return { text: S.shop.cancelled, tone: "text-slate-600", icon: "check" };
  if (s.shopStatus === "failed") return { text: `${S.shop.failed}: ${reason(s.shopError)}`, tone: "text-red-700", icon: "alert" };
  const base = S.shop[s.shopStatus as "pending" | "update" | "cancel"] ?? S.shop.pending;
  const wait = s.shopError === "needScope" || s.shopError === "syncOff" || s.shopError === "notConfigured";
  return { text: s.shopError ? `${base} ${reason(s.shopError)}` : base, tone: wait ? "text-amber-800" : "text-sky-800", icon: "clock" };
}

/**
 * Karte „Versand“ auf der Rechnung (Wunsch Inhaber 12.11.2026): Sendungen mit Links zur Sendungsverfolgung, Stand im Shop,
 * rechts „Neue Sendung“. Bei Shop-Bestellungen meldet das System die Sendung an Shopify (Kunde bekommt die Versand-E-Mail).
 */
export async function ShippingPanel({ t, intl, invoiceId, notice }: { t: Dict; intl: string; invoiceId: string; notice?: string }) {
  const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId), with: { lines: true, shipments: true } });
  if (!inv || inv.kind !== "INVOICE" || inv.status === "DRAFT") return null;
  const ships = [...inv.shipments].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (inv.status !== "ISSUED" && !ships.length) return null;
  const S = t.ship;
  const lines = [...inv.lines].sort((a, b) => a.position - b.position);
  const st = shippingState(lines, ships);
  const shop = inv.channel !== "STORE" && Boolean(inv.externalOrderId);
  // Versand eintragen/ändern nur mit Recht „Versand“ (die Actions prüfen selbst noch einmal)
  const auth = await getAuth();
  const ship = !!auth && can(auth, "sales.shipping");
  const canAdd = inv.status === "ISSUED" && st.state !== "done";
  // Versanddienste (Seite „Versanddienste“): Knöpfe, vorgewählter, Link zum Bearbeiten nur mit Recht „Einstellungen“
  const carriers = await loadCarrierSettings();
  const choices = carrierChoices(carriers);
  const manage = !!auth && can(auth, "settings");
  const own = new Set(carriers.custom.map((c) => c.name.toLowerCase()));
  // schon benutzte Speditionen als Vorschlag (ohne die eigenen Versanddienste – die haben einen Knopf)
  const names = canAdd || ships.length
    ? (await db.execute<{ n: string }>(sql`select carrier_name as n from shipments where carrier = 'OTHER' and carrier_name <> '' and carrier_name <> '?' group by carrier_name order by max(created_at) desc limit 24`)).rows
      .map((r) => r.n).filter((n) => !own.has(n.toLowerCase())).slice(0, 12)
    : [];
  const pickup = inv.deliveryMethod === "PICK_UP";
  const badge = st.state === "nothing" ? null : pickup && st.state !== "done" ? S.pickupBadge : shop && st.state === "none" ? S.toShip : S.state[st.state];
  // GLS: Etikett direkt aus dem System (eingerichtet + Anschrift vollständig); Gewicht der offenen Ware als Vorschlag für die Pakete
  const glsReady = canAdd && !pickup ? await glsConfigured() : false;
  const consignee = glsReady ? await glsConsigneeFor(inv.id) : null;
  const glsProblem = glsReady ? (consignee ? consigneeProblem(consignee) : "name") : null;
  const variantIds = [...new Set(st.open.map((o) => o.line.variantId).filter((x): x is string => Boolean(x)))];
  const grams = new Map(variantIds.length
    ? (await db.select({ id: schema.variants.id, g: schema.variants.weightGrams }).from(schema.variants).where(inArray(schema.variants.id, variantIds))).map((r) => [r.id, r.g])
    : []);
  const weights = Object.fromEntries(st.open.map((o) => [o.line.id, o.line.variantId ? grams.get(o.line.variantId) ?? null : null]));
  // GLS-Vertrag (19.11.2026): Speditionsware nie als GLS-Paket; Warenwert je Paket (Haftung 750 €, über 5.000 € ausgeschlossen)
  const productOfVariant = new Map(variantIds.length
    ? (await db.select({ id: schema.variants.id, p: schema.variants.productId }).from(schema.variants).where(inArray(schema.variants.id, variantIds))).map((r) => [r.id, r.p])
    : []);
  const freightMap = glsReady ? await freightByProduct([...new Set(productOfVariant.values())]) : new Map<string, boolean>();
  const freight = Object.fromEntries(st.open.map((o) => [o.line.id, Boolean(o.line.variantId && freightMap.get(productOfVariant.get(o.line.variantId) ?? ""))]));
  const unitNet = Object.fromEntries(st.open.map((o) => [o.line.id, o.line.qty ? Math.round(o.line.netCents / o.line.qty) : 0]));

  return (
    <section id="shipping" className="mt-6 grid scroll-mt-20 gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="card animate-rise overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/5 p-5">
          <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="truck" className="h-5 w-5 text-brand-600" />{S.title}</h2>
          {badge && <span className={`badge ${TONE[st.state]}`}>{badge}{st.state === "partial" && <span className="num"> · {st.shippedUnits}/{st.totalUnits}</span>}</span>}
        </div>
        {/* Ergebnis des letzten Speicherns (Seite wurde danach neu geladen) */}
        {notice && notice in S.notice && (
          <div role="status" className={`mx-5 mt-4 flex animate-rise items-start gap-2 rounded-xl p-3 text-sm font-semibold ring-1 ${notice === "failed" ? "bg-red-50 text-red-800 ring-red-200" : notice === "pending" ? "bg-sky-50 text-sky-900 ring-sky-200" : "bg-emerald-50 text-emerald-800 ring-emerald-200"}`}>
            <Icon name={notice === "failed" ? "alert" : notice === "pending" ? "clock" : "check"} className="mt-px h-4 w-4 shrink-0" />
            <span>{S.notice[notice as keyof typeof S.notice]}</span>
            <ClearShipNotice />
          </div>
        )}
        {inv.status === "ISSUED" && <p className="px-5 pt-4 text-sm text-ink-soft">{pickup ? S.pickupInfo : shop ? S.shopHint : S.storeHint}</p>}
        {ships.length === 0 ? <p className="p-5 text-sm text-ink-soft">{S.empty}</p> : (
          <ul className="space-y-3 p-5">
            {ships.map((s) => {
              const line = shopLine(S, s);
              const cancelled = Boolean(s.cancelledAt);
              const delivery = isDeliveryState(s.deliveryStatus) ? s.deliveryStatus : null;
              const plainUrl = s.carrier === "OTHER" && !s.trackingNumbers.length ? trackingUrl("OTHER", "", s.trackingUrl) : null;
              return (
                <li key={s.id} className={`rounded-xl p-3 ring-1 ${cancelled ? "bg-slate-50 opacity-75 ring-black/5" : "bg-brand-50/40 ring-brand-100"}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`font-bold ${cancelled ? "line-through decoration-slate-400" : ""}`}>{isPickup(s) ? S.pickupTitle : carrierLabel(s.carrier, s.carrierName)}</span>
                    <span className="text-xs text-ink-soft">{fill(isPickup(s) ? S.pickedUpOn : S.shippedOn, { d: formatDate(s.shippedOn, intl) })}</span>
                    {s.trackingNumbers.length > 1 && <span className="badge bg-white text-ink-soft ring-1 ring-black/5">{fill(S.parcels, { n: s.trackingNumbers.length })}</span>}
                    {s.source === "shop" && <span className="badge bg-slate-100 text-slate-700">{S.fromShop}</span>}
                    {cancelled && <span className="badge bg-slate-200 text-slate-700">{S.cancelled}</span>}
                    {!cancelled && delivery && <span className={`badge ${delivery === "DELIVERED" ? "bg-emerald-100 text-emerald-800" : ["DELAYED", "NOT_DELIVERED", "FAILURE", "ATTEMPTED_DELIVERY"].includes(delivery) ? "bg-amber-100 text-amber-900" : "bg-sky-100 text-sky-800"}`}>{S.delivery[delivery]}</span>}
                  </div>
                  {(s.trackingNumbers.length > 0 || plainUrl) && (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {s.trackingNumbers.map((n) => {
                        const u = trackingUrl(s.carrier, n, s.trackingUrl);
                        return (
                          <li key={n}>
                            {u && !cancelled ? (
                              <a href={u} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-sm font-semibold text-brand-700 ring-1 ring-brand-100 hover:bg-brand-50">
                                <bdi dir="ltr" className="num">{n}</bdi><Icon name="link" className="h-3.5 w-3.5" />
                              </a>
                            ) : <bdi dir="ltr" className="num inline-block rounded-lg bg-white px-2 py-1 text-sm ring-1 ring-black/5">{n}</bdi>}
                          </li>
                        );
                      })}
                      {plainUrl && !cancelled && (
                        <li><a href={plainUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-sm font-semibold text-brand-700 ring-1 ring-brand-100 hover:bg-brand-50">{carrierLabel(s.carrier, s.carrierName)}<Icon name="link" className="h-3.5 w-3.5" /></a></li>
                      )}
                    </ul>
                  )}
                  {s.items.length > 0 && <p className="mt-1.5 text-xs text-ink-soft [overflow-wrap:anywhere]">{s.items.map((i) => `${i.qty} × ${i.description || "?"}`).join(" · ")}</p>}
                  {s.note && <p className="mt-1 flex items-start gap-1.5 text-xs text-ink [overflow-wrap:anywhere]"><Icon name="edit" className="mt-px h-3.5 w-3.5 shrink-0 text-ink-soft" />{s.note}</p>}
                  {s.labelFileId && !cancelled && (
                    <a href={`/api/files/${s.labelFileId}`} target="_blank" rel="noopener noreferrer" className="btn-primary mt-2 inline-flex px-3 py-1.5 text-xs">
                      <Icon name="file" className="h-3.5 w-3.5" />{S.glsPrint}
                    </a>
                  )}
                  {s.glsStatus === "cancelled" && <p className="mt-1.5 text-xs font-semibold text-slate-600">{S.glsCancelled}</p>}
                  {line && <p className={`mt-2 flex items-start gap-1.5 text-xs font-semibold ${line.tone}`}><Icon name={line.icon} className="mt-px h-3.5 w-3.5 shrink-0" /><span className="[overflow-wrap:anywhere]">{line.text}</span></p>}
                  {ship && !cancelled && inv.status === "ISSUED" && s.shopStatus !== "cancel" && (
                    <ShipmentActions t={t} invoiceId={inv.id} shop={shop} failed={s.shopStatus === "failed"} names={names} choices={choices} manage={manage}
                      s={{ id: s.id, carrier: s.carrier, carrierName: s.carrierName, trackingNumbers: s.trackingNumbers, trackingUrl: s.trackingUrl, note: s.note, gls: s.glsStatus === "created", pickup: isPickup(s) }} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {inv.status === "ISSUED" && (ship || !canAdd) && (
        <aside className="card h-fit animate-rise p-5">
          {canAdd && pickup ? (
            <>
              <h3 className="mb-3 flex items-center gap-2 font-bold"><Icon name="box" className="h-4 w-4 text-brand-600" />{S.pickupTitle}</h3>
              <PickupActions t={t} invoiceId={inv.id} shop={shop} readyAt={inv.pickupReadyAt ? formatDateTime(inv.pickupReadyAt.toISOString(), intl) : null} />
            </>
          ) : canAdd ? (
            <>
              <h3 className="mb-3 flex items-center gap-2 font-bold"><Icon name="plus" className="h-4 w-4 text-brand-600" />{ships.some((s) => !s.cancelledAt) ? S.moreTitle : S.newTitle}</h3>
              <NewShipment t={t} invoiceId={inv.id} shop={shop} names={names} choices={choices} defaultKey={carriers.default} manage={manage}
                gls={{ ready: glsReady, problem: glsProblem }} weights={weights} freight={freight} unitNet={unitNet}
                open={st.open.map((o) => ({ lineId: o.line.id, description: o.line.description, qty: o.qty }))} />
            </>
          ) : <p className="flex items-center gap-2 text-sm font-semibold text-emerald-700"><Icon name="check" className="h-4 w-4" />{S.allShipped}</p>}
        </aside>
      )}
    </section>
  );
}
