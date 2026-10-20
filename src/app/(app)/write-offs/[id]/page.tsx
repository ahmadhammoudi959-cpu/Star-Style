import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { variantLabel } from "@/lib/queries";
import { PrintButton } from "@/components/PrintButton";

/** Vernichtungs-/Verlustprotokoll – druckbar, für Steuerberater und Betriebsprüfung */
export default async function WriteOffDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t, intl } = await getI18n();
  const wo = await db.query.writeOffs.findFirst({
    where: eq(schema.writeOffs.id, id),
    with: { lines: { with: { variant: { with: { product: true } } } } },
  });
  if (!wo) notFound();
  const company = await db.query.companySettings.findFirst();
  const total = wo.lines.reduce((s, l) => s + l.qty * l.unitCostCents, 0);
  return (
    <div>
      <div className="print:hidden"><PageHeader title={`${t.writeOff.protocol} ${wo.number}`} back="/write-offs" actions={<PrintButton label="PDF / Drucken" />} /></div>
      <article className="card mx-auto max-w-3xl p-8 print:shadow-none print:ring-0" dir="ltr" lang="de">
        <header className="mb-6 flex justify-between gap-4 border-b pb-4">
          <div>
            <h1 className="text-xl font-bold">Verlust- und Vernichtungsprotokoll</h1>
            <p className="text-sm text-ink-soft">Nr. {wo.number} · {formatDate(wo.date)}</p>
          </div>
          <div className="text-end text-sm">
            <div className="font-semibold">{company?.name}</div>
            <div>{company?.street}</div><div>{company?.zip} {company?.city}</div>
            {company?.vatId && <div>USt-IdNr. {company.vatId}</div>}
          </div>
        </header>
        <p className="mb-4 text-sm"><b>Grund:</b> {(await import("@/i18n/de")).default.writeOff.reasons[wo.reason]}{wo.note && <> · {wo.note}</>}</p>
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>Artikel</th><th>Art.-Nr.</th><th className="!text-end">Menge</th><th className="!text-end">EK/Stück</th><th className="!text-end">Wert</th></tr></thead>
          <tbody>{wo.lines.map((l) => (
            <tr key={l.id}>
              <td>{variantLabel(l.variant.product.nameDe, l.variant.size, l.variant.color)}</td>
              <td className="num">{l.variant.product.sku}</td>
              <td className="num text-end">{l.qty}</td>
              <td className="num text-end">{formatCents(l.unitCostCents)}</td>
              <td className="num text-end">{formatCents(l.qty * l.unitCostCents)}</td>
            </tr>
          ))}</tbody>
          <tfoot><tr><td colSpan={4} className="px-3 py-3 text-end font-bold">Gesamtwert (Einkauf netto)</td><td className="num px-3 py-3 text-end font-bold">{formatCents(total)}</td></tr></tfoot>
        </table></div>
        {wo.photoFileId && (
          <div className="mt-6">
            <p className="mb-2 text-sm font-semibold">Fotonachweis</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/files/${wo.photoFileId}`} alt="Nachweis" className="max-h-80 rounded-xl ring-1 ring-black/10" />
          </div>
        )}
        <div className="mt-12 grid grid-cols-2 gap-10 text-sm">
          <div className="border-t pt-2">Ort, Datum</div>
          <div className="border-t pt-2">Unterschrift</div>
        </div>
        <p className="mt-6 text-xs text-ink-soft">Erstellt am {formatDate(wo.createdAt.toISOString(), intl)} – Bestand wurde automatisch ausgebucht.</p>
      </article>
    </div>
  );
}
