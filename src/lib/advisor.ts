import "server-only";
/**
 * Monatsmappe für den Steuerberater:
 * DATEV-Buchungsstapel + Debitoren/Kreditoren, alle Ausgangsrechnungen (PDF), alle Belege der Ausgaben,
 * Zahlungs- und Ausgabenlisten (Excel-tauglich) und eine Monatsübersicht als PDF.
 */
import JSZip from "jszip";
import { and, between, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, schema } from "@/db";
import { accountMap, expenseAccount, moneyAccount, revenueAccount, type Chart, ACCOUNT_DEFS, type AccountKey } from "./accounts";
import { bookingCsv, contactCsv, type DatevBooking, type DatevContact, type DatevHeader } from "./datev";
import { monthRange } from "./periods";
import { archivedInvoicePdf, renderReport } from "./pdf";
import { monthReport } from "./reports";
import { formatCents } from "./money";
import { formatDate } from "./dates";

const CAT_DE: Record<string, string> = {
  GOODS: "Wareneinkauf", ADVERTISING: "Werbung / Anzeigen", MARKETING: "Marketing / Agentur", SHOP_FEES: "Shop- und Zahlungsgebühren", SHIPPING: "Versand",
  PACKAGING: "Verpackung", SOFTWARE: "Software", PHONE_INTERNET: "Telefon / Internet", RENT: "Miete", STORE_SUPPLIES: "Büro- und Ladenbedarf",
  VEHICLE: "Fahrzeug", INSURANCE: "Versicherung", BANK_FEES: "Bankgebühren", CONSULTING: "Beratung / Steuerberater", OTHER: "Sonstiges",
};
const TAXCASE_DE: Record<string, string> = {
  DOMESTIC: "Inland mit Vorsteuer", EU_SERVICE: "EU-Leistung § 13b", NON_EU_SERVICE: "Drittland-Leistung § 13b", EU_GOODS: "Innergem. Erwerb", NO_VAT: "Ohne USt",
};
const METHOD_DE: Record<string, string> = { CASH: "Bar", BANK: "Überweisung", CARD: "Karte", ONLINE: "Online" };
const CHANNEL_DE: Record<string, string> = { STORE: "Laden / Direktverkauf", BRAND_SHOP: "Marken-Shop", GENERAL_SHOP: "Allgemeiner Shop" };

export async function collectMonth(month: string) {
  const { from, to } = monthRange(month);
  const company = await db.query.companySettings.findFirst();
  const chart = (company?.chartOfAccounts ?? "SKR03") as Chart;
  const m = accountMap(chart, company?.accountOverrides ?? {});
  const warnings: string[] = [];
  if (!company?.datevConsultant || !company?.datevClient) warnings.push("missingDatevNumbers");

  const bookings: DatevBooking[] = [];
  const debitors = new Map<string, DatevContact>();
  const creditors = new Map<string, DatevContact>();

  // 1) Ausgangsrechnungen und Stornos
  const invoices = await db.query.invoices.findMany({
    where: and(isNotNull(schema.invoices.number), inArray(schema.invoices.status, ["ISSUED", "CANCELLED"]), between(schema.invoices.issueDate, from, to)),
    with: { customer: true },
    orderBy: (i, { asc }) => [asc(i.issueDate), asc(i.number)],
  });
  for (const inv of invoices) {
    const deb = m.debitorBase + inv.customer.number;
    debitors.set(inv.customerId, {
      account: deb, name: inv.custName, person: inv.customer.type === "PERSON", vatId: inv.custVatId,
      street: inv.custStreet, zip: inv.custZip, city: inv.custCity, country: inv.custCountry, email: inv.customer.email, phone: inv.customer.phone,
    });
    for (const g of inv.vatBreakdown) {
      const gross = g.netCents + g.vatCents;
      if (gross === 0) continue;
      const rev = revenueAccount(m, inv.taxMode, g.rateBp, inv.ossCountry);
      bookings.push({
        amountCents: Math.abs(gross), side: gross > 0 ? "S" : "H", account: deb, contra: rev, date: inv.issueDate!,
        ref1: inv.number!, text: `${inv.kind === "CANCELLATION" ? "Storno " : ""}${inv.custName}`,
        euVatId: inv.taxMode === "EU_REVERSE_CHARGE" ? inv.custVatId : inv.taxMode === "EU_B2C" && inv.ossCountry ? inv.ossCountry : undefined,
        euRateBp: inv.taxMode === "EU_B2C" && inv.ossCountry ? g.rateBp : undefined,
        serviceDate: inv.deliveryDate ?? inv.issueDate!,
      });
    }
  }

  // 2) Zahlungseingänge (und stornierte Zahlungen als Gegenbuchung am Stornotag)
  const payments = await db.query.payments.findMany({
    where: or(between(schema.payments.date, from, to), and(isNotNull(schema.payments.cancelledAt), gte(sql`(${schema.payments.cancelledAt} at time zone 'Europe/Berlin')::date`, from), lte(sql`(${schema.payments.cancelledAt} at time zone 'Europe/Berlin')::date`, to))),
    with: { invoice: { with: { customer: true } } },
    orderBy: (p, { asc }) => [asc(p.date), asc(p.number)],
  });
  for (const p of payments) {
    const inv = p.invoice;
    const deb = m.debitorBase + inv.customer.number;
    debitors.set(inv.customerId, debitors.get(inv.customerId) ?? {
      account: deb, name: inv.custName, person: inv.customer.type === "PERSON", vatId: inv.custVatId,
      street: inv.custStreet, zip: inv.custZip, city: inv.custCity, country: inv.custCountry, email: inv.customer.email, phone: inv.customer.phone,
    });
    const acc = moneyAccount(m, p.method);
    if (p.date >= from && p.date <= to)
      bookings.push({ amountCents: p.amountCents, side: "S", account: acc, contra: deb, date: p.date, ref1: inv.number ?? "", ref2: p.number, text: `Zahlung ${inv.custName}` });
    const cd = p.cancelledAt ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(p.cancelledAt) : null;
    if (cd && cd >= from && cd <= to)
      bookings.push({ amountCents: p.amountCents, side: "H", account: acc, contra: deb, date: cd, ref1: inv.number ?? "", ref2: p.number, text: `Storno Zahlung ${inv.custName}` });
  }

  // 3) Ausgaben (Rechnung an Kreditor, Zahlung Kreditor an Geldkonto)
  const expenses = await db.query.expenses.findMany({
    where: or(between(schema.expenses.date, from, to), and(eq(schema.expenses.paid, true), between(schema.expenses.paidAt, from, to))),
    with: { supplier: true },
    orderBy: (e, { asc }) => [asc(e.date)],
  });
  for (const e of expenses) {
    if (!e.supplier) { warnings.push(`expenseWithoutSupplier:${e.id}`); continue; }
    const kred = m.creditorBase + e.supplier.number;
    creditors.set(e.supplier.id, {
      account: kred, name: e.supplier.name, vatId: e.supplier.vatId, street: e.supplier.street, zip: e.supplier.zip,
      city: e.supplier.city, country: e.supplier.country, email: e.supplier.email, phone: e.supplier.phone,
    });
    if (e.date >= from && e.date <= to) {
      const { account, bu } = expenseAccount(m, e.category, e.taxCase, e.vatRateBp);
      bookings.push({
        amountCents: e.grossCents, side: "S", account, contra: kred, bu, date: e.date, ref1: e.invoiceNo, text: `${e.vendorName} ${CAT_DE[e.category] ?? ""}`,
        euVatId: e.taxCase === "EU_SERVICE" || e.taxCase === "EU_GOODS" ? e.supplier.vatId || undefined : undefined,
      });
    }
    if (e.paid && e.paidAt && e.paidAt >= from && e.paidAt <= to)
      bookings.push({ amountCents: e.grossCents, side: "S", account: kred, contra: moneyAccount(m, e.paymentMethod), date: e.paidAt, ref1: e.invoiceNo, text: `Zahlung ${e.vendorName}` });
  }

  bookings.sort((a, b) => a.date.localeCompare(b.date));
  return { month, from, to, company, chart, accounts: m, bookings, debitors: [...debitors.values()], creditors: [...creditors.values()], invoices, payments, expenses, warnings };
}

function fiscalYearStart(month: string, startMonth: number) {
  const [y, mo] = month.split("-").map(Number);
  const year = mo >= startMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, "0")}-01`;
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: (string | number)[][]) => "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n") + "\r\n";
const eur = (c: number) => (c / 100).toFixed(2).replace(".", ",");
const safeName = (s: string) => s.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 60);

export async function buildMonthPackage(month: string, exportedBy: string) {
  const d = await collectMonth(month);
  const c = d.company;
  const header: DatevHeader = {
    consultant: c?.datevConsultant ?? 1001, client: c?.datevClient ?? 1, fiscalYearStart: fiscalYearStart(month, c?.fiscalYearStartMonth ?? 1),
    from: d.from, to: d.to, label: `Star Style ${month}`, createdAt: new Date(), exportedBy,
  };
  const zip = new JSZip();
  const root = zip.folder(`Steuerberater_${month}`)!;
  root.file(`DATEV/EXTF_Buchungsstapel_${month}.csv`, bookingCsv(header, d.bookings));
  root.file(`DATEV/EXTF_Debitoren_Kreditoren_${month}.csv`, contactCsv(header, [...d.debitors, ...d.creditors].sort((a, b) => a.account - b.account)));

  for (const inv of d.invoices) root.file(`Ausgangsrechnungen/${inv.number}.pdf`, await archivedInvoicePdf(inv.id));

  const fileIds = d.expenses.filter((e) => e.fileId && e.date >= d.from && e.date <= d.to).map((e) => e.fileId!);
  const files = fileIds.length ? await db.query.storedFiles.findMany({ where: inArray(schema.storedFiles.id, fileIds) }) : [];
  for (const e of d.expenses) {
    const f = files.find((x) => x.id === e.fileId);
    if (!f) continue;
    const ext = f.mime === "application/pdf" ? "pdf" : f.mime.split("/")[1] ?? "bin";
    root.file(`Eingangsrechnungen/${e.date}_${safeName(e.vendorName)}${e.invoiceNo ? "_" + safeName(e.invoiceNo) : ""}.${ext}`, f.data);
  }

  root.file(`Zahlungseingaenge_${month}.csv`, csv([
    ["Datum", "Quittung", "Rechnung", "Kunde", "Zahlungsart", "Betrag EUR", "Storniert am", "Grund"],
    ...d.payments.map((p) => [formatDate(p.date), p.number, p.invoice.number ?? "", p.invoice.custName, METHOD_DE[p.method], eur(p.amountCents),
      p.cancelledAt ? formatDate(p.cancelledAt.toISOString()) : "", p.cancelReason]),
  ]));
  const monthExpenses = d.expenses.filter((e) => e.date >= d.from && e.date <= d.to);
  root.file(`Ausgaben_${month}.csv`, csv([
    ["Datum", "Lieferant", "Land", "USt-IdNr.", "Rechnungsnr.", "Kategorie", "Steuerfall", "Netto EUR", "Vorsteuer EUR", "Brutto EUR", "Bezahlt am", "Zahlungsart", "Beleg"],
    ...monthExpenses.map((e) => [formatDate(e.date), e.vendorName, e.vendorCountry, e.supplier?.vatId ?? "", e.invoiceNo, CAT_DE[e.category], TAXCASE_DE[e.taxCase],
      eur(e.netCents), eur(e.vatCents), eur(e.grossCents), e.paidAt ? formatDate(e.paidAt) : "offen", e.paymentMethod ? METHOD_DE[e.paymentMethod] : "", e.fileId ? "ja" : "fehlt"]),
  ]));

  const rep = await monthReport(month);
  root.file(`Monatsuebersicht_${month}.pdf`, await summaryPdf(month, rep, d));
  root.file("LIESMICH.txt", readme(month, d));

  const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return { data, bookings: d.bookings.length, warnings: d.warnings, missingReceipts: monthExpenses.filter((e) => !e.fileId).length };
}

/** Mappe erzeugen und archivieren (jede Version bleibt nachvollziehbar). */
export async function createAndStorePackage(month: string, exportedBy: string, userId?: string) {
  const pkg = await buildMonthPackage(month, exportedBy);
  const name = `Steuerberater_${month}.zip`;
  const [file] = await db.insert(schema.storedFiles).values({
    name, mime: "application/zip", size: pkg.data.length, sha256: createHash("sha256").update(pkg.data).digest("hex"), data: pkg.data,
  }).returning({ id: schema.storedFiles.id });
  const [exp] = await db.insert(schema.advisorExports).values({ month, fileId: file.id, bookings: pkg.bookings, userId }).returning();
  return { ...pkg, exportId: exp.id, fileId: file.id, name };
}

function readme(month: string, d: Awaited<ReturnType<typeof collectMonth>>) {
  const used = new Set<number>(d.bookings.flatMap((b) => [b.account, b.contra]));
  const seen = new Set<number>();
  const lines = (Object.keys(ACCOUNT_DEFS) as AccountKey[])
    .filter((k) => used.has(d.accounts[k]) && !k.endsWith("Base") && !seen.has(d.accounts[k]) && seen.add(d.accounts[k]))
    .map((k) => `  ${d.accounts[k]}  ${ACCOUNT_DEFS[k].label}`);
  return [
    `Monatsmappe ${month} – ${d.company?.name ?? ""}`,
    "",
    "Inhalt:",
    "  DATEV/EXTF_Buchungsstapel_*.csv      Buchungen (Ausgangsrechnungen, Zahlungseingänge, Ausgaben, Zahlungsausgänge)",
    "  DATEV/EXTF_Debitoren_Kreditoren_*.csv Stammdaten der verwendeten Kunden und Lieferanten",
    "  Ausgangsrechnungen/                  alle Rechnungen und Stornorechnungen des Monats (PDF mit eingebetteter E-Rechnung)",
    "  Eingangsrechnungen/                  Belege der Ausgaben",
    "  Zahlungseingaenge_*.csv, Ausgaben_*.csv  Listen zum Öffnen in Excel",
    "  Monatsuebersicht_*.pdf               Umsatz, Kosten, Umsatzsteuer-Überblick",
    "",
    `Kontenrahmen: ${d.chart}. Personenkonten: Debitoren ab ${d.accounts.debitorBase} + Kundennummer, Kreditoren ab ${d.accounts.creditorBase} + Lieferantennummer.`,
    "Steuerschlüssel: 9 = 19 % VSt, 8 = 7 % VSt, 94 = § 13b 19 %, 91 = § 13b 7 %, 19/18 = innergem. Erwerb. Automatikkonten ohne Schlüssel.",
    "Buchungen sind nicht festgeschrieben (Festschreibung 0), damit Sie Korrekturen vornehmen können.",
    "",
    "Verwendete Sachkonten:",
    ...lines,
    "",
    "Alle Konten können im Programm unter Einstellungen → Konten für DATEV geändert werden.",
    ...(d.warnings.includes("missingDatevNumbers") ? ["", "ACHTUNG: Berater- und Mandantennummer fehlen noch (Platzhalter 1001 / 1). Bitte in den Einstellungen eintragen und neu erzeugen."] : []),
  ].join("\r\n");
}

async function summaryPdf(month: string, r: Awaited<ReturnType<typeof monthReport>>, d: Awaited<ReturnType<typeof collectMonth>>) {
  const [y, mo] = month.split("-");
  const pct = (bp: number) => `${(bp / 100).toFixed(1).replace(".", ",")} %`;
  return renderReport({
    title: `Monatsübersicht ${mo}/${y}`,
    subtitle: `${d.company?.name ?? ""} · Zeitraum ${formatDate(r.from)} – ${formatDate(r.to)}`,
    sections: [
      {
        heading: "Ergebnis",
        head: ["", "Betrag"], widths: [120, 50],
        rows: [
          ["Umsatz netto", formatCents(r.totals.revenueNet)],
          ["Wareneinsatz (Einkaufspreis der verkauften Ware)", formatCents(-r.totals.cogs)],
          [`Rohertrag (${pct(r.totals.marginBp)})`, formatCents(r.totals.grossProfit)],
          ["Kosten (ohne Wareneinkauf)", formatCents(-r.totals.expenses)],
          ["Verluste / Bruch / Ablauf", formatCents(-r.totals.losses)],
        ],
        total: ["Ergebnis vor Steuern", formatCents(r.totals.profit)],
        note: `Wareneinkauf im Monat (zur Info, nicht im Ergebnis): ${formatCents(r.totals.goodsPurchases)}`,
      },
      {
        heading: "Verkaufskanäle",
        head: ["Kanal", "Umsatz netto", "Wareneinsatz", "Rohertrag", "Direkte Kosten", "Deckungsbeitrag"], widths: [50, 24, 24, 24, 24, 24],
        rows: r.channels.map((c) => [CHANNEL_DE[c.channel], formatCents(c.revenueNet), formatCents(c.cogs), formatCents(c.grossProfit), formatCents(c.direct), formatCents(c.contribution)]),
      },
      {
        heading: "Kosten nach Kategorie",
        head: ["Kategorie", "Anzahl", "Netto", "Vorsteuer"], widths: [80, 25, 32, 33],
        rows: r.expensesByCategory.map((e) => [CAT_DE[e.category], String(e.count), formatCents(e.net), formatCents(e.vat)]),
      },
      {
        heading: "Umsatzsteuer (Überblick, keine Voranmeldung)",
        head: ["", "Bemessung", "Steuer"], widths: [100, 35, 35],
        rows: [
          ...r.vat.output.map((v) => [`Umsätze ${(v.rateBp / 100).toFixed(0)} %`, formatCents(v.net), formatCents(v.vat)]),
          ["Steuerfreie innergem. Lieferungen", formatCents(r.vat.taxFreeEu), "–"],
          ["Steuerfreie Ausfuhren", formatCents(r.vat.taxFreeExport), "–"],
          ...r.vat.oss.map((o) => [`OSS ${o.country} (über BZSt)`, formatCents(o.net), formatCents(o.vat)]),
          ["Vorsteuer aus Ausgaben", "", formatCents(-r.vat.inputVat)],
          ["§ 13b / Erwerb: USt und Vorsteuer (heben sich auf)", "", formatCents(r.vat.selfAssessed)],
        ],
        total: ["Voraussichtliche Zahllast", formatCents(r.vat.payable)],
      },
      {
        heading: "Zahlungseingänge",
        head: ["Zahlungsart", "Eingang", "Storniert"], widths: [100, 35, 35],
        rows: r.payments.map((p) => [METHOD_DE[p.method] ?? p.method, formatCents(p.received), formatCents(p.reversed)]),
      },
    ],
    notes: [
      `DATEV-Buchungen: ${d.bookings.length} · Ausgangsrechnungen: ${d.invoices.length} · Ausgaben: ${d.expenses.filter((e) => e.date >= d.from && e.date <= d.to).length}`,
      "Diese Übersicht ist eine betriebswirtschaftliche Auswertung aus dem Warenwirtschaftssystem und ersetzt nicht die Buchhaltung des Steuerberaters.",
    ],
  });
}

