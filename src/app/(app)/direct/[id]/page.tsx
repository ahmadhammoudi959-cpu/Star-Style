import Link from "next/link";
import { notFound } from "next/navigation";
import { getI18n, fill } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Thumb } from "@/components/Thumb";
import { ZoomThumb } from "@/components/ZoomThumb";
import { Icon } from "@/components/Icon";
import { DoneNotice } from "@/components/DoneNotice";
import { can, requirePerm } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import { formatDateTime } from "@/lib/dates";
import { directOrderDetail } from "@/lib/direct";
import { customerOptions } from "@/lib/sales-queries";
import { regionOptions } from "@/lib/regions";
import { DirectActions, ReopenButton } from "../DirectActions";
import { LANG_NAMES } from "@/lib/lang-names";
import { discounted } from "@/lib/promo-rules";

export const dynamic = "force-dynamic";

/** Eine Liste vom Bestell-Link: Artikel, Angaben des Kunden, Kunde wählen → Angebot oder Rechnung */
export default async function DirectListPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ customer?: string; saved?: string }> }) {
  const session = await requirePerm("direct");
  const { id } = await params;
  const sp = await searchParams;
  const { t, intl, locale } = await getI18n();
  const D = t.direct, P = t.directPub;
  const o = await directOrderDetail(id);
  if (!o) notFound();
  const groupName = { RETAIL: t.customer.RETAIL, WHOLESALE: t.customer.WHOLESALE };
  const country = regionOptions(locale, [o.country]).find((c) => c.code === o.country)?.name ?? o.country;
  const vat = Math.max(0, o.grossCents - o.netCents);
  const LANGS: Record<string, string> = LANG_NAMES;
  // Artikel von Hand (nicht im System): Foto groß, „Als Artikel anlegen“ (Formular vorbelegt), nur Angebot
  const manualCount = o.items.filter((l) => l.manual).length;
  const mayCreate = can(session, "products.edit");
  const ownInfo = (l: (typeof o.items)[number]) => l.manual && (
    <span className="mt-1 flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200" data-manual-item>
        <Icon name="camera" className="h-3.5 w-3.5" />{D.manualBadge}
      </span>
      {mayCreate && <Link href={`/products/new?direct=${l.id}`} className="text-xs font-semibold text-brand-700 hover:underline" data-manual-create>{D.manualCreate}</Link>}
    </span>
  );
  const photo = (l: (typeof o.items)[number], size: number) => l.manual && l.imageId
    ? <a href={`/api/files/${l.imageId}`} target="_blank" rel="noopener" title={D.manualPhoto} className="shrink-0"><ZoomThumb id={l.imageId} size={size} info={{ title: l.description, sub: D.manualBadge }} /></a>
    : <Thumb id={l.imageId} size={size} />;
  const unitShown = (l: (typeof o.items)[number]) => (l.manual && !l.unitPriceCents ? <span className="text-xs font-semibold text-ink-soft">{D.manualNoPrice}</span> : unit(l));

  const stateBadge = o.state === "done"
    ? <span className="badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"><Icon name="check" className="h-3.5 w-3.5" />{D.states.done}</span>
    : o.state === "rejected" ? <span className="badge bg-slate-100 text-slate-600">{D.states.rejected}</span>
    : <span className="badge bg-accent-50 text-accent-700 ring-1 ring-accent-100">{D.states.new}</span>;

  let side: React.ReactNode;
  if (o.state === "new") {
    const customers = (await customerOptions()).map((c) => ({ id: c.id, number: c.number, name: c.name, city: c.city, priceGroup: c.priceGroup }));
    const pre = sp.customer && customers.some((c) => c.id === sp.customer) ? sp.customer : o.suggestion?.id ?? "";
    side = (
      <DirectActions t={D} id={o.id} customers={customers} preselect={pre} suggestionId={o.suggestion?.id ?? null}
        rights={{ offer: can(session, "sales.offers"), invoice: can(session, "sales.invoices") }} manualCount={manualCount}
        newCustomerHref={can(session, "customers") ? `/customers/new?direct=${o.id}` : null} groupNames={groupName} priceGroupLabel={t.customer.priceGroup} />
    );
  } else if (o.state === "done") {
    const doc = o.offer ? { href: `/sales/offers/${o.offer.id}`, label: fill(D.doneOffer, { n: o.offer.number }) }
      : { href: `/sales/invoices/${o.invoice!.id}`, label: o.invoice!.number ? fill(D.doneInvoice, { n: o.invoice!.number }) : D.draft };
    side = (
      <section className="card space-y-3 p-4 lg:sticky lg:top-4">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><Icon name={o.offer ? "file" : "receipt"} className="icon-pop h-5 w-5" /></span>
          <div className="min-w-0">
            <div className="font-bold" dir="auto">{doc.label}</div>
            {o.customer && <div className="truncate text-sm text-ink-soft" dir="auto">{fill(D.madeFor, { name: o.customer.name })}</div>}
          </div>
        </div>
        <Link href={doc.href} className="btn-primary group w-full"><Icon name="eye" className="icon-pop h-4 w-4" />{D.openDoc}</Link>
      </section>
    );
  } else {
    side = (
      <section className="card space-y-3 p-4 lg:sticky lg:top-4">
        <p className="font-semibold">{o.handledAt ? fill(D.rejectedAt, { d: formatDateTime(o.handledAt, intl) }) : D.states.rejected}</p>
        {o.rejectReason && <p className="whitespace-pre-line text-sm text-ink-soft" dir="auto">{o.rejectReason}</p>}
        <ReopenButton t={D} id={o.id} />
      </section>
    );
  }

  // Aktion: Preis vorher + Rabatt, so wie der Kunde ihn am Link gesehen hat
  const eff = (l: { unitPriceCents: number; promoBp: number }) => (l.promoBp ? discounted(l.unitPriceCents, l.promoBp) : l.unitPriceCents);
  const unit = (l: { unitPriceCents: number; promoBp: number }) => l.promoBp ? (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5" dir="ltr">
      <span className="rounded-full bg-accent-600 px-1.5 text-[0.6875rem] font-black text-white">-{Math.round(l.promoBp / 100)}%</span>
      <s className="text-xs text-ink-soft">{formatCents(l.unitPriceCents, intl)}</s><span className="text-accent-700">{formatCents(eff(l), intl)}</span>
    </span>
  ) : formatCents(l.unitPriceCents, intl);
  const row = (label: string, value: React.ReactNode) => (
    <div className="grid grid-cols-[8rem_1fr] gap-2 border-b border-black/5 py-2 text-sm last:border-0">
      <span className="text-ink-soft">{label}</span><span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>
    </div>
  );
  const address = [o.street, [o.zip, o.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");

  return (
    <div className="space-y-6">
      <PageHeader title={fill(D.listTitle, { n: o.number })} subtitle={`${fill(D.receivedAt, { d: formatDateTime(o.createdAt, intl) })} · ${D.prices}: ${groupName[o.group]}`}
        back="/direct" actions={stateBadge} />
      {sp.saved && sp.customer && o.state === "new" && <DoneNotice text={D.customerSaved} />}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-6">
          <section className="card animate-rise overflow-hidden">
            <h2 className="border-b border-black/5 px-4 py-3 text-lg font-bold">{D.itemsTitle}</h2>
            <div className="table-wrap hidden md:block"><table className="tbl tbl-fit">
              <thead><tr><th className="w-px" /><th>{t.product.title}</th><th className="text-end">{D.qty}</th><th className="text-end">{D.price}</th><th className="text-end">{D.sum}</th><th>{t.picker.inStock}</th></tr></thead>
              <tbody>{o.items.map((l) => (
                <tr key={l.id} data-item={l.manual ? "manual" : "catalog"}>
                  <td>{photo(l, 44)}</td>
                  <td className="text-start">
                    <span className="block font-semibold" dir="auto">{l.description}</span>
                    {l.barcode && <bdi dir="ltr" className="num text-xs text-ink-soft">{l.barcode}</bdi>}
                    {!l.variantId && !l.manual && <span className="block text-xs font-semibold text-amber-700">{D.gone}</span>}
                    {ownInfo(l)}
                  </td>
                  <td className="num text-end font-semibold">{l.qty}</td>
                  <td className="num text-end">{unitShown(l)}</td>
                  <td className="num text-end font-semibold">{l.manual && !l.unitPriceCents ? "—" : formatCents(l.qty * eff(l), intl)}</td>
                  <td>{l.manual ? <span className="text-xs text-ink-soft">{D.manualStock}</span> : l.available == null ? "—" : (
                    <span className={`num text-xs font-semibold ${l.available >= l.qty ? "text-emerald-700" : "text-red-700"}`}>{fill(D.nowAvailable, { n: l.available })}</span>
                  )}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="space-y-2 p-3 md:hidden">
              {o.items.map((l) => (
                <div key={l.id} className="flex gap-3 rounded-xl bg-slate-50 p-2.5 ring-1 ring-black/5" data-item={l.manual ? "manual" : "catalog"}>
                  {photo(l, l.manual ? 72 : 48)}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="text-sm font-semibold" dir="auto">{l.description}</div>
                    {!l.variantId && !l.manual && <div className="text-xs font-semibold text-amber-700">{D.gone}</div>}
                    {ownInfo(l)}
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="num">{l.qty} × {unitShown(l)}</span>
                      <b className="num">{l.manual && !l.unitPriceCents ? "—" : formatCents(l.qty * eff(l), intl)}</b>
                    </div>
                    {l.available != null && <div className={`num text-xs font-semibold ${l.available >= l.qty ? "text-emerald-700" : "text-red-700"}`}>{fill(D.nowAvailable, { n: l.available })}</div>}
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-1 border-t border-black/5 p-4 text-sm">
              <div className="flex justify-between gap-3"><span>{P.netTotal}</span><span className="num font-semibold">{formatCents(o.netCents, intl)}</span></div>
              <div className="flex justify-between gap-3 text-ink-soft"><span>{t.sales.vat}</span><span className="num">{formatCents(vat, intl)}</span></div>
              <div className="flex justify-between gap-3 font-bold"><span>{P.grossTotal}</span><span className="num">{formatCents(o.grossCents, intl)}</span></div>
              <p className="pt-2 text-xs text-ink-soft">{D.priceNote}</p>
              {manualCount > 0 && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 ring-1 ring-amber-200" data-manual-note>{D.manualNote}</p>}
            </div>
          </section>

          <section className="card animate-rise p-4">
            <h2 className="mb-2 text-lg font-bold">{D.sentBy}</h2>
            {row(P.name, <span dir="auto" className="font-semibold">{o.name}</span>)}
            {row(P.email, <a href={`mailto:${o.email}`} className="font-semibold text-brand-700 hover:underline" dir="ltr">{o.email}</a>)}
            {o.company && row(P.company, <span dir="auto">{o.company}</span>)}
            {o.phone && row(P.phone, <a href={`tel:${o.phone.replace(/[^\d+]/g, "")}`} className="text-brand-700 hover:underline" dir="ltr">{o.phone}</a>)}
            {address && row(P.street, <span dir="auto">{address}</span>)}
            {row(P.country, country)}
            {o.vatId && row(P.vatId, <bdi dir="ltr">{o.vatId}</bdi>)}
            {row(D.lang, LANGS[o.lang] ?? o.lang)}
            {o.note && row(D.note, <span className="whitespace-pre-line" dir="auto">{o.note}</span>)}
            <div className="mt-3 flex flex-wrap gap-2">
              {can(session, "mail.send") && <Link href={`/mail/compose?to=${encodeURIComponent(o.email)}`} className="btn-ghost group px-3 py-2 text-xs"><Icon name="mail" className="icon-pop h-4 w-4" />{D.writeMail}</Link>}
            </div>
          </section>
        </div>
        {side}
      </div>
    </div>
  );
}
