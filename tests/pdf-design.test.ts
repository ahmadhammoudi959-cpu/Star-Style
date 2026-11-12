import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { isNotNull } from "drizzle-orm";
import { db, schema } from "../src/db";
import { renderLetter, renderPdf, renderReport } from "../src/lib/pdf";

// Alle Belegarten im neuen Rahmen (Kopf-/Fußband, Wunsch Inhaber 12.11.2026) – braucht die Firmendaten aus der DB.
// Mit PDF_OUT=<Ordner> werden die Dateien zum Ansehen geschrieben (pdftoppm -png).
const run = process.env.DATABASE_URL ? describe : describe.skip;
const OUT = process.env.PDF_OUT;
const save = (name: string, b: Uint8Array) => { if (OUT) fs.writeFileSync(`${OUT}/${name}.pdf`, b); };
const pages = async (b: Uint8Array) => (await PDFDocument.load(b)).getPageCount();

const buyer = { name: "Salon Beispiel GmbH", street: "Musterstraße 1", zip: "44135", city: "Dortmund", country: "DE", vatId: "DE123456789" };
const line = (position: number, description: string, category: string, qty: number, unitPriceCents: number, ean: string, discountBp = 0) => {
  const raw = qty * unitPriceCents, netCents = raw - Math.round((raw * discountBp) / 10000);
  return { position, sku: ean, ean, category, description, qty, unitPriceCents, discountBp, netCents, vatRateBp: 1900, vatCents: Math.round(netCents * 0.19), weightGrams: 2500 };
};
const lines = [
  line(1, "Q-DESIGN ECLIPSE Greige – Barber-Bedienplatz mit LED-Spiegel und Schublade", "Barber- & Friseureinrichtung", 2, 36000, "4260123450011"),
  line(2, "Klassischer Barberplatz", "Barber- & Friseureinrichtung", 1, 46000, "4260123450028", 500),
  line(3, "DeltaPro Ablage für Barberstuhl – Schwarz", "Zubehör", 10, 2513, "8721399640906"),
  line(4, "Profi-Haarschneidemaschine mit Akku", "Maschinen", 3, 7990, "4012345678901"),
];
const sum = (k: "netCents" | "vatCents") => lines.reduce((s, l) => s + (l[k] ?? 0), 0);
const base = {
  number: "RE-2026-0009", date: "2026-11-10", deliveryDate: "2026-11-10", dueDate: "2026-11-24", validUntil: null,
  customerNo: 7, customerId: "c7", buyer, lines,
  subtotalCents: sum("netCents"), discountCents: 0, discountBp: 0, netCents: sum("netCents"), vatCents: sum("vatCents"), grossCents: sum("netCents") + sum("vatCents"),
  vatBreakdown: [{ rateBp: 1900, netCents: sum("netCents"), vatCents: sum("vatCents") }],
  taxMode: "DOMESTIC" as const, ossCountry: null, retentionOfTitle: true, notes: "", refNumber: null,
};

run("Belege im neuen Rahmen", () => {
  it("Rechnung mit Anzahlung → Zahlungsinformationen mit QR-Code", async () => {
    const b = await renderPdf({ ...base, kind: "invoice", received: [{ amountCents: 20000, method: "CASH" }] });
    expect(await pages(b)).toBeGreaterThan(0);
    save("design-rechnung", b);
  });
  it("Angebot, Storno, Ladeliste", async () => {
    // Angebot mit Produktfotos (aus der DB, wenn vorhanden)
    const photos = await db.query.products.findMany({ where: isNotNull(schema.products.imageFileId), limit: lines.length });
    const withPhotos = lines.map((l, i) => ({ ...l, imageFileId: photos[i]?.imageFileId ?? null }));
    save("design-angebot", await renderPdf({ ...base, kind: "offer", number: "AN-2026-0001", lines: withPhotos, dueDate: null, deliveryDate: null, validUntil: "2026-11-15", notes: "Ausführung und Farben gemäß Referenzabbildung. Lieferzeit nach Auftragsbestätigung." }));
    save("design-storno", await renderPdf({ ...base, kind: "cancellation", number: "ST-2026-0006", refNumber: "RE-2026-0009" }));
    save("design-ladeliste", await renderPdf({ ...base, kind: "delivery", number: "RE-2026-0009" }));
  });
  it("viele Positionen → Folgeseiten mit Kopf- und Fußband", async () => {
    const many = Array.from({ length: 26 }, (_, i) => ({ ...lines[i % 4], position: i + 1 }));
    const b = await renderPdf({ ...base, kind: "invoice", lines: many, received: [] });
    expect(await pages(b)).toBeGreaterThan(1);
    save("design-rechnung-lang", b);
  });
  it("Quittung, Mahnung, Monatsübersicht", async () => {
    save("design-quittung", await renderLetter({
      title: "Quittung QU-2026-0004", head: { label: "Quittung", number: "QU-2026-0004", date: "10.11.2026" }, buyer,
      info: [["Quittungsnr.", "QU-2026-0004"], ["Datum", "10.11.2026"], ["Zu Rechnung", "RE-2026-0009"], ["Kundennr.", "7"]],
      paragraphs: ["Wir bestätigen den Eingang von 200,00 € (bar) am 10.11.2026 für die Rechnung RE-2026-0009 vom 10.11.2026."],
      table: { head: ["", "Betrag"], widths: [120, 50], rows: [["Rechnungsbetrag", "1.940,40 €"], ["Bereits vorher bezahlt", "0,00 €"], ["Diese Zahlung", "200,00 €"]] },
      total: ["Noch offen", "1.740,40 €"], signature: true,
    }));
    save("design-mahnung", await renderLetter({
      title: "Zahlungserinnerung", head: { label: "Zahlungserinnerung", number: "RE-2026-0009", date: "01.12.2026" }, buyer,
      info: [["Datum", "01.12.2026"], ["Rechnungsnr.", "RE-2026-0009"], ["Kundennr.", "7"], ["Zahlbar bis", "08.12.2026"]],
      paragraphs: ["Sehr geehrte Damen und Herren,", "sicher haben Sie es im Tagesgeschäft übersehen: Für die folgende Rechnung konnten wir bis heute keinen vollständigen Zahlungseingang feststellen."],
      table: { head: ["Position", "Betrag"], widths: [120, 50], rows: [["Rechnung RE-2026-0009 vom 10.11.2026 – fälliger, unbezahlter Betrag", "1.740,40 €"]] },
      total: ["Zu zahlen", "1.740,40 €"],
    }));
    save("design-bericht", await renderReport({
      title: "Monatsübersicht 11/2026", subtitle: "Star-Style · Zeitraum 01.11.2026 – 30.11.2026",
      sections: [{ heading: "Ergebnis", head: ["", "Betrag"], widths: [120, 50], rows: [["Umsatz netto", "12.400,00 €"], ["Wareneinsatz", "-7.100,00 €"]], total: ["Rohertrag", "5.300,00 €"] }],
      notes: ["Alle Beträge netto."],
    }));
  });
});
