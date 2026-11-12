import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import de from "../src/i18n/de";
import ar from "../src/i18n/ar";
import en from "../src/i18n/en";
import ku from "../src/i18n/ku";
import { desc } from "drizzle-orm";
import { db, schema } from "../src/db";
import { goodsReceiptPdf, renderGoodsReceipt, type GoodsReceiptDoc } from "../src/lib/goods-receipt-pdf";

const OUT = process.env.PDF_OUT;
const company = { name: "Star-Style", street: "Provinzialstr. 45", zip: "45711", city: "Datteln", email: "info@example.com", phone: "", website: "star-style.example", logoFileId: null };
const sample: GoodsReceiptDoc = {
  number: "WE-2026-0007", date: "2026-11-05", supplierInvoiceNo: "56548", note: "",
  supplier: { name: "Sh – Qualitäts-Design GmbH", street: "Musterweg 12", zip: "10115", city: "Berlin", country: "DE" },
  lines: [
    { name: "DeltaPro Ablage für Barberstuhl", variant: "Schwarz", code: "8721399640906", qty: 50, costCents: 20000, batchNo: "6", expiry: "2026-11-06", weightGrams: 1500 },
    { name: "شامبو احترافي للصالونات", variant: "500 ml", code: "4012345678901", qty: 24, costCents: 389, batchNo: "L-2411", expiry: "2028-03-31", weightGrams: 540 },
    { name: "Haarschneidemaschine Pro mit langem Namen, Akku und Ladestation für den Salon", variant: "", code: "HSM-PRO", qty: 3, costCents: 7990, batchNo: "", expiry: null, weightGrams: null },
  ],
};

describe("Wareneingang als PDF (Design wie die Rechnung)", () => {
  for (const [lang, t] of [["de", de], ["ar", ar], ["en", en], ["ku", ku]] as const) {
    it(`${lang}: eine Seite, lädt sauber`, async () => {
      const bytes = await renderGoodsReceipt(sample, { t, lang, company });
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(1);
      expect(doc.getTitle()).toBe(`${t.receive.title} WE-2026-0007`);
      if (OUT) fs.writeFileSync(`${OUT}/we-${lang}.pdf`, bytes);
    });
  }
  it("viele Positionen → mehrere Seiten (Tabellenkopf wiederholt), Anfangsbestand als Hinweis", async () => {
    const many: GoodsReceiptDoc = { ...sample, supplier: null, note: "Anfangsbestand beim Anlegen", lines: Array.from({ length: 45 }, (_, i) => ({ ...sample.lines[i % 3], qty: i + 1 })) };
    for (const [lang, t] of [["de", de], ["ar", ar]] as const) {
      const bytes = await renderGoodsReceipt(many, { t, lang, company });
      expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
      if (OUT) fs.writeFileSync(`${OUT}/we-long-${lang}.pdf`, bytes);
    }
  });
  (process.env.DATABASE_URL ? it : it.skip)("aus der Datenbank: letzter Wareneingang (Arabisch), unbekannte ID → null", async () => {
    const last = await db.query.goodsReceipts.findFirst({ orderBy: desc(schema.goodsReceipts.createdAt) });
    expect(last).toBeTruthy();
    const out = await goodsReceiptPdf(last!.id, ar, "ar");
    expect(out?.number).toBe(last!.number);
    expect((await PDFDocument.load(out!.bytes)).getPageCount()).toBeGreaterThan(0);
    if (OUT) fs.writeFileSync(`${OUT}/we-db-ar.pdf`, out!.bytes);
    expect(await goodsReceiptPdf("gibt-es-nicht", de, "de")).toBeNull();
  });
});
