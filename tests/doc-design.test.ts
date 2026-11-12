import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  DEFAULT_DESIGN, contrast, designDiff, fillPlaceholders, hexToRgb, isDark, isDefaultDesign, parseDesign, PRESETS,
} from "../src/lib/doc-design";

// Belegdesign (Wunsch Inhaber 12.11.2026): Prüfen/Begrenzen rein, Belege mit eigenem Design aus der DB-Testumgebung
describe("Belegdesign (rein)", () => {
  it("leer oder kaputt → Standard (bisheriges Aussehen)", () => {
    expect(parseDesign({})).toEqual(DEFAULT_DESIGN);
    expect(parseDesign(null)).toEqual(DEFAULT_DESIGN);
    expect(parseDesign("x")).toEqual(DEFAULT_DESIGN);
    expect(parseDesign({ colors: "rot", show: [], texts: 5 })).toEqual(DEFAULT_DESIGN);
    expect(isDefaultDesign(parseDesign({}))).toBe(true);
  });
  it("begrenzt Werte und nimmt nur Bekanntes", () => {
    const d = parseDesign({
      colors: { primary: "#abcdef", accent: "blue", text: "#12345" }, header: "none", footer: "minimal", fontSize: 300, titleSize: "9",
      logoSize: "xl", show: { photos: false, unknown: true, pageNumbers: "nein" }, extra: 1,
    });
    expect(d.colors).toEqual({ ...DEFAULT_DESIGN.colors, primary: "#ABCDEF" });
    expect(d.header).toBe("band");
    expect(d.footer).toBe("band");
    expect(d.fontSize).toBe(125);
    expect(d.titleSize).toBe(14);
    expect(d.logoSize).toBe("m");
    expect(d.show.photos).toBe(false);
    expect(d.show.pageNumbers).toBe(true);
    expect("unknown" in d.show).toBe(false);
    expect("extra" in d).toBe(false);
    expect(parseDesign({ fontSize: 103 }).fontSize).toBe(105); // Schritte von 5 %
  });
  it("Texte: Pflichttitel nie leer, andere dürfen leer sein; Steuerzeichen weg, Absätze bleiben, Länge begrenzt", () => {
    const d = parseDesign({ texts: { invoice: { title: "  ", greeting: "", intro: "Zeile 1\r\nZeile 2\u0007", total: "" }, offer: { closing: "x".repeat(2000) } }, common: { notesTitle: "", thanks: "" } });
    expect(d.texts.invoice.title).toBe("Rechnung");
    expect(d.texts.invoice.total).toBe("Gesamtbetrag");
    expect(d.texts.invoice.greeting).toBe("");
    expect(d.texts.invoice.intro).toBe("Zeile 1\nZeile 2");
    expect(d.texts.offer.closing.length).toBe(600);
    expect(d.common.notesTitle).toBe("Hinweise");
    expect(d.common.thanks).toBe("");
    expect(d.texts.delivery.total).toBe("");
  });
  it("speichert nur Abweichungen", () => {
    const d = parseDesign({ header: "light", texts: { offer: { intro: "Hallo" } }, show: { paymentQr: false } });
    expect(designDiff(d)).toEqual({ header: "light", texts: { offer: { intro: "Hallo" } }, show: { paymentQr: false } });
    expect(parseDesign(designDiff(d))).toEqual(d);
  });
  it("Platzhalter und Farben", () => {
    expect(fillPlaceholders("Rechnung {number} vom {date} für {customer}, Storno zu {ref} {x}", { number: "RE-1", date: "12.11.2026", customer: "Salon", ref: "RE-0" }))
      .toBe("Rechnung RE-1 vom 12.11.2026 für Salon, Storno zu RE-0 {x}");
    expect(isDark(hexToRgb("#111A33"))).toBe(true);
    expect(isDark(hexToRgb("#F5C518"))).toBe(false);
    expect(contrast([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 0);
    for (const p of PRESETS) expect(parseDesign({ colors: p.colors }).colors).toEqual(p.colors);
  });
});

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
  line(2, "DeltaPro Ablage für Barberstuhl – Schwarz", "Zubehör", 10, 2513, "8721399640906"),
  line(3, "Profi-Haarschneidemaschine mit Akku", "Maschinen", 3, 7990, "4012345678901"),
];
const sum = (k: "netCents" | "vatCents", ls = lines) => ls.reduce((s, l) => s + (l[k] ?? 0), 0);
const base = {
  number: "RE-2026-0009", date: "2026-11-10", deliveryDate: "2026-11-10", dueDate: "2026-11-24", validUntil: null,
  customerNo: 7, customerId: "c7", buyer, lines,
  subtotalCents: sum("netCents"), discountCents: 0, discountBp: 0, netCents: sum("netCents"), vatCents: sum("vatCents"), grossCents: sum("netCents") + sum("vatCents"),
  vatBreakdown: [{ rateBp: 1900, netCents: sum("netCents"), vatCents: sum("vatCents") }],
  taxMode: "DOMESTIC" as const, ossCountry: null, retentionOfTitle: true, notes: "", refNumber: null,
};

run("Belege mit eigenem Design", () => {
  it("hell + groß + ohne Spalten/QR, eigene Texte mit Arabisch → gültige PDFs, Pflichtangaben bleiben", async () => {
    const { renderPdf, renderLetter } = await import("../src/lib/pdf");
    const design = parseDesign({
      colors: PRESETS.find((p) => p.key === "classic")!.colors, header: "light", footer: "light", stripe: false, logoSize: "l",
      fontSize: 120, titleSize: 26, tableHead: "line", totalBox: "line",
      show: { senderLine: false, posColumn: false, category: false, discountColumn: false, paymentQr: false, pageNumbers: false, website: false, bank: false },
      texts: { invoice: { title: "Faktura", to: "Kunde", greeting: "Hallo {customer},", intro: "شكراً لطلبكم – hier Ihre Rechnung {number}.", closing: "Lieferung frei Haus.\nGerne wieder!", signoff: "Viele Grüße" } },
      common: { headerNote: "Friseurbedarf · Großhandel · Datteln", footerNote: "Mo–Fr 9–18 Uhr", colItem: "Bezeichnung" },
    });
    const b = await renderPdf({ ...base, kind: "invoice", received: [] }, { design });
    expect(await pages(b)).toBeGreaterThan(0);
    save("custom-rechnung-hell", b);
    // Rabatt in einer Zeile → Rabatt-Spalte bleibt trotz „aus“ (Pflichtangabe Entgeltminderung)
    const withDisc = [{ ...lines[0], discountBp: 500, netCents: 68400, vatCents: 12996 }, ...lines.slice(1)];
    save("custom-rechnung-rabatt", await renderPdf({ ...base, kind: "invoice", lines: withDisc, received: [] }, { design }));
    save("custom-quittung-hell", await renderLetter({
      title: "Quittung QU-2026-0004", head: { label: "Quittung", number: "QU-2026-0004", date: "10.11.2026" }, buyer,
      info: [["Quittungsnr.", "QU-2026-0004"], ["Datum", "10.11.2026"]], paragraphs: ["Wir bestätigen den Eingang von 200,00 €."],
      table: { head: ["", "Betrag"], widths: [120, 50], rows: [["Diese Zahlung", "200,00 €"]] }, total: ["Noch offen", "1.740,40 €"],
    }, { design }));
  });
  it("Band in heller Hauptfarbe (dunkle Schrift), schlichter Kopf, kleines Logo", async () => {
    const { renderPdf } = await import("../src/lib/pdf");
    const yellow = parseDesign({ colors: { primary: "#F5C518", accent: "#B45309", accent2: "#111827", text: "#1F2937" }, logoSize: "s", fontSize: 90 });
    save("custom-angebot-gelb", await renderPdf({ ...base, kind: "offer", number: "AN-2026-0001", dueDate: null, deliveryDate: null, validUntil: "2026-11-24" }, { design: yellow }));
    const minimal = parseDesign({ header: "minimal", footer: "light", colors: PRESETS.find((p) => p.key === "wine")!.colors });
    save("custom-storno-schlicht", await renderPdf({ ...base, kind: "cancellation", number: "ST-2026-0006", refNumber: "RE-2026-0009" }, { design: minimal }));
    save("custom-ladeliste-schlicht", await renderPdf({ ...base, kind: "delivery" }, { design: minimal }));
  });
  it("Vorschau der Designer-Seite: Beispielbeleg je Art → PDF, erste Seite als PNG (pdf.js 6 + @napi-rs/canvas)", async () => {
    const { previewPdf, pdfToPng } = await import("../src/lib/doc-preview");
    const { PREVIEW_KINDS, DEFAULT_DESIGN } = await import("../src/lib/doc-design");
    for (const kind of PREVIEW_KINDS) {
      const pdf = await previewPdf(kind, DEFAULT_DESIGN);
      expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThanOrEqual(1);
      const png = await pdfToPng(pdf);
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(png.readUInt32BE(16)).toBe(Math.ceil(595.28 * 1.4)); // Breite A4 bei scale 1.4
      if (process.env.PDF_OUT) fs.writeFileSync(`${process.env.PDF_OUT}/vorschau-${kind}.png`, png);
    }
    // zwei gleichzeitig → nacheinander (Warteschlange), beide fertig
    const [a, b] = await Promise.all([previewPdf("offer", DEFAULT_DESIGN).then(pdfToPng), previewPdf("dunning", DEFAULT_DESIGN).then(pdfToPng)]);
    expect(a.length).toBeGreaterThan(1000);
    expect(b.length).toBeGreaterThan(1000);
  }, 120_000);
});
