import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";
import { db, schema } from "../src/db";
import { invoicePdf, offerPdf } from "../src/lib/pdf";

const run = process.env.DATABASE_URL ? describe : describe.skip;
const OUT = process.env.PDF_OUT;

run("PDF", () => {
  it("Rechnung mit eingebetteter E-Rechnung", async () => {
    const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.status, "ISSUED"), orderBy: desc(schema.invoices.createdAt) });
    expect(inv).toBeTruthy();
    const bytes = await invoicePdf(inv!.id);
    const doc = await PDFDocument.load(bytes);
    const names = doc.catalog.lookup(PDFName.of("Names"), PDFDict);
    expect(names.get(PDFName.of("EmbeddedFiles"))).toBeTruthy();
    expect(Buffer.from(bytes).includes(Buffer.from("factur-x.xml"))).toBe(true);
    if (OUT) fs.writeFileSync(`${OUT}/inv.pdf`, bytes);
  });
  it("Ladeliste, Storno, Angebot", async () => {
    const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.kind, "INVOICE") });
    const st = await db.query.invoices.findFirst({ where: eq(schema.invoices.kind, "CANCELLATION") });
    const of = await db.query.offers.findFirst();
    const del = await invoicePdf(inv!.id, "delivery");
    expect(del.length).toBeGreaterThan(1000);
    if (OUT) {
      fs.writeFileSync(`${OUT}/del.pdf`, del);
      if (st) fs.writeFileSync(`${OUT}/st.pdf`, await invoicePdf(st.id));
      if (of) fs.writeFileSync(`${OUT}/of.pdf`, await offerPdf(of.id));
    }
  });
});
