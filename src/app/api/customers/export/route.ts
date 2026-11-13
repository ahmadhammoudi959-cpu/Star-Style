import { db, schema } from "@/db";
import { apiDenied, getSession } from "@/lib/auth";
import { getI18n } from "@/i18n";
import { loadCustomerRows } from "@/lib/customer-list";
import { filterCustomerRows, nameIsEmail, readFilter } from "@/lib/customer-filter";
import { buildXlsx, XLSX_TYPE, type XlsxColumn } from "@/lib/xlsx";
import { todayIso } from "@/lib/dates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Kundenliste mit E-Mails als Excel (Wunsch Inhaber 13.11.2026: „عاوز ايميله يكون في عمود لحاله واقدر اعمل تصدير للايميلات
 * في اكسل شيت“): genau die Kunden, die /customers mit denselben Filtern zeigt; Spalten in der Sprache des Nutzers, Arabisch
 * von rechts. Eigenes Recht `customers.export` (Daten aller Kunden auf einmal), jedes Herunterladen steht im `audit_log`.
 */
export async function GET(req: Request) {
  const denied = await apiDenied("customers.export");
  if (denied) return denied;
  const session = await getSession();
  const url = new URL(req.url);
  const f = readFilter((k) => url.searchParams.get(k));
  const { t, locale } = await getI18n();
  const rows = filterCustomerRows(await loadCustomerRows(), f);
  const columns: XlsxColumn[] = [
    { header: t.customer.number, width: 9, kind: "int" },
    { header: t.customer.name, width: 30 },
    { header: t.customer.contact, width: 22 },
    { header: t.supplier.email, width: 34 },
    { header: t.supplier.phone, width: 18 },
    { header: t.customer.priceGroup, width: 16 },
    { header: t.setup.street, width: 28 },
    { header: t.setup.zip, width: 10 },
    { header: t.setup.city, width: 18 },
    { header: t.supplier.country, width: 8 },
    { header: t.customer.vatId, width: 16 },
    { header: t.customer.taxMode, width: 18 },
    { header: t.customer.src, width: 24 },
    { header: t.customer.shopAccount.title, width: 26 },
    { header: t.customer.since, width: 12, kind: "date" },
  ];
  const file = await buildXlsx({
    name: t.customer.title, rtl: locale === "ar", columns,
    rows: rows.map((r) => [
      r.number, nameIsEmail(r) ? "" : r.name, r.contact, r.email, r.phone, t.customer[r.group], r.street, r.zip, r.city, r.country,
      r.vatId, t.taxMode[r.mode], r.fromShop ? t.shop.names[r.fromShop] : t.customer.srcSystem, r.shops.map((s) => t.shop.names[s]).join(", "), r.createdDay,
    ]),
  });
  await db.insert(schema.auditLog).values({
    entity: "customer", entityId: "export", action: "export", userId: session?.uid ?? null,
    after: { count: rows.length, withEmail: rows.filter((r) => r.email).length, filter: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) },
  });
  const name = `StarStyle-Kunden-${todayIso()}.xlsx`;
  return new Response(new Uint8Array(file), {
    headers: { "Content-Type": XLSX_TYPE, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
  });
}
